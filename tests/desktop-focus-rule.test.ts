// On desktop, Cadence's UI is a separate OS window rather than a panel inside Chrome. Reading
// focus literally would make the app sabotage itself: clicking Cadence would fire
// `chrome_focus_lost` (which calls cancelFlip) and would make focus-flip.ts's isChromeFocused()
// false exactly while the user is looking at the app that schedules flips.
import { expect, it } from 'vitest';
import { WINDOW_ID_NONE, focusWindowId, isBrowserInUse } from '@/desktop/main/focus-rule';

it('counts the browser as in use when the browser has focus', () => {
  expect(isBrowserInUse(true, false)).toBe(true);
});

it('counts the browser as in use when Cadence has focus', () => {
  // The whole point: interacting with Cadence must not read as "left the browser".
  expect(isBrowserInUse(false, true)).toBe(true);
});

it('counts the browser as in use when both have focus', () => {
  expect(isBrowserInUse(true, true)).toBe(true);
});

it('reports not-in-use only when neither has focus', () => {
  expect(isBrowserInUse(false, false)).toBe(false);
});

it('maps blur onto WINDOW_ID_NONE, which is what background.ts compares against', () => {
  // `background.ts` branches on `windowId === chrome.windows.WINDOW_ID_NONE` to choose between
  // chrome_focus_lost and chrome_focus_gained, so this exact value is load-bearing.
  expect(focusWindowId(false, 7)).toBe(WINDOW_ID_NONE);
  expect(WINDOW_ID_NONE).toBe(-1);
});

it('maps focus onto the active window id', () => {
  expect(focusWindowId(true, 7)).toBe(7);
});

it('falls back to a real window id when none is known', () => {
  // Never return WINDOW_ID_NONE for a focused state: that would be read as a blur.
  expect(focusWindowId(true, undefined)).not.toBe(WINDOW_ID_NONE);
  expect(focusWindowId(true, undefined)).toBe(1);
});
