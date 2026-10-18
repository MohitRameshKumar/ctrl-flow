// Duration-based repetition thresholds for macro suggestions (pure, no imports).
//
//   routine under 30 s       -> must have been seen 3 times
//   routine 30 s - 5 min     -> 2 times
//   routine over 5 min       -> 1 time (it is expensive enough to repeat that one sighting is worth offering)
export const SHORT_ROUTINE_MS = 30 * 1000;
export const LONG_ROUTINE_MS = 5 * 60 * 1000;

export function requiredRuns(durationMs: number): number {
  if (durationMs < SHORT_ROUTINE_MS) return 3;
  if (durationMs <= LONG_ROUTINE_MS) return 2;
  return 1;
}

/** "Not now" back-off (PAT-4): each dismissal snoozes the suggestion for longer. */
export function snoozeMs(dismissals: number): number {
  const DAY = 24 * 60 * 60 * 1000;
  if (dismissals <= 1) return DAY;
  if (dismissals === 2) return 3 * DAY;
  return 7 * DAY;
}
