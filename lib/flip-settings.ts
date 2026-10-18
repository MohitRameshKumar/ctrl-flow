// Focus Flip timing settings. Pure apart from the two storage getters, so the content script can import
// the clamp and keys without pulling in anything heavy.
export const FLIP_WRITE_DELAY_KEY = 'focusFlipWriteDelayMs';
export const FLIP_READ_DELAY_KEY = 'focusFlipReadDelayMs';

export const FLIP_DELAY_DEFAULT_MS = 1500;
export const FLIP_DELAY_MIN_MS = 500;
export const FLIP_DELAY_MAX_MS = 5000;
export const FLIP_DELAY_STEP_MS = 500;

/** Any stored value -> a valid delay: a multiple of 0.5 s in 0.5-5 s; anything unusable becomes the 1.5 s default. */
export function clampFlipDelay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return FLIP_DELAY_DEFAULT_MS;
  const stepped = Math.round(value / FLIP_DELAY_STEP_MS) * FLIP_DELAY_STEP_MS;
  return Math.min(FLIP_DELAY_MAX_MS, Math.max(FLIP_DELAY_MIN_MS, stepped));
}

export interface FlipDelays {
  /** Idle time after the last keystroke on the writing tab. */
  writeMs: number;
  /** Idle time after the last scroll / click on the reference tab. */
  readMs: number;
}

export function delaysFromStorage(stored: Record<string, unknown>): FlipDelays {
  return { writeMs: clampFlipDelay(stored[FLIP_WRITE_DELAY_KEY]), readMs: clampFlipDelay(stored[FLIP_READ_DELAY_KEY]) };
}

export async function getFlipDelays(): Promise<FlipDelays> {
  return delaysFromStorage(await chrome.storage.local.get([FLIP_WRITE_DELAY_KEY, FLIP_READ_DELAY_KEY]));
}
