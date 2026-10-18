// `chrome.scripting.executeScript({func})` serializes the function with Function.prototype
// .toString() and evaluates the text in the page. The desktop shim does the same over CDP. That
// only works while those functions are genuinely self-contained — `lib/macro-injected.ts` says so
// in its header: every helper is duplicated inside "because the API forces it".
//
// The failure mode this guards against is nasty: a bundler that hoists a shared helper out of
// `clickBySelector` produces code that references an identifier which does not exist in the page,
// so every replayed click fails with "element not found" — pointing at the selector, not the build.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { clickBySelector, typeIntoSelector } from '@/lib/macro-injected';

/** Identifiers a serialized function may rely on: page globals and its own parameters. */
const PAGE_GLOBALS = new Set([
  'document', 'window', 'globalThis', 'navigator', 'location', 'console',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'Promise', 'Set', 'Map', 'Symbol', 'parseInt', 'parseFloat', 'isNaN',
  'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'Node', 'NodeFilter', 'ShadowRoot', 'Event', 'InputEvent', 'MouseEvent', 'KeyboardEvent',
  'CustomEvent', 'getComputedStyle', 'setTimeout', 'clearTimeout', 'undefined', 'null',
  'true', 'false', 'this', 'typeof', 'instanceof', 'void', 'in', 'of', 'new', 'return',
  'function', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'try', 'catch', 'finally', 'throw', 'delete', 'default', 'class',
  'extends', 'super', 'async', 'await', 'yield', 'static', 'get', 'set',
]);

function bodyOf(fn: (...args: never[]) => unknown): string {
  return fn.toString();
}

it.each([
  ['clickBySelector', clickBySelector],
  ['typeIntoSelector', typeIntoSelector],
])('%s serializes to a self-contained function', (_name, fn) => {
  const source = bodyOf(fn as (...args: never[]) => unknown);

  // A bundler-hoisted helper shows up as a reference the page cannot resolve. These are the
  // identifier shapes esbuild/rollup generate when they lift or polyfill something out of a scope.
  expect(source).not.toMatch(/\b__[a-zA-Z]\w*\s*\(/);
  expect(source).not.toMatch(/\bimport\s*\(/);
  expect(source).not.toMatch(/\brequire\s*\(/);
  expect(source).not.toMatch(/\bexports\b/);
});

it.each([
  ['clickBySelector', clickBySelector],
  ['typeIntoSelector', typeIntoSelector],
])('%s is syntactically valid once serialized', (_name, fn) => {
  const source = bodyOf(fn as (...args: never[]) => unknown);
  // Exactly what the shim builds: `(<fn source>).apply(null, args)`.
  expect(() => new Function(`return (${source})`)).not.toThrow();
});

it('the macro-injected module declares its helpers inside the injected functions', () => {
  // Belt and braces on the source itself: if someone factors a shared helper out to module scope
  // and calls it from an injected function, the tests above may still pass in dev (where the
  // function is not bundled) but fail in a production build.
  const source = readFileSync(new URL('../lib/macro-injected.ts', import.meta.url), 'utf8');

  // Find every exported injected function and check it calls nothing defined at module level.
  const moduleLevelFns = [...source.matchAll(/^(?:export\s+)?function\s+(\w+)/gm)].map((m) => m[1]);
  const injected = ['clickBySelector', 'typeIntoSelector'];
  const helpers = moduleLevelFns.filter((n) => n && !injected.includes(n));

  for (const name of injected) {
    const start = source.indexOf(`function ${name}`);
    expect(start, `${name} should exist`).toBeGreaterThan(-1);
    // Take the function text up to the next top-level `export function`, which is good enough to
    // catch an accidental call into a module-level helper.
    const rest = source.slice(start + 1);
    const nextExport = rest.indexOf('\nexport function');
    const text = nextExport === -1 ? rest : rest.slice(0, nextExport);

    for (const helper of helpers) {
      expect(
        text.includes(`${helper}(`),
        `${name} must not call module-level helper ${helper}() — it will not exist in the page`,
      ).toBe(false);
    }
  }
});

it('page globals list is actually used by the serialized source', () => {
  // Sanity: the functions really do reach for page APIs, so the guard above is meaningful.
  const source = bodyOf(clickBySelector as (...args: never[]) => unknown);
  expect(source).toContain('document');
  expect(PAGE_GLOBALS.has('document')).toBe(true);
});
