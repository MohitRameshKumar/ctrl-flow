import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideFlip, flipStatus, siteLabel, type CycleContext, type CyclePair, type CycleTab } from '@/lib/flip-cycle';
import { createIdleTracker, type IdleMessage } from '@/lib/flip-idle';
import { FLIP_DELAY_DEFAULT_MS, FLIP_DELAY_MAX_MS, FLIP_DELAY_MIN_MS, FLIP_READ_DELAY_KEY, FLIP_WRITE_DELAY_KEY, clampFlipDelay, delaysFromStorage } from '@/lib/flip-settings';

const DOC = 'https://docs.google.com/document/d/1';
const NYT = 'https://www.nytimes.com/2026/article';
const MAIL = 'https://mail.example.com/inbox';

const pair: CyclePair = { writingUrl: DOC, referenceUrl: NYT, active: true, updatedAt: 10 };
const docTab: CycleTab = { id: 1, url: DOC, windowId: 1, active: true };
const nytTab: CycleTab = { id: 2, url: NYT, windowId: 1, active: true };
const mailTab: CycleTab = { id: 3, url: MAIL, windowId: 1, active: true };

function ctx(over: Partial<CycleContext>): CycleContext {
  return {
    enabled: true,
    appPaused: false,
    replaying: false,
    chromeFocused: true,
    sensitiveTabIds: [],
    tab: docTab,
    kind: 'key',
    pairs: [pair],
    openTabs: [docTab, nytTab, mailTab],
    ...over,
  };
}

describe('the flip cycle (decideFlip)', () => {
  it('type -> idle on the writing tab flips to the reference tab', () => {
    expect(decideFlip(ctx({ tab: docTab, kind: 'key' }))).toEqual({ flip: true, toTabId: 2, role: 'writing' });
  });

  it('scroll -> idle (or click -> idle) on the reference tab flips back to the writing tab', () => {
    expect(decideFlip(ctx({ tab: nytTab, kind: 'scroll' }))).toEqual({ flip: true, toTabId: 1, role: 'reference' });
    expect(decideFlip(ctx({ tab: nytTab, kind: 'click' }))).toEqual({ flip: true, toTabId: 1, role: 'reference' });
  });

  it('repeats indefinitely: the same two decisions alternate with no memory between cycles', () => {
    const seen: number[] = [];
    let tab = docTab;
    for (let i = 0; i < 6; i++) {
      const d = decideFlip(ctx({ tab, kind: tab === docTab ? 'key' : 'scroll' }));
      expect(d.flip).toBe(true);
      if (d.flip) {
        seen.push(d.toTabId);
        tab = d.toTabId === 1 ? docTab : nytTab;
      }
    }
    expect(seen).toEqual([2, 1, 2, 1, 2, 1]);
  });

  it('the wrong kind of activity does nothing: scrolling the writing tab, typing in the reference tab', () => {
    expect(decideFlip(ctx({ tab: docTab, kind: 'scroll' }))).toMatchObject({ flip: false });
    expect(decideFlip(ctx({ tab: nytTab, kind: 'key' }))).toMatchObject({ flip: false });
  });

  it('on a tab outside the pair the cycle is paused: no flip, whatever happens there', () => {
    for (const kind of ['key', 'scroll', 'click'] as const) {
      expect(decideFlip(ctx({ tab: mailTab, kind }))).toEqual({ flip: false, reason: 'no-pair' });
    }
  });

  it('returning to either tab of the pair resumes the cycle', () => {
    expect(decideFlip(ctx({ tab: mailTab, kind: 'key' })).flip).toBe(false);
    expect(decideFlip(ctx({ tab: docTab, kind: 'key' })).flip).toBe(true); // back on the writing tab
    expect(decideFlip(ctx({ tab: nytTab, kind: 'scroll' })).flip).toBe(true); // or back on the reference tab
  });

  it('a manual switch between the two tabs is fine: the cycle continues from whichever tab you are on', () => {
    expect(decideFlip(ctx({ tab: nytTab, kind: 'scroll' }))).toMatchObject({ flip: true, toTabId: 1 });
  });

  it('toggled off mid-cycle: nothing flips', () => {
    expect(decideFlip(ctx({ enabled: false }))).toEqual({ flip: false, reason: 'off' });
  });

  it('a macro replay never flips; neither does ctrl-flow being paused, Chrome losing focus, or a sensitive field', () => {
    expect(decideFlip(ctx({ replaying: true }))).toEqual({ flip: false, reason: 'replaying' });
    expect(decideFlip(ctx({ appPaused: true }))).toEqual({ flip: false, reason: 'app-paused' });
    expect(decideFlip(ctx({ chromeFocused: false }))).toEqual({ flip: false, reason: 'chrome-unfocused' });
    expect(decideFlip(ctx({ sensitiveTabIds: [1] }))).toEqual({ flip: false, reason: 'sensitive' });
  });

  it('a tab that is not the active one cannot flip (a late idle from a tab you already left)', () => {
    expect(decideFlip(ctx({ tab: { ...docTab, active: false } }))).toEqual({ flip: false, reason: 'tab-inactive' });
  });

  it('an inactive pair, or a pair whose other tab is closed, does not flip', () => {
    expect(decideFlip(ctx({ pairs: [{ ...pair, active: false }] }))).toEqual({ flip: false, reason: 'no-pair' });
    expect(decideFlip(ctx({ openTabs: [docTab, mailTab] }))).toEqual({ flip: false, reason: 'no-target' });
  });

  it('the most recent active pair that includes the tab wins; the target prefers the same window', () => {
    const other: CyclePair = { writingUrl: DOC, referenceUrl: MAIL, active: true, updatedAt: 99 };
    expect(decideFlip(ctx({ pairs: [pair, other] }))).toMatchObject({ flip: true, toTabId: 3 });
    const farNyt: CycleTab = { id: 9, url: NYT, windowId: 2 };
    expect(decideFlip(ctx({ openTabs: [docTab, farNyt, nytTab] }))).toMatchObject({ toTabId: 2 });
  });
});

describe('activity-then-idle (createIdleTracker)', () => {
  let sent: IdleMessage[];
  let enabled: boolean;
  let delays: { writeMs: number; readMs: number };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    sent = [];
    enabled = true;
    delays = { writeMs: 1500, readMs: 1500 };
  });
  afterEach(() => vi.useRealTimers());

  const make = () => createIdleTracker({ enabled: () => enabled, delays: () => delays, send: (m) => sent.push(m) });
  const idles = () => sent.filter((m) => m.type === 'activity_idle');

  it('type, then stop: exactly one idle, after the delay, stamped with the real last keystroke', () => {
    const t = make();
    t.activity('key');
    vi.advanceTimersByTime(400);
    t.activity('key');
    const lastKeyTs = Date.now();
    vi.advanceTimersByTime(1499);
    expect(idles()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(idles()).toEqual([{ type: 'activity_idle', what: 'key', ts: lastKeyTs }]);
  });

  it('every keystroke restarts the clock: continuous typing never goes idle', () => {
    const t = make();
    for (let i = 0; i < 20; i++) {
      t.activity('key');
      vi.advanceTimersByTime(1000);
    }
    expect(idles()).toHaveLength(0);
  });

  it('scroll, then stop: idle after the read delay; clicks share the same timer', () => {
    const t = make();
    t.activity('scroll');
    vi.advanceTimersByTime(700);
    t.activity('click');
    vi.advanceTimersByTime(1500);
    expect(idles()).toEqual([expect.objectContaining({ type: 'activity_idle', what: 'click' })]);
  });

  it('idle without prior activity: nothing is ever sent, however long you sit there', () => {
    make();
    vi.advanceTimersByTime(10 * 60_000);
    expect(sent).toHaveLength(0);
  });

  it('an idle fires once per burst; the next flip needs new activity', () => {
    const t = make();
    t.activity('key');
    vi.advanceTimersByTime(1500);
    vi.advanceTimersByTime(60_000);
    expect(idles()).toHaveLength(1);
    t.activity('key');
    vi.advanceTimersByTime(1500);
    expect(idles()).toHaveLength(2);
  });

  it('the delay settings are respected, separately for typing and scrolling', () => {
    delays = { writeMs: 3000, readMs: 500 };
    const t = make();
    t.activity('key');
    t.activity('scroll');
    vi.advanceTimersByTime(500);
    expect(idles().map((m) => m.what)).toEqual(['scroll']);
    vi.advanceTimersByTime(2499);
    expect(idles()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(idles().map((m) => m.what)).toEqual(['scroll', 'key']);
  });

  it('a delay changed mid-burst applies from the next event', () => {
    const t = make();
    t.activity('key');
    delays = { writeMs: 5000, readMs: 1500 };
    t.activity('key');
    vi.advanceTimersByTime(4999);
    expect(idles()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(idles()).toHaveLength(1);
  });

  it('toggle off mid-cycle stops everything at once, including a pending idle', () => {
    const t = make();
    t.activity('key');
    enabled = false;
    t.clear();
    vi.advanceTimersByTime(10_000);
    expect(idles()).toHaveLength(0);
    t.activity('key'); // ignored while off
    expect(sent.filter((m) => m.type === 'activity')).toHaveLength(1); // only the one from before
  });

  it('even without clear(), an idle that fires after the toggle went off is dropped', () => {
    const t = make();
    t.activity('scroll');
    enabled = false;
    vi.advanceTimersByTime(5000);
    expect(idles()).toHaveLength(0);
  });

  it('announces only the first event of a burst (pair learning), not every keystroke', () => {
    const t = make();
    for (let i = 0; i < 10; i++) t.activity('key');
    expect(sent.filter((m) => m.type === 'activity')).toHaveLength(1);
  });
});

describe('delay settings', () => {
  it('default 1.5 s; range 0.5-5 s in 0.5 s steps; junk falls back to the default', () => {
    expect(FLIP_DELAY_DEFAULT_MS).toBe(1500);
    expect(clampFlipDelay(undefined)).toBe(1500);
    expect(clampFlipDelay('fast')).toBe(1500);
    expect(clampFlipDelay(NaN)).toBe(1500);
    expect(clampFlipDelay(100)).toBe(FLIP_DELAY_MIN_MS);
    expect(clampFlipDelay(99_000)).toBe(FLIP_DELAY_MAX_MS);
    expect(clampFlipDelay(1740)).toBe(1500);
    expect(clampFlipDelay(1760)).toBe(2000);
    expect(clampFlipDelay(3500)).toBe(3500);
  });

  it('reads both settings from storage, each independently', () => {
    expect(delaysFromStorage({})).toEqual({ writeMs: 1500, readMs: 1500 });
    expect(delaysFromStorage({ [FLIP_WRITE_DELAY_KEY]: 500, [FLIP_READ_DELAY_KEY]: 4000 })).toEqual({ writeMs: 500, readMs: 4000 });
  });
});

describe('the status line', () => {
  const base = { enabled: true, appPaused: false, replaying: false, pairs: [pair] };

  it('off / no pair / cycling / paused on another tab', () => {
    expect(flipStatus({ ...base, enabled: false })).toEqual({ state: 'off', label: 'Focus Flip: off' });
    expect(flipStatus({ ...base, pairs: [] }).state).toBe('no-pair');
    expect(flipStatus({ ...base, activeUrl: DOC })).toEqual({ state: 'cycling', label: 'Focus Flip: Google Docs ↔ Nytimes · cycling' });
    expect(flipStatus({ ...base, activeUrl: NYT }).state).toBe('cycling');
    expect(flipStatus({ ...base, activeUrl: MAIL })).toEqual({ state: 'paused-other-tab', label: 'Focus Flip: Google Docs ↔ Nytimes · paused (on another tab)' });
  });

  it('says why it is paused when recording is paused or a macro is running', () => {
    expect(flipStatus({ ...base, activeUrl: DOC, appPaused: true }).state).toBe('paused-recording');
    expect(flipStatus({ ...base, activeUrl: DOC, replaying: true }).state).toBe('paused-macro');
  });

  it('labels sites by name', () => {
    expect(siteLabel(DOC)).toBe('Google Docs');
  });
});
