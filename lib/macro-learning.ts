/**
 * What Cadence learns from how a macro actually goes.
 *
 * v1 wrote run history that nothing ever read, and the only feedback was a permanent never-list
 * plus a ten-minute throttle — so "Not now" and being ignored were indistinguishable.
 *
 * Everything here is pure and rule-based: thresholds live in `constants.ts` and every decision
 * is a function of visible counters. That is deliberate. The user should be able to look at a
 * macro and know exactly why it did or did not promote itself.
 */

import {
  MACRO_AUTORUN_PROMOTE_RUNS,
  MACRO_DISMISS_BACKOFF,
  MACRO_DISMISS_STOP,
  MACRO_OFFER_THROTTLE_MS,
} from './constants';
import type { MacroRunResult, MacroStats, MacroStatus } from './types';

export const EMPTY_STATS: MacroStats = {
  runs: 0,
  successes: 0,
  failures: 0,
  undos: 0,
  offersShown: 0,
  offersDismissed: 0,
  cleanStreak: 0,
};

/** A run counts as clean only if nothing failed. Skipped steps are fine — the user chose those. */
export function runWasClean(result: MacroRunResult): boolean {
  return !result.outcomes.some((o) => o.status === 'failed');
}

export function recordRun(stats: MacroStats, result: MacroRunResult): MacroStats {
  const clean = runWasClean(result);
  return {
    ...stats,
    runs: stats.runs + 1,
    successes: stats.successes + (clean ? 1 : 0),
    failures: stats.failures + (clean ? 0 : 1),
    cleanStreak: clean ? stats.cleanStreak + 1 : 0,
  };
}

export function recordOfferShown(stats: MacroStats): MacroStats {
  return { ...stats, offersShown: stats.offersShown + 1 };
}

export function recordOfferDismissed(stats: MacroStats): MacroStats {
  return { ...stats, offersDismissed: stats.offersDismissed + 1 };
}

/** An undo is the strongest negative signal there is: the user watched it start and said no. */
export function recordUndo(stats: MacroStats): MacroStats {
  return { ...stats, undos: stats.undos + 1, cleanStreak: 0 };
}

/**
 * Backs off when the user keeps saying no.
 *
 * Repeatedly offering something that is always dismissed is the fastest way to make an assistant
 * feel like adware, so the interval widens and eventually the offer stops entirely.
 */
export function offerThrottleMs(stats: MacroStats): number {
  if (stats.offersDismissed >= MACRO_DISMISS_STOP) return Number.POSITIVE_INFINITY;
  if (stats.offersDismissed >= MACRO_DISMISS_BACKOFF) return MACRO_OFFER_THROTTLE_MS * 2;
  return MACRO_OFFER_THROTTLE_MS;
}

export function shouldOffer(stats: MacroStats, lastOfferAt: number | undefined, now: number): boolean {
  const throttle = offerThrottleMs(stats);
  if (!Number.isFinite(throttle)) return false;
  if (lastOfferAt === undefined) return true;
  return now - lastOfferAt >= throttle;
}

/**
 * Whether a macro has earned the right to run itself.
 *
 * Requires the user to have opted in globally *and* the macro to have a run of clean results.
 * A single undo resets the streak, so trust is easy to lose and has to be rebuilt.
 */
export function shouldPromoteToAuto(
  status: MacroStatus,
  stats: MacroStats,
  autoRunEnabled: boolean,
): boolean {
  if (!autoRunEnabled) return false;
  if (status !== 'accepted') return false;
  return stats.cleanStreak >= MACRO_AUTORUN_PROMOTE_RUNS;
}

/** One cancelled countdown is enough to stop a macro firing on its own again. */
export function shouldDemoteFromAuto(status: MacroStatus): boolean {
  return status === 'auto';
}

/**
 * Ranking for the suggestion list.
 *
 * Breadth matters as much as frequency — a routine spanning four pages is a better macro than
 * one spanning two, even seen slightly less often — and anything the user keeps dismissing sinks.
 */
export function suggestionScore(
  occurrences: number,
  distinctUrls: number,
  stats: MacroStats,
): number {
  const dismissalPenalty = 1 / (1 + stats.offersDismissed);
  return occurrences * distinctUrls * dismissalPenalty;
}

/** Plain-language reason the macro is where it is, for the UI. */
export function explainStatus(status: MacroStatus, stats: MacroStats): string {
  if (status === 'auto') return 'Runs on its own · cancel once to turn this off';
  if (status === 'never') return 'Dismissed';
  if (stats.runs === 0) return 'Not run yet';

  const parts = [`${stats.runs} run${stats.runs === 1 ? '' : 's'}`];
  if (stats.failures > 0) parts.push(`${stats.failures} with failures`);
  if (status === 'accepted' && stats.cleanStreak > 0) {
    const togo = MACRO_AUTORUN_PROMOTE_RUNS - stats.cleanStreak;
    parts.push(
      togo > 0
        ? `${stats.cleanStreak} clean in a row · ${togo} more to run itself`
        : 'ready to run itself',
    );
  }
  return parts.join(' · ');
}
