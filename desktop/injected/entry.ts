/**
 * The bundle injected into every page.
 *
 * Built as a self-contained IIFE (see `vite.config.ts` next to this file) and handed to
 * `Page.addScriptToEvaluateOnNewDocument`, so it runs before any page script — the equivalent of a
 * content script at `document_start`.
 *
 * It installs the page-side `chrome` shim and then calls `entrypoints/content.ts`'s own `main()`,
 * unchanged. Also reports `visibilitychange`, which is how tab activation is detected: CDP has no
 * activation event, but exactly one tab per window is `visible`, which is the same thing.
 */

import { installPageChrome } from './page-chrome';
import contentScript from '@/entrypoints/content';

declare const __CADENCE_INITIAL_STORAGE__: string;

function post(payload: unknown): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const binding = g.__cadenceSend as ((s: string) => void) | undefined;
  if (typeof binding !== 'function') return;
  try {
    binding(JSON.stringify(payload));
  } catch {
    /* unloading, or the binding was torn down */
  }
}

function reportVisibility(): void {
  post({
    channel: 'visibility',
    visible: document.visibilityState === 'visible',
    hasFocus: document.hasFocus(),
  });
}

/**
 * Reports the document title, including later changes.
 *
 * CDP's `Target.targetInfoChanged` reports a title once — and often reports the *URL* as a
 * placeholder, before `<title>` is parsed. It does not fire again when page script updates
 * `document.title` ("Inbox (3)", a doc being renamed). Titles end up in stored events and in
 * `ObservedAction.title`, which is what macro and space naming read, so a stale title means a
 * badly named macro. Observing the title element is the only reliable source.
 */
function watchTitle(): void {
  let last = '';
  const report = () => {
    const title = document.title;
    if (title === last) return;
    last = title;
    post({ channel: 'title', title });
  };

  report();

  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(report).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }
  // The <title> element may not exist yet at document_start, and SPAs replace it outright, so the
  // head is watched too.
  if (document.head) {
    new MutationObserver(report).observe(document.head, { childList: true, subtree: true });
  }
  document.addEventListener('readystatechange', report);
}

(function main() {
  // Top frame only for visibility; iframes share the tab's visibility and would just duplicate.
  const isTop = (() => {
    try {
      return window.top === window.self;
    } catch {
      return false;
    }
  })();

  let initial: Record<string, unknown> = {};
  try {
    initial = JSON.parse(__CADENCE_INITIAL_STORAGE__) as Record<string, unknown>;
  } catch {
    initial = {};
  }

  installPageChrome({ initialStorage: initial });

  if (isTop) {
    document.addEventListener('visibilitychange', reportVisibility);
    window.addEventListener('focus', reportVisibility);
    window.addEventListener('blur', reportVisibility);
    // Report immediately: a tab created in the background and later activated would otherwise be
    // invisible to the registry until its first visibility *change*.
    reportVisibility();
    watchTitle();
  }

  try {
    void contentScript.main();
  } catch (err) {
    console.error('[cadence] collector failed to start', err);
  }
})();
