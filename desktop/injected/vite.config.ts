import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Builds the injected collector as one self-contained IIFE.
 *
 * Separate from the electron-vite build because this output is not a module anyone imports at
 * runtime — it is a *string* that gets handed to CDP's `Page.addScriptToEvaluateOnNewDocument`. It
 * must therefore have no imports, no exports, and no module wrapper of any kind.
 *
 * `defineContentScript` is provided as a global here (rather than importing WXT) so
 * `entrypoints/content.ts` compiles unchanged — it is a WXT auto-import in the extension build.
 */
export default defineConfig({
  root,
  resolve: {
    alias: { '@': root, '~': root },
  },
  define: {
    // `content.ts` is wrapped in defineContentScript(); the IIFE only needs the definition object.
    defineContentScript: '((d) => d)',
  },
  build: {
    target: 'esnext',
    outDir: resolve(root, 'out/injected'),
    emptyOutDir: true,
    // Readability over bytes: this script is injected into every page, but more importantly it is
    // the thing to read when debugging why an event was or was not recorded.
    minify: false,
    lib: {
      entry: resolve(root, 'desktop/injected/entry.ts'),
      formats: ['iife'],
      name: 'CadenceCollector',
      fileName: () => 'collector.js',
    },
  },
});
