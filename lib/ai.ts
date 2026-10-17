import type { TaskName } from './types';

const TIMEOUT_MS = 15000;
const LAST_AI_REQUEST_KEY = 'lastAiRequest';

export interface LastAiRequestRecord {
  ts: number;
  request: { task: TaskName; input: unknown };
  status: number | null;
  response: unknown;
  error?: string;
}

export type RunTaskResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Calls the Cloudflare Worker proxy. Never sends an API key — the proxy holds that.
 * Always records the exact request/response in chrome.storage.local for the privacy
 * viewer in Settings, whether the call succeeds or fails.
 */
export async function runTask<T = unknown>(
  task: TaskName,
  input: unknown,
  timeoutMs: number = TIMEOUT_MS,
): Promise<RunTaskResult<T>> {
  const proxyUrl = import.meta.env.WXT_PROXY_URL;
  const token = import.meta.env.WXT_PROXY_TOKEN;

  const record: LastAiRequestRecord = {
    ts: Date.now(),
    request: { task, input },
    status: null,
    response: null,
  };

  if (!proxyUrl || !token) {
    record.error = 'WXT_PROXY_URL / WXT_PROXY_TOKEN not configured (see .env.example)';
    await chrome.storage.local.set({ [LAST_AI_REQUEST_KEY]: record });
    return { ok: false, error: record.error };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${proxyUrl}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': token },
      body: JSON.stringify({ task, input }),
      signal: controller.signal,
    });

    record.status = res.status;
    const body = await res.json().catch(() => null);
    record.response = body;
    await chrome.storage.local.set({ [LAST_AI_REQUEST_KEY]: record });

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: body as T };
  } catch (err) {
    record.error = String(err);
    await chrome.storage.local.set({ [LAST_AI_REQUEST_KEY]: record });
    return { ok: false, error: record.error };
  } finally {
    clearTimeout(timer);
  }
}

export async function getLastAiRequest(): Promise<LastAiRequestRecord | null> {
  const { [LAST_AI_REQUEST_KEY]: record } =
    await chrome.storage.local.get<Record<string, LastAiRequestRecord | undefined>>(LAST_AI_REQUEST_KEY);
  return record ?? null;
}
