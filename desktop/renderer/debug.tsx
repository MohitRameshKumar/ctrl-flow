/**
 * The debug page, in its own window.
 *
 * Reachable from Settings → "Open debug page", which calls `chrome.runtime.getURL('/debug.html')`.
 * It deliberately does **not** boot `entrypoints/background.ts`: that belongs to the core renderer
 * alone, and running a second copy would double every alarm and every collector listener. This
 * window only needs storage and Dexie, both of which work from any renderer on this origin.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installWxtGlobals } from './wxt-globals';
import { installChromeShim } from './chrome-shim';
import '@/entrypoints/debug/style.css';

async function boot(): Promise<void> {
  installWxtGlobals();
  await installChromeShim(window.cadenceNative);

  const App = (await import('@/entrypoints/debug/App')).default;
  const root = document.getElementById('root');
  if (!root) throw new Error('no #root');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot().catch((err) => {
  console.error('[cadence] debug boot failed', err);
});
