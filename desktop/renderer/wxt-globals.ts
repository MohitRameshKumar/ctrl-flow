/**
 * WXT's auto-imported entrypoint wrappers, as plain globals.
 *
 * WXT injects `defineBackground` and `defineContentScript` into every entrypoint without an import
 * statement. The desktop build has no WXT in it, so these have to exist on `globalThis` before
 * `entrypoints/background.ts` is imported.
 *
 * This is what lets `background.ts` be reused **verbatim** — no fork, no edits. It is
 * `export default defineBackground(() => { ... })`, and WXT's wrapper just returns `{ main }`, so
 * the core renderer can import the module and call `.main()`.
 */

export interface BackgroundDefinition {
  main: () => void | Promise<void>;
}

export interface ContentScriptDefinition {
  matches?: string[];
  allFrames?: boolean;
  runAt?: string;
  /** WXT passes extra manifest keys through; only `main` matters to the desktop build. */
  [key: string]: unknown;
  main: (ctx?: unknown) => void | Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var defineBackground: (arg: (() => void) | BackgroundDefinition) => BackgroundDefinition;
  // eslint-disable-next-line no-var
  var defineContentScript: (definition: ContentScriptDefinition) => ContentScriptDefinition;
}

export function installWxtGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;

  g.defineBackground = (arg: (() => void) | BackgroundDefinition): BackgroundDefinition =>
    typeof arg === 'function' ? { main: arg } : arg;

  g.defineContentScript = (definition: ContentScriptDefinition): ContentScriptDefinition =>
    definition;
}
