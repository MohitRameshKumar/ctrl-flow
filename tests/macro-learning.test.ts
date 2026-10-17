import { describe, expect, it } from 'vitest';
import { matchInProgress } from '@/lib/macro-detection';
import {
  EMPTY_STATS,
  explainStatus,
  offerThrottleMs,
  recordOfferDismissed,
  recordOfferShown,
  recordRun,
  recordUndo,
  runWasClean,
  shouldDemoteFromAuto,
  shouldOffer,
  shouldPromoteToAuto,
  suggestionScore,
} from '@/lib/macro-learning';
import {
  MACRO_AUTORUN_PROMOTE_RUNS,
  MACRO_DISMISS_BACKOFF,
  MACRO_DISMISS_STOP,
  MACRO_OFFER_THROTTLE_MS,
} from '@/lib/constants';
import type { MacroRunResult, MacroStats, StepOutcome } from '@/lib/types';
import { A, B, C, D, at, clickStep, macro, open, openStep } from './helpers';

function result(...statuses: StepOutcome['status'][]): MacroRunResult {
  return {
    startedAt: 0,
    finishedAt: 100,
    outcomes: statuses.map((status, i) => ({ stepKey: `s${i}`, status })),
  };
}

function stats(overrides: Partial<MacroStats> = {}): MacroStats {
  return { ...EMPTY_STATS, ...overrides };
}

describe('runWasClean', () => {
  it('treats a skipped step as fine but a failure as not', () => {
    expect(runWasClean(result('ok', 'skipped'))).toBe(true);
    expect(runWasClean(result('ok', 'failed'))).toBe(false);
  });
});

describe('recordRun', () => {
  it('builds a clean streak', () => {
    let s = stats();
    s = recordRun(s, result('ok'));
    s = recordRun(s, result('ok'));
    expect(s).toMatchObject({ runs: 2, successes: 2, failures: 0, cleanStreak: 2 });
  });

  it('a single failure resets the streak', () => {
    let s = stats({ cleanStreak: 4, successes: 4, runs: 4 });
    s = recordRun(s, result('ok', 'failed'));
    expect(s.cleanStreak).toBe(0);
    expect(s.failures).toBe(1);
  });
});

describe('offer back-off', () => {
  it('widens the interval once the user keeps dismissing', () => {
    expect(offerThrottleMs(stats())).toBe(MACRO_OFFER_THROTTLE_MS);
    expect(offerThrottleMs(stats({ offersDismissed: MACRO_DISMISS_BACKOFF }))).toBe(
      MACRO_OFFER_THROTTLE_MS * 2,
    );
  });

  it('stops offering entirely after enough dismissals', () => {
    const s = stats({ offersDismissed: MACRO_DISMISS_STOP });
    expect(offerThrottleMs(s)).toBe(Number.POSITIVE_INFINITY);
    expect(shouldOffer(s, undefined, 0)).toBe(false);
  });

  it('offers freely when nothing has been shown yet', () => {
    expect(shouldOffer(stats(), undefined, 1000)).toBe(true);
  });

  it('respects the throttle window', () => {
    const now = 10_000_000;
    expect(shouldOffer(stats(), now - 1000, now)).toBe(false);
    expect(shouldOffer(stats(), now - MACRO_OFFER_THROTTLE_MS, now)).toBe(true);
  });

  it('counts offers and dismissals separately', () => {
    const s = recordOfferDismissed(recordOfferShown(stats()));
    expect(s).toMatchObject({ offersShown: 1, offersDismissed: 1 });
  });
});

describe('auto-run promotion', () => {
  it('needs the global opt-in', () => {
    const ready = stats({ cleanStreak: MACRO_AUTORUN_PROMOTE_RUNS });
    expect(shouldPromoteToAuto('accepted', ready, false)).toBe(false);
    expect(shouldPromoteToAuto('accepted', ready, true)).toBe(true);
  });

  it('needs a full streak of clean runs', () => {
    const short = stats({ cleanStreak: MACRO_AUTORUN_PROMOTE_RUNS - 1 });
    expect(shouldPromoteToAuto('accepted', short, true)).toBe(false);
  });

  it('never promotes something the user has not accepted', () => {
    const ready = stats({ cleanStreak: MACRO_AUTORUN_PROMOTE_RUNS });
    expect(shouldPromoteToAuto('suggested', ready, true)).toBe(false);
    expect(shouldPromoteToAuto('never', ready, true)).toBe(false);
  });

  it('one undo wipes the streak, so trust has to be rebuilt', () => {
    const s = recordUndo(stats({ cleanStreak: MACRO_AUTORUN_PROMOTE_RUNS }));
    expect(s.undos).toBe(1);
    expect(shouldPromoteToAuto('accepted', s, true)).toBe(false);
  });

  it('demotes only something that is actually auto', () => {
    expect(shouldDemoteFromAuto('auto')).toBe(true);
    expect(shouldDemoteFromAuto('accepted')).toBe(false);
  });
});

describe('suggestionScore', () => {
  it('rewards breadth as well as frequency', () => {
    expect(suggestionScore(3, 4, stats())).toBeGreaterThan(suggestionScore(4, 2, stats()));
  });

  it('sinks something the user keeps dismissing', () => {
    expect(suggestionScore(5, 3, stats({ offersDismissed: 3 }))).toBeLessThan(
      suggestionScore(5, 3, stats()),
    );
  });
});

describe('explainStatus', () => {
  it('says how close a macro is to running itself', () => {
    expect(explainStatus('accepted', stats({ runs: 3, cleanStreak: 3 }))).toContain('2 more');
  });

  it('describes an auto macro and how to stop it', () => {
    expect(explainStatus('auto', stats())).toContain('cancel once');
  });

  it('says nothing has happened yet', () => {
    expect(explainStatus('accepted', stats())).toBe('Not run yet');
  });
});

describe('matchInProgress', () => {
  const saved = macro({
    id: 1,
    status: 'accepted',
    steps: [openStep(A), openStep(B), openStep(C)],
  });
  const noneOpen = { minMatch: 2, openUrls: new Set<string>() };

  it('offers to finish once enough steps line up', () => {
    const match = matchInProgress([open(1, A), open(2, B)], [saved], noneOpen);
    expect(match?.matched).toBe(2);
    expect(match?.remaining.map((s) => s.url)).toEqual([C]);
  });

  it('stays quiet before the minimum', () => {
    expect(matchInProgress([open(1, A)], [saved], noneOpen)).toBeNull();
  });

  it('ignores a macro the user has not accepted', () => {
    const suggested = macro({ id: 2, status: 'suggested', steps: saved.steps });
    expect(matchInProgress([open(1, A), open(2, B)], [suggested], noneOpen)).toBeNull();
  });

  it('tolerates a detour between the steps', () => {
    // Real work is not a contiguous block; requiring one would mean this never fires.
    const match = matchInProgress([open(1, A), open(2, D), open(3, B)], [saved], noneOpen);
    expect(match?.matched).toBe(2);
  });

  it('says nothing when the rest is already open', () => {
    const allOpen = { minMatch: 2, openUrls: new Set([C]) };
    expect(matchInProgress([open(1, A), open(2, B)], [saved], allOpen)).toBeNull();
  });

  it('says nothing when the routine is already finished', () => {
    expect(matchInProgress([open(1, A), open(2, B), open(3, C)], [saved], noneOpen)).toBeNull();
  });

  it('recognizes the routine on a different ticket', () => {
    // Canonical comparison is what lets a parameterized macro match the next PR.
    const parameterized = macro({
      id: 3,
      status: 'accepted',
      steps: [openStep('https://github.com/org/repo/pull/{pull}'), openStep(B), openStep(C)],
    });
    const match = matchInProgress(
      [open(1, 'https://github.com/org/repo/pull/904'), open(2, B)],
      [parameterized],
      noneOpen,
    );
    // A `{pull}` placeholder folds to the same wildcard as a concrete id, so the macro matches
    // a ticket it has never seen. Parameterized routines are the most repetitive ones, so this
    // is the case the mid-flow offer most needs to handle.
    expect(match?.matched).toBe(2);
    expect(match?.remaining.map((s) => s.url)).toEqual([C]);
  });

  it('prefers the macro the user is furthest into', () => {
    const shallow = macro({ id: 4, status: 'accepted', steps: [openStep(A), openStep(B), openStep(D)] });
    const deep = macro({
      id: 5,
      status: 'accepted',
      steps: [openStep(A), openStep(B), openStep(C), openStep(D)],
    });
    const match = matchInProgress([open(1, A), open(2, B), open(3, C)], [shallow, deep], noneOpen);
    expect(match?.macro.id).toBe(5);
  });

  it('ignores disabled steps when matching and when offering', () => {
    const withDisabled = macro({
      id: 6,
      status: 'accepted',
      steps: [openStep(A), openStep(B), clickStep(C, '#x'), openStep(C)],
    });
    const match = matchInProgress([open(1, A), open(2, B)], [withDisabled], noneOpen);
    expect(match?.remaining.map((s) => s.key)).toEqual([`open:${C}`]);
  });

  it('returns nothing when there is no activity at all', () => {
    expect(matchInProgress([], [saved], noneOpen)).toBeNull();
  });

  it('ignores a macro too short to have anything left over', () => {
    const tiny = macro({ id: 7, status: 'accepted', steps: [openStep(A), openStep(B)] });
    expect(matchInProgress([open(at(1, 9), A), open(at(1, 9, 1), B)], [tiny], noneOpen)).toBeNull();
  });
});
