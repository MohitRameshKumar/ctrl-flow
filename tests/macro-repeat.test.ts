// Leader R fixtures modelled on the manual test: browse a bit, then open Wikipedia -> news -> GitHub.
import { describe, expect, it } from 'vitest';
import { eventToAction } from '@/lib/macro-detection';
import {
  PREVIEW_MAX_STEPS,
  describeSteps,
  lastSegment,
  planRepeat,
  previewText,
  segmentStart,
} from '@/lib/macro-repeat';
import type { CadenceEvent, ObservedAction } from '@/lib/types';
import { macro, openStep } from './helpers';

const NOW = 10_000_000;
const WIKI = 'https://en.wikipedia.org/wiki/Cadence';
const NYT = 'https://www.nytimes.com/section/world';
const GH = 'https://github.com/org/repo';

let seq = 0;
function ev(ago: number, kind: CadenceEvent['kind'], tabId: number, url: string, extra: Partial<CadenceEvent> = {}): CadenceEvent {
  return { id: ++seq, ts: NOW - ago, kind, tabId, url, domain: new URL(url).hostname, ...extra };
}
function actions(events: CadenceEvent[]): ObservedAction[] {
  return events.flatMap((e) => {
    const a = eventToAction(e);
    return a ? [a] : [];
  });
}
const urlsOf = (seg: ReturnType<typeof lastSegment>) =>
  seg?.candidate.steps.filter((s) => s.kind === 'open_url').map((s) => s.url);

/** The three-page task, as the collector writes it: tab_opened + tab_activated + navigated per page. */
function task(): CadenceEvent[] {
  return [
    ev(20_000, 'tab_opened', 10, WIKI),
    ev(20_000, 'tab_activated', 10, WIKI),
    ev(19_500, 'navigated', 10, WIKI),
    ev(12_000, 'tab_opened', 11, NYT),
    ev(12_000, 'tab_activated', 11, NYT),
    ev(8_000, 'tab_opened', 12, GH),
    ev(8_000, 'tab_activated', 12, GH),
    ev(7_500, 'navigated', 12, GH),
  ];
}

const since = (b = {}) => segmentStart(NOW, b);

describe('Leader R segment selection', () => {
  it('the 3-page test: exactly Wikipedia, news, GitHub', () => {
    const seg = lastSegment(actions(task()), since(), NOW);
    expect(urlsOf(seg)).toEqual([WIKI, NYT, GH]);
  });

  it('(a) browsing from before the task is not pulled in, even inside the lookback', () => {
    const before = [
      ev(200_000, 'navigated', 3, 'https://news.ycombinator.com/'),
      ev(190_000, 'navigated', 3, 'https://reddit.com/r/x'),
      ev(150_000, 'tab_opened', 4, 'https://mail.example.com/inbox'),
      ev(60_000, 'navigated', 4, 'https://calendar.example.com/'),
    ];
    const seg = lastSegment(actions([...before, ...task()]), since(), NOW);
    expect(urlsOf(seg)).toEqual([WIKI, NYT, GH]);
  });

  it('(b) a redirect chain in one tab collapses to its final URL', () => {
    const events = [
      ev(20_000, 'tab_opened', 10, WIKI),
      ev(12_000, 'tab_opened', 11, 'http://nytimes.com/'),
      ev(11_000, 'navigated', 11, 'https://nytimes.com/'),
      ev(10_000, 'navigated', 11, NYT),
      ev(6_000, 'tab_opened', 12, GH),
    ];
    expect(urlsOf(lastSegment(actions(events), since(), NOW))).toEqual([WIKI, NYT, GH]);
  });

  it('(b) in-page (SPA) navigation is ignored unless the user clicked just before', () => {
    const spa = (ago: number, url: string) => ev(ago, 'navigated', 12, url, { spa: true });
    const quiet = [...task(), spa(5_000, 'https://github.com/org/repo/pulls'), spa(4_000, 'https://github.com/org/repo/issues')];
    expect(urlsOf(lastSegment(actions(quiet), since(), NOW))).toEqual([WIKI, NYT, GH]);

    const clicked = [
      ...task(),
      ev(5_500, 'click', 12, GH, { selector: 'a.pulls' }),
      spa(5_000, 'https://github.com/org/repo/pulls'),
    ];
    expect(urlsOf(lastSegment(actions(clicked), since(), NOW))).toEqual([WIKI, NYT, GH, 'https://github.com/org/repo/pulls']);
  });

  it('(c) switching to an already-open tab is not an open_url step', () => {
    const events = [...task(), ev(5_000, 'tab_activated', 2, 'https://docs.example.com/already-open'), ev(3_000, 'tab_activated', 1, 'https://mail.example.com/')];
    const seg = lastSegment(actions(events), since(), NOW);
    expect(urlsOf(seg)).toEqual([WIKI, NYT, GH]);
  });

  it('(d) events from a previous replay are excluded by the replay-end boundary, even unflagged ones', () => {
    // A replay of an older routine ended 25 s ago; its late page-load events (no programmatic flag) landed before then.
    const replayLeak = [
      ev(60_000, 'tab_opened', 20, 'https://a.example.com/'),
      ev(58_000, 'navigated', 20, 'https://a.example.com/home'),
      ev(56_000, 'tab_opened', 21, 'https://b.example.com/'),
      ev(30_000, 'navigated', 21, 'https://b.example.com/late'),
    ];
    const replayEnd = NOW - 25_000;
    const seg = lastSegment(actions([...replayLeak, ...task()]), since({ lastRunEnd: replayEnd }), NOW);
    expect(urlsOf(seg)).toEqual([WIKI, NYT, GH]);
  });

  it('(d) programmatic and synthetic events are not actions at all', () => {
    const flagged = [
      ev(15_000, 'tab_activated', 30, 'https://c.example.com/', { programmatic: true }),
      ev(14_000, 'tab_opened', 31, 'https://d.example.com/', { synthetic: true }),
    ];
    expect(urlsOf(lastSegment(actions([...flagged, ...task()]), since(), NOW))).toEqual([WIKI, NYT, GH]);
  });

  it('R right after a replay (or K) finds nothing new, so it cannot double up', () => {
    const consumed = NOW - 1_000;
    expect(lastSegment(actions(task()), since({ lastConsumed: consumed }), NOW)).toBeNull();
    expect(lastSegment(actions(task()), since({ lastRunEnd: consumed }), NOW)).toBeNull();
  });

  it('a pending M mark starts the segment at the mark', () => {
    const markStart = NOW - 13_000; // after Wikipedia, before NYT
    expect(urlsOf(lastSegment(actions(task()), since({ markStart }), NOW))).toEqual([NYT, GH]);
  });

  it('never falls back to an older session when the latest one is unusable', () => {
    const gapped = [ev(120_000, 'tab_opened', 10, WIKI), ev(110_000, 'tab_opened', 11, NYT), ev(1_000, 'tab_opened', 99, 'https://solo.example.com/')];
    expect(lastSegment(actions(gapped), since(), NOW)).toBeNull();
  });
});

describe('Leader R preview text', () => {
  it('shows the steps and how to answer', () => {
    const plan = planRepeat(lastSegment(actions(task()), since(), NOW), []);
    const { runnable, text } = previewText(plan);
    expect(runnable).toBe(true);
    expect(text).toMatch(/^Repeat 3 steps: Wikipedia → Nytimes → GitHub\. Enter to run, Esc to cancel\.$/);
  });

  it('caps at 10 steps and says how many more', () => {
    const urls = Array.from({ length: 13 }, (_, i) => `https://site${i}.example.com/`);
    const { count, text } = describeSteps(urls);
    expect(count).toBe(13);
    expect(text.split(' → ').length).toBe(PREVIEW_MAX_STEPS + 1);
    expect(text.endsWith('+3 more')).toBe(true);
  });

  it('falls back to the last-run macro and says so; says nothing-to-repeat when there is none', () => {
    const older = { ...macro({ steps: [openStep(WIKI)] }), id: 1, name: 'Old', lastRunAt: 10 };
    const newer = { ...macro({ steps: [openStep(NYT), openStep(GH)] }), id: 2, name: 'Morning', lastRunAt: 99 };
    const plan = planRepeat(null, [older, newer]);
    expect(plan.via).toBe('last-macro');
    expect(previewText(plan).text).toMatch(/^No recent action\. Repeat last macro "Morning" \(2 steps: /);
    expect(planRepeat(null, [{ ...older, lastRunAt: undefined }]).via).toBe('none');
    expect(planRepeat(null, [{ ...newer, status: 'never' }]).via).toBe('none');
    expect(previewText({ via: 'none' }).runnable).toBe(false);
  });
});
