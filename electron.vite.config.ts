import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const root = __dirname;

/**
 * The desktop build.
 *
 * Three things here are load-bearing rather than stylistic:
 *
 * - `@` aliases to the repo root, exactly as `.wxt/tsconfig.json` does for the extension. That is
 *   what lets `desktop/` import `@/lib/*` and `@/entrypoints/sidepanel/*` with no file moves.
 * - `envPrefix` includes `WXT_` so `lib/ai.ts`'s `import.meta.env.WXT_PROXY_URL` keeps resolving
 *   from the existing `.env`. Without it the AI tasks silently fall back to their offline paths.
 * - `target: 'esnext'` with no identifier mangling for the renderer. `lib/macro-injected.ts` is
 *   serialized with `Function.prototype.toString()` and injected into pages, so its functions must
 *   stay self-contained — a bundler that hoists a helper out of them breaks every replayed click.
 */
const sharedResolve = {
  alias: {
    '@': root,
    '~': root,
  },
};

export default defineConfig({
  main: {
    resolve: sharedResolve,
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'desktop/main/index.ts') },
      },
    },
  },
  preload: {
    resolve: sharedResolve,
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'desktop/preload/index.ts'),
          // The leader overlay window gets its own minimal bridge.
          overlay: resolve(root, 'desktop/preload/overlay.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(root, 'desktop/renderer'),
    resolve: sharedResolve,
    envDir: root,
    envPrefix: ['VITE_', 'WXT_'],
    // The extension's static assets, so `chrome.runtime.getURL('/demo-calendar.json')` resolves
    // against the renderer origin in both dev and production.
    publicDir: resolve(root, 'public'),
    plugins: [react()],
    build: {
      target: 'esnext',
      // Keep injected functions intact — see the note above.
      minify: false,
      rollupOptions: {
        input: {
          index: resolve(root, 'desktop/renderer/index.html'),
          debug: resolve(root, 'desktop/renderer/debug.html'),
          overlay: resolve(root, 'desktop/renderer/overlay/index.html'),
        },
      },
    },
  },
});
