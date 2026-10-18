/// <reference types="vite/client" />

/**
 * The `WXT_`-prefixed variables `lib/ai.ts` reads.
 *
 * `electron.vite.config.ts` sets `envPrefix: ['VITE_', 'WXT_']` so these come from the same `.env`
 * the extension build uses — which is why `lib/ai.ts` needs no changes.
 */
interface ImportMetaEnv {
  readonly WXT_PROXY_URL?: string;
  readonly WXT_PROXY_TOKEN?: string;
  readonly WXT_TEST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
