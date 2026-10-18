/**
 * Routes the AI proxy call through the main process, with zero edits to `lib/ai.ts`.
 *
 * `lib/ai.ts` does a plain `fetch(`${proxyUrl}/task`, ...)` with an `X-Cadence-Token` header. From a
 * renderer that is a cross-origin request with a custom header, so the browser would preflight it,
 * and `proxy/src/index.ts` only ever echoes its configured `ALLOWED_ORIGIN` (the extension's) back —
 * so the renderer would be refused.
 *
 * The proxy does **not** validate the request's Origin; it authenticates on the token header alone.
 * So a Node-side fetch from the main process, which sends no Origin and is not subject to CORS,
 * works against the already-deployed Worker with no proxy changes at all. Patching `fetch` here is
 * what keeps `lib/ai.ts` untouched.
 */

import type { CadenceNative } from '../preload';

export function installAiFetch(native: CadenceNative): void {
  const proxyUrl = import.meta.env.WXT_PROXY_URL;
  if (!proxyUrl) return; // Not configured; lib/ai.ts reports that itself.

  let proxyOrigin: string;
  try {
    proxyOrigin = new URL(proxyUrl).origin;
  } catch {
    return;
  }

  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    let isProxy = false;
    try {
      isProxy = new URL(url, location.origin).origin === proxyOrigin;
    } catch {
      isProxy = false;
    }
    if (!isProxy) return realFetch(input, init);

    const headers = new Headers(init?.headers ?? {});
    const token = headers.get('X-Cadence-Token') ?? '';
    const body = typeof init?.body === 'string' ? init.body : '';

    // `lib/ai.ts` owns its own AbortController and 15s timeout; mirror it so a hung request there
    // still settles, and so the main-process fetch cannot outlive the caller's expectations.
    const result = await native.ai.fetch({ url, token, body, timeoutMs: 20_000 });

    if (result.status === null) {
      throw new Error(result.error ?? 'network error');
    }

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
