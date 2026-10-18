/**
 * The core renderer: Cadence's one and only context.
 *
 * It is both the UI *and* what the extension calls the background service worker. That collapse is
 * deliberate. In the extension, `runMacro` is called from the side panel (`MacrosTab.tsx`,
 * `MacroOfferBanner.tsx`) *and* from the worker (`leader.ts`, `macros.ts`), and
 * `lib/macro-replay.ts`'s single-run guard is only per-context — the cross-context case is papered
 * over with `chrome.storage.session` plus a staleness check. Running everything in one renderer
 * makes that guard genuinely authoritative, and means the UI can keep importing `runMacro`
 * directly instead of becoming an RPC client.
 *
 * Boot order matters and is not interchangeable:
 *   1. WXT globals, so `entrypoints/background.ts` can be imported verbatim.
 *   2. The `chrome` shim, awaited — it primes the storage mirror.
 *   3. The AI fetch patch.
 *   4. Only then may anything from `@/lib` be imported, which is why these are dynamic imports:
 *      a static import would be hoisted above the shim installation and some module could touch
 *      `chrome` at evaluation time.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installWxtGlobals } from './wxt-globals';
import { installChromeShim } from './chrome-shim';
import { installAiFetch } from './ai-fetch';
import { installBrowserBridge } from './browser-bridge';
import { installLeaderBridge } from './leader-bridge';
import './desktop.css';

/** Boot progress, readable from the main process. Drives the P0 smoke test. */
const status: Record<string, unknown> = { stage: 'starting', errors: [] as string[] };
(window as unknown as Record<string, unknown>).__cadenceBoot = status;

function note(stage: string): void {
  status.stage = stage;
  status[stage] = true;
}

window.addEventListener('error', (e) => (status.errors as string[]).push(String(e.message)));
window.addEventListener('unhandledrejection', (e) =>
  (status.errors as string[]).push(String((e as PromiseRejectionEvent).reason)),
);

async function boot(): Promise<void> {
  const native = window.cadenceNative;

  // Before the shim primes anything: an empty local store means this is a genuine first run, which
  // is what `runtime.onInstalled` means to `background.ts` (it seeds defaults from it).
  const existing = await native.storage.get('local', null);
  const firstRun = Object.keys(existing).length === 0;

  installWxtGlobals();
  note('wxtGlobals');

  const shim = await installChromeShim(native);
  note('chromeShim');

  installAiFetch(native);

  // Routes chrome.tabs/scripting to CDP, and CDP events back into the shim's emitters.
  installBrowserBridge(native, shim);
  note('browserBridge');

  // Must come after the browser bridge: it decorates that backend's sendMessage.
  installLeaderBridge(native, shim);
  note('leaderBridge');

  (window as unknown as Record<string, unknown>).__cadenceShim = shim;

  // The background module registers all its listeners synchronously inside main().
  const background = (await import('@/entrypoints/background')).default;
  try {
    await background.main();
    note('backgroundMain');
  } catch (err) {
    console.error('[cadence] background main failed', err);
    (status.errors as string[]).push(`background: ${String(err)}`);
  }

  // Lifecycle fires after listeners exist, otherwise onInstalled/onStartup would be missed.
  shim.fireLifecycle(firstRun);

  const App = (await import('./DesktopApp')).default;
  const root = document.getElementById('root');
  if (!root) throw new Error('no #root');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  note('mounted');

  /**
   * Launch the browser Cadence drives.
   *
   * Deferred until after the UI is mounted so a slow Chrome start never delays first paint, and so
   * a failure (no Chrome installed, port refused) lands in a rendered app that can explain itself
   * rather than a blank window. Skipped in smoke mode, which must not spawn a browser.
   */
  const params = new URLSearchParams(location.search);
  if (params.get('smoke') !== '1' && params.get('noBrowser') !== '1') {
    const settings = await native.storage.get('local', ['focusFlipEnabled']);
    void native.browser.launch(settings).then((s) => {
      if (s.state === 'error') console.error('[cadence] browser launch failed', s.error);
    });
  }

  // Test modes only (see the query the main process appends): hand the already-loaded modules to
  // the checker, which runs via executeJavaScript and so cannot resolve bundle specifiers.
  if (params.get('expose') === '1') {
    status.modules = {
      db: (await import('@/lib/db')).db,
      settings: await import('@/lib/settings'),
      privacy: await import('@/lib/privacy'),
      macros: await import('@/lib/macros'),
      leader: await import('@/lib/leader'),
      ai: await import('@/lib/ai'),
      standup: await import('@/lib/standup'),
      spaces: await import('@/lib/spaces'),
    };
  }
}

void boot().catch((err) => {
  console.error('[cadence] boot failed', err);
  const root = document.getElementById('root');
  if (root) {
    root.textContent = `Cadence failed to start: ${String(err)}`;
  }
});
