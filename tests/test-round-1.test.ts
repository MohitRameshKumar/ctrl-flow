// Manual-testing round 1: redirect collapsing, visit-only sites, app names, K feedback, notification
// throttling, typing in iframes (Focus Flip detection), the Spaces co-usage filter, the outbound history.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toRow } from '@/lib/cloud-sync';
import { eventToAction, nameMacro } from '@/lib/macro-detection';
import { lastSegment, nameOpenMacro, previewText, planRepeat, refineSegment } from '@/lib/macro-repeat';
import { candidateFromSession } from '@/lib/macro-detection';
import { detectPairsFromEvents } from '@/lib/flip-detect';
import { createIdleTracker, LEARN_PING_MS, type IdleMessage } from '@/lib/flip-idle';
import { keepFeedback } from '@/lib/keep-feedback';
import { NOTIFY_THROTTLE_MS, DEFAULT_NOTIFY_SETTINGS, mayNotify, notifySettingsFrom } from '@/lib/notify';
import { OUTBOUND_HISTORY_MAX, pushEntry, summarize, type OutboundEntry } from '@/lib/outbound-history';
import { ttsText, TTS_LOG_TEXT_CHARS } from '@/lib/outbound-log';
import {
  DEFAULT_BLOCKLIST,
  decideExclusion,
  exclusionMode,
  isBlocklisted,
  isUrlBlockedForMacros,
  migrateEmailToVisitOnly,
} from '@/lib/privacy';
import { canonicalUrl, isTransientUrl, knownAppName, rootUrlOf } from '@/lib/sites';
import { RECENT_CO_USAGE_MS, computePairStats, topByRecentUse, urlsWithCoUsage } from '@/lib/co-usage';
import { isExcludedUrl, recordingStateFor } from '@/lib/badge';
import type { BlocklistConfig, CadenceEvent, ObservedAction } from '@/lib/types';

const NOW = 50_000_000;
const GMAIL = 'https://mail.google.com/';
const CLASSROOM = 'https://classroom.google.com/u/0/h';
const CLASSROOM_PLAIN = 'https://classroom.google.com/h';
const NOTION = 'https://www.notion.so/workspace';

let seq = 0;
function ev(ago: number, kind: CadenceEvent['kind'], tabId: number, url: string, extra: Partial<CadenceEvent> = {}): CadenceEvent {
  return { id: ++seq, ts: NOW - ago, kind, tabId, url, domain: new URL(url).hostname, ...extra };
}
const actionsOf = (events: CadenceEvent[]): ObservedAction[] => events.flatMap((e) => { const a = eventToAction(e); return a ? [a] : []; });
const openUrls = (seg: ReturnType<typeof lastSegment>) => seg?.candidate.steps.filter((s) => s.kind === 'open_url').map((s) => s.url);

describe('1. Google redirect collapsing', () => {
  it('canonicalUrl folds the account index and home aliases', () => {
    expect(canonicalUrl(CLASSROOM)).toBe(canonicalUrl(CLASSROOM_PLAIN));
    expect(canonicalUrl('https://classroom.google.com/')).toBe(canonicalUrl(CLASSROOM));
    expect(canonicalUrl('https://mail.google.com/mail/u/0/')).toBe('https://mail.google.com/');
    expect(canonicalUrl('https://classroom.google.com/c/abc123')).not.toBe(canonicalUrl(CLASSROOM));
  });

  it('Gmail -> Classroom (opened in a new tab, redirected via accounts, ending on /u/0/h) -> Notion is three steps', () => {
    // The Classroom tab fires tab_opened (classroom/), the sign-in hop (accounts.google.com, never recorded),
    // then `navigated` 7 s later on /u/0/h: the old 4-second same-tab chain left that as two Classroom steps.
    const events = [
      ev(40_000, 'tab_opened', 1, GMAIL),
      ev(30_000, 'tab_opened', 2, 'https://classroom.google.com/'),
      ev(23_000, 'navigated', 2, CLASSROOM),
      ev(22_500, 'tab_activated', 2, CLASSROOM),
      ev(15_000, 'tab_opened', 3, NOTION),
      ev(14_000, 'navigated', 3, NOTION),
    ];
    const seg = lastSegment(actionsOf(events), NOW - 60_000, NOW);
    expect(openUrls(seg)).toEqual([GMAIL, CLASSROOM, NOTION]);
  });

  it('collapses the same page across tabs within a minute, but keeps a genuine second visit later', () => {
    const a = (ts: number, tab: number, url: string): ObservedAction => ({ ts, kind: 'open_url', target: url, contextId: tab, deliberate: true });
    const out = refineSegment([a(0, 1, CLASSROOM_PLAIN), a(9_000, 2, CLASSROOM), a(20_000, 3, NOTION)]);
    expect(out.filter((x) => x.kind === 'open_url').map((x) => x.target)).toEqual([CLASSROOM, NOTION]);
    const later = refineSegment([a(0, 1, CLASSROOM_PLAIN), a(120_000, 2, CLASSROOM)]);
    expect(later).toHaveLength(2);
  });

  it('names the macro and the preview by app: "Open Gmail, Classroom, Notion", 3 steps', () => {
    const events = [
      ev(40_000, 'tab_opened', 1, GMAIL),
      ev(30_000, 'tab_opened', 2, 'https://classroom.google.com/'),
      ev(23_000, 'navigated', 2, CLASSROOM),
      ev(15_000, 'tab_opened', 3, NOTION),
    ];
    const seg = lastSegment(actionsOf(events), NOW - 60_000, NOW)!;
    expect(nameOpenMacro(openUrls(seg)!)).toBe('Open Gmail, Classroom, Notion');
    expect(previewText(planRepeat(seg, [])).text).toContain('Repeat 3 steps: Open Gmail → Open Classroom → Open Notion');
  });
});

describe('2. visit-only sites', () => {
  it('email defaults to visit only; banking and password managers stay never', () => {
    expect(exclusionMode('mail.google.com', DEFAULT_BLOCKLIST)).toBe('visit-only');
    expect(exclusionMode('outlook.office.com', DEFAULT_BLOCKLIST)).toBe('visit-only');
    expect(exclusionMode('chase.com', DEFAULT_BLOCKLIST)).toBe('never');
    expect(exclusionMode('vault.bitwarden.com', DEFAULT_BLOCKLIST)).toBe('never');
    expect(exclusionMode('mychart.hospital.org', DEFAULT_BLOCKLIST)).toBe('never');
    expect(exclusionMode('github.com', DEFAULT_BLOCKLIST)).toBeNull();
    expect(isBlocklisted('mail.google.com', DEFAULT_BLOCKLIST)).toBe(true); // still excluded for every other consumer
  });

  it('visit-only records a page visit as the bare root, and nothing else', () => {
    for (const kind of ['tab_opened', 'tab_activated', 'navigated'] as const) {
      expect(decideExclusion(kind, 'mail.google.com', DEFAULT_BLOCKLIST)).toEqual({ action: 'root', url: GMAIL });
    }
    for (const kind of ['click', 'field_changed', 'copy', 'typing_burst', 'download', 'tab_closed', 'chrome_focus_gained'] as const) {
      expect(decideExclusion(kind, 'mail.google.com', DEFAULT_BLOCKLIST).action).toBe('drop');
    }
    // in-page navigation is the path changing: exactly what must not be kept
    expect(decideExclusion('navigated', 'mail.google.com', DEFAULT_BLOCKLIST, { spa: true }).action).toBe('drop');
    expect(decideExclusion('click', 'chase.com', DEFAULT_BLOCKLIST).action).toBe('drop');
    expect(decideExclusion('navigated', 'chase.com', DEFAULT_BLOCKLIST).action).toBe('drop');
    expect(decideExclusion('click', 'github.com', DEFAULT_BLOCKLIST).action).toBe('record');
  });

  it('never wins when a site is in both lists', () => {
    const both: BlocklistConfig = { domains: ['mail.google.com'], substrings: [], visitOnly: ['mail.google.com'] };
    expect(exclusionMode('mail.google.com', both)).toBe('never');
  });

  it('macros may open a visit-only site at its root, never a page inside it', () => {
    expect(isUrlBlockedForMacros(GMAIL, DEFAULT_BLOCKLIST)).toBe(false);
    expect(isUrlBlockedForMacros('https://mail.google.com/mail/u/0/#inbox/abc', DEFAULT_BLOCKLIST)).toBe(true);
    expect(isUrlBlockedForMacros('https://chase.com/', DEFAULT_BLOCKLIST)).toBe(true);
    expect(isUrlBlockedForMacros('https://github.com/x', DEFAULT_BLOCKLIST)).toBe(false);
  });

  it('a visit-only root becomes a macro step (Gmail is not skipped)', () => {
    const e = ev(1000, 'tab_opened', 1, GMAIL, { title: undefined });
    expect(eventToAction(e)?.target).toBe(GMAIL);
  });

  it('migrates old blocklists: email moves from never to visit-only, user entries stay', () => {
    const old: BlocklistConfig = { domains: ['chase.com', 'mail.google.com', 'outlook.live.com', 'mybank.example'], substrings: ['mychart'] };
    const next = migrateEmailToVisitOnly(old);
    expect(next.domains).toEqual(['chase.com', 'mybank.example']);
    expect(next.visitOnly).toEqual(expect.arrayContaining(['mail.google.com', 'outlook.live.com']));
  });

  it('Tiger Data: visit-only rows carry the bare domain and no title; never-record rows are not sent at all', () => {
    const base: CadenceEvent = { id: 7, ts: NOW, kind: 'tab_activated', domain: 'mail.google.com', url: GMAIL, title: 'Inbox (3) - me@x.com' };
    expect(toRow(base, DEFAULT_BLOCKLIST)).toEqual({ localId: 7, ts: NOW, kind: 'tab_activated', domain: 'mail.google.com', title: '' });
    expect(toRow({ ...base, domain: 'chase.com', title: 'Accounts' }, DEFAULT_BLOCKLIST)).toBeNull();
    expect(toRow({ ...base, domain: 'github.com', title: 'Repo' }, DEFAULT_BLOCKLIST)?.title).toBe('Repo');
    const keys = Object.keys(toRow(base, DEFAULT_BLOCKLIST)!).sort();
    expect(keys).toEqual(['domain', 'kind', 'localId', 'title', 'ts']); // no url, selector, label, field
  });

  it('rootUrlOf', () => {
    expect(rootUrlOf('mail.google.com')).toBe(GMAIL);
    expect(rootUrlOf('https://outlook.office.com/mail/inbox')).toBe('https://outlook.office.com/');
  });
});

describe('3. app names', () => {
  it('maps multi-product domains to the app', () => {
    expect(knownAppName('https://mail.google.com/mail/u/0/')).toBe('Gmail');
    expect(knownAppName('https://classroom.google.com/u/0/h')).toBe('Classroom');
    expect(knownAppName('https://docs.google.com/document/d/1/edit')).toBe('Google Docs');
    expect(knownAppName('https://docs.google.com/spreadsheets/d/1/edit')).toBe('Google Sheets');
    expect(knownAppName('https://docs.google.com/presentation/d/1/edit')).toBe('Google Slides');
    expect(knownAppName('https://drive.google.com/drive/my-drive')).toBe('Drive');
    expect(knownAppName('https://calendar.google.com/calendar/u/0/r')).toBe('Calendar');
    expect(knownAppName('https://meet.google.com/abc-defg')).toBe('Meet');
    expect(knownAppName('https://outlook.office.com/mail/')).toBe('Outlook');
    expect(knownAppName('https://teams.microsoft.com/v2/')).toBe('Teams');
    expect(knownAppName('https://contoso.sharepoint.com/sites/x')).toBe('SharePoint');
    expect(knownAppName('https://github.com/x')).toBeNull();
  });

  it('a macro over Google apps is named by app, not "Google routine"', () => {
    const step = (url: string) => ({ key: url, kind: 'open_url' as const, url, enabled: true, support: 1 });
    const name = nameMacro(
      { steps: [step(GMAIL), step('https://classroom.google.com/'), step(NOTION)], detector: 'sequence', occurrences: 3, typicalHour: null },
      0,
    );
    expect(name).toBe('Gmail + Classroom');
    expect(nameMacro({ steps: [step('https://docs.google.com/document/d/1'), step('https://docs.google.com/spreadsheets/d/2')], detector: 'sequence', occurrences: 3, typicalHour: null }, 0)).toBe('Google Docs + Google Sheets');
  });

  it('Google results pages and sign-in hops are transient: never a macro step', () => {
    expect(isTransientUrl('https://www.google.com/search?q=cats')).toBe(true);
    expect(isTransientUrl('https://www.google.co.uk/search?q=cats')).toBe(true);
    expect(isTransientUrl('https://accounts.google.com/signin')).toBe(true);
    expect(isTransientUrl('https://docs.google.com/document/d/1')).toBe(false);
    expect(eventToAction(ev(0, 'navigated', 1, 'https://www.google.com/search'))).toBeNull();
    // Find PDF's detector reads the stored flag, which the event keeps
    const e = ev(0, 'navigated', 1, 'https://www.google.com/search', { pdfSearch: true });
    expect(e.pdfSearch).toBe(true);
    expect(candidateFromSession([])).toBeNull();
  });
});

describe('4. K always answers', () => {
  it('saved: names the macro and offers a letter with an Assign button', () => {
    const fb = keepFeedback({ id: 4, name: 'Open Gmail, Classroom, Notion' }, 'g');
    expect(fb.kind).toBe('saved');
    expect(fb.title).toBe('Saved "Open Gmail, Classroom, Notion"');
    expect(fb.message).toBe('Assign letter G?');
    expect(fb.assign).toEqual({ macroId: 4, letter: 'g' });
  });
  it('saved with no free letter still says where to find it', () => {
    const fb = keepFeedback({ id: 4, name: 'x' }, null);
    expect(fb.assign).toBeUndefined();
    expect(fb.message).toMatch(/Macros tab/);
  });
  it('empty segment: says why nothing was kept', () => {
    const fb = keepFeedback(null, null);
    expect(fb.kind).toBe('nothing');
    expect(fb.title).toBe('Nothing to keep');
    expect(fb.message).toMatch(/Do a task first/);
  });
});

describe('5. notification throttling', () => {
  const settings = DEFAULT_NOTIFY_SETTINGS;
  it('at most one per type per 10 minutes', () => {
    expect(mayNotify('flip-pair', settings, {}, NOW)).toBe(true);
    expect(mayNotify('flip-pair', settings, { 'flip-pair': NOW - 60_000 }, NOW)).toBe(false);
    expect(mayNotify('flip-pair', settings, { 'flip-pair': NOW - NOTIFY_THROTTLE_MS }, NOW)).toBe(true);
    // types do not share a budget
    expect(mayNotify('macro-suggestion', settings, { 'flip-pair': NOW - 1000 }, NOW)).toBe(true);
  });
  it('a disabled type never fires, even for a reply to a key press', () => {
    const off = { ...settings, 'macro-saved': false };
    expect(mayNotify('macro-saved', off, {}, NOW, { userInitiated: true })).toBe(false);
  });
  it('a reply to K / R ignores the throttle', () => {
    expect(mayNotify('macro-saved', settings, { 'macro-saved': NOW - 1000 }, NOW, { userInitiated: true })).toBe(true);
  });
  it('settings default to on and survive junk', () => {
    expect(notifySettingsFrom(undefined)).toEqual(DEFAULT_NOTIFY_SETTINGS);
    expect(notifySettingsFrom({ 'flip-pair': false, 'macro-saved': 'no' })).toEqual({ 'flip-pair': false, 'macro-suggestion': true, 'macro-saved': true });
  });
});

describe('6. Focus Flip detection: typing in any frame, with Focus Flip off', () => {
  const DOC = 'https://docs.google.com/document/d/1/edit';
  const ART = 'https://www.nytimes.com/2026/story';

  /**
   * W R W R ... W with `trips` round trips, typing in the doc on each writing visit. The burst's url is the
   * TOP page's (docs), though the keys landed in a hidden iframe. 20 s per visit, 4 s of typing at its start.
   */
  function docsSession(trips = 3, withTyping = true): CadenceEvent[] {
    const out: CadenceEvent[] = [];
    const visitCount = trips * 2 + 1;
    for (let i = 0; i < visitCount; i++) {
      const ago = 300_000 - i * 20_000;
      const writing = i % 2 === 0;
      const [tab, url] = writing ? [1, DOC] : [2, ART];
      out.push(ev(ago, 'tab_activated', tab, url));
      if (withTyping && writing) out.push(ev(ago - 4_000, 'typing_burst', 1, DOC, { keyCount: 20 }));
    }
    return out;
  }

  it('finds the pair after three round trips', () => {
    const found = detectPairsFromEvents(docsSession(), { now: NOW, demoMode: false });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ writingUrl: DOC, referenceUrl: ART });
    expect(found[0]!.trips).toBeGreaterThanOrEqual(3);
  });

  it('needs typing in the writing tab: switching alone is not a pair', () => {
    expect(detectPairsFromEvents(docsSession(3, false), { now: NOW, demoMode: false })).toEqual([]);
  });

  it('two round trips are enough in demo mode only', () => {
    const two = docsSession(2); // W R W R W
    expect(detectPairsFromEvents(two, { now: NOW, demoMode: true })).toHaveLength(1);
    expect(detectPairsFromEvents(two, { now: NOW, demoMode: false })).toEqual([]);
  });

  it('ctrl-flow\'s own switches are not counted', () => {
    const events = docsSession().map((e) => (e.kind === 'tab_activated' ? { ...e, programmatic: true } : e));
    expect(detectPairsFromEvents(events, { now: NOW, demoMode: false })).toEqual([]);
  });

  describe('the page announces typing even while Focus Flip is off', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sends a throttled typing ping, never an idle, never scroll or click', () => {
      const sent: IdleMessage[] = [];
      const t = createIdleTracker({ enabled: () => false, delays: () => ({ writeMs: 1500, readMs: 1500 }), send: (m) => sent.push(m) });
      t.activity('key');
      t.activity('key');
      t.activity('scroll');
      t.activity('click');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'activity', what: 'key' });
      vi.advanceTimersByTime(LEARN_PING_MS + 1);
      t.activity('key');
      expect(sent.filter((m) => m.type === 'activity')).toHaveLength(2);
      vi.advanceTimersByTime(60_000);
      expect(sent.filter((m) => m.type === 'activity_idle')).toHaveLength(0);
    });
  });
});

describe('7. Spaces: only real, recent co-usage joins a space', () => {
  const A = 'https://a.test/', B = 'https://b.test/', C = 'https://c.test/', D = 'https://d.test/';
  it('keeps tabs that were switched between, leaves the rest for "Other"', () => {
    const acts = [
      { url: A, ts: 1000 }, { url: B, ts: 5000 }, { url: A, ts: 9000 },
      { url: C, ts: 5_000_000 },
    ];
    const stats = computePairStats(acts);
    const used = urlsWithCoUsage([A, B, C, D], stats);
    expect([...used].sort()).toEqual([A, B]);
  });

  it('co-usage older than a few hours is not counted', () => {
    const old = [{ url: A, ts: 0 }, { url: B, ts: 1000 }, { url: A, ts: 2000 }];
    const recentCut = RECENT_CO_USAGE_MS + 100_000; // "now"
    const recent = old.filter((a) => a.ts >= recentCut - RECENT_CO_USAGE_MS);
    expect(urlsWithCoUsage([A, B], computePairStats(recent)).size).toBe(0);
  });

  it('a card shows the 5 most recently used tabs, with the rest counted', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => ({ url: `https://${x}.test/` }));
    const used = new Map(items.map((i, n) => [i.url, n * 10]));
    const { shown, more } = topByRecentUse(items, used);
    expect(shown.map((i) => i.url)).toEqual(['g', 'f', 'e', 'd', 'c'].map((x) => `https://${x}.test/`));
    expect(more).toBe(2);
  });
});

describe('8. not recording here', () => {
  it('excluded and visit-only sites show the grey state; paused wins; ordinary pages record', () => {
    expect(isExcludedUrl('https://chase.com/login', DEFAULT_BLOCKLIST)).toBe(true);
    expect(isExcludedUrl('https://mail.google.com/mail/u/0/', DEFAULT_BLOCKLIST)).toBe(true);
    expect(isExcludedUrl('https://github.com/', DEFAULT_BLOCKLIST)).toBe(false);
    expect(isExcludedUrl('chrome://extensions', DEFAULT_BLOCKLIST)).toBe(false);
    expect(recordingStateFor('https://chase.com/', false, DEFAULT_BLOCKLIST)).toBe('excluded');
    expect(recordingStateFor('https://chase.com/', true, DEFAULT_BLOCKLIST)).toBe('paused');
    expect(recordingStateFor('https://github.com/', false, DEFAULT_BLOCKLIST)).toBe('recording');
  });
});

describe('9-10. outbound history and read-aloud text', () => {
  const entry = (ts: number, kind: OutboundEntry['kind'] = 'ai'): OutboundEntry => ({ ts, kind, summary: `s${ts}`, detail: {} });
  it('keeps the last 10, newest first', () => {
    let list: OutboundEntry[] = [];
    for (let i = 1; i <= 14; i++) list = pushEntry(list, entry(i));
    expect(list).toHaveLength(OUTBOUND_HISTORY_MAX);
    expect(list[0]!.ts).toBe(14);
    expect(list[9]!.ts).toBe(5);
  });
  it('summarises each kind in one line', () => {
    expect(summarize('ai', { request: { task: 'standup' }, status: 200 })).toBe('AI · standup: HTTP 200');
    expect(summarize('ai', { request: { task: 'standup' }, status: null, error: 'x' })).toBe('AI · standup: failed');
    expect(summarize('cloud-sync', { outcome: 'stored 5 of 5', sent: 5 })).toBe('Tiger Data sync: stored 5 of 5 (5 events)');
    expect(summarize('tts', { via: 'elevenlabs', outcome: 'generated 12 KB of audio', chars: 900 })).toContain('900 chars');
  });
  it('read-aloud text is cut to 300 characters and says so', () => {
    expect(ttsText('short')).toEqual({ text: 'short', truncated: false });
    const long = ttsText('x'.repeat(900));
    expect(long.text).toHaveLength(TTS_LOG_TEXT_CHARS);
    expect(long.truncated).toBe(true);
  });
});
