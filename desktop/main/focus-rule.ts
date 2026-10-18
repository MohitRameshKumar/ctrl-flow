/**
 * The rule for "is the browser focused?", kept pure so it can be tested directly.
 *
 * In the extension the side panel lives inside Chrome, so using Cadence never blurs the browser.
 * On desktop Cadence is a separate OS window, and a literal reading of focus would mean:
 *
 *   - `chrome_focus_lost` fires every time the user clicks Cadence's own UI, which also calls
 *     `cancelFlip()` — so a flip can be cancelled by looking at the app that scheduled it
 *   - `focus-flip.ts`'s `isChromeFocused()` reads false whenever Cadence is in front, so a flip
 *     can never arm while the user has the app open
 *
 * Treating Cadence's own windows as part of "the browser is in use" avoids both.
 */
export function isBrowserInUse(browserFocused: boolean, cadenceFocused: boolean): boolean {
  return browserFocused || cadenceFocused;
}

/** The windowId `chrome.windows.onFocusChanged` reports when nothing is focused. */
export const WINDOW_ID_NONE = -1;

/** Maps effective focus onto the windowId that listeners compare against WINDOW_ID_NONE. */
export function focusWindowId(focused: boolean, activeWindowId: number | undefined): number {
  return focused ? (activeWindowId ?? 1) : WINDOW_ID_NONE;
}
