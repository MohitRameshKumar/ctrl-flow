// Leader R, "repeat the last action": pure selection logic (no chrome.*, no Dexie) so it is unit-testable.
// It only picks *what* to repeat; building and running go through the macro feature's own functions.
import { candidateFromSession, isUsableSession, sessionize } from './macro-detection';
import type { Macro, MacroCandidate, ObservedAction } from './types';

/** Actions this far apart belong to different segments. Shorter than detection's 3 minutes: R means "what I just did". */
export const SEGMENT_GAP_MS = 30 * 1000;
/** A segment whose last action is newer than this may still be in progress, so it is not "completed". */
export const SEGMENT_SETTLE_MS = 3 * 1000;
/** How far back a segment may end and still count as recent. */
export const SEGMENT_MAX_AGE_MS = 10 * 60 * 1000;

/** The most recent completed, usable segment of actions as a macro candidate, or null. */
export function lastCompletedSegment(actions: ObservedAction[], now: number): MacroCandidate | null {
  const sessions = sessionize(actions, SEGMENT_GAP_MS).filter(isUsableSession);
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i]!;
    const end = session[session.length - 1]!.ts;
    if (now - end < SEGMENT_SETTLE_MS) continue; // still happening
    if (now - end > SEGMENT_MAX_AGE_MS) return null; // nothing recent enough
    const candidate = candidateFromSession(session);
    if (candidate) return candidate;
  }
  return null;
}

export type RepeatPlan =
  | { via: 'segment'; candidate: MacroCandidate }
  | { via: 'last-macro'; macro: Macro }
  | { via: 'none' };

/** Recent action first; otherwise the last-run macro; otherwise nothing. */
export function planRepeat(candidate: MacroCandidate | null, macros: Macro[]): RepeatPlan {
  if (candidate) return { via: 'segment', candidate };
  const last = macros
    .filter((m) => m.id !== undefined && m.status !== 'never' && m.lastRunAt !== undefined)
    .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))[0];
  return last ? { via: 'last-macro', macro: last } : { via: 'none' };
}
