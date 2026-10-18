// PRIV-8: a short history of everything ctrl-flow sent off the device (AI calls, paper lookups, voice
// generation, TigerData syncs), newest first, so "what did it just send?" has an answer even after
// something else was sent a moment later. No imports from the modules that write to it: they all
// import this one.
export type OutboundKind = 'ai' | 'pdf-lookup' | 'cloud-sync' | 'tts';

export interface OutboundEntry {
  ts: number;
  kind: OutboundKind;
  /** One line for the list. */
  summary: string;
  /** The full record, shown when the entry is expanded. */
  detail: unknown;
}

export const OUTBOUND_HISTORY_KEY = 'outboundHistory';
export const OUTBOUND_HISTORY_MAX = 10;

/** Newest first, capped. Pure. */
export function pushEntry(list: OutboundEntry[], entry: OutboundEntry, max = OUTBOUND_HISTORY_MAX): OutboundEntry[] {
  return [entry, ...list].sort((a, b) => b.ts - a.ts).slice(0, max);
}

interface Loose {
  request?: { task?: string };
  status?: number | null;
  error?: string;
  outcome?: string;
  sent?: number;
  inserted?: number;
  chars?: number;
  via?: string;
}

/** The one-line description of a record, per kind. */
export function summarize(kind: OutboundKind, record: unknown): string {
  const r = (record ?? {}) as Loose;
  switch (kind) {
    case 'ai':
      return `AI · ${r.request?.task ?? 'task'}: ${r.error ? 'failed' : `HTTP ${r.status ?? '?'}`}`;
    case 'pdf-lookup':
      return `Paper lookup: ${r.outcome ?? ''}`.trim();
    case 'cloud-sync':
      return `Tiger Data sync: ${r.outcome ?? ''}${typeof r.sent === 'number' ? ` (${r.sent} events)` : ''}`.trim();
    case 'tts':
      return `Read aloud · ${r.via ?? ''}: ${r.outcome ?? ''}${typeof r.chars === 'number' ? ` (${r.chars} chars)` : ''}`.trim();
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Appends one entry. Serialized, so two calls at once cannot overwrite each other. Never throws. */
export function appendOutbound(kind: OutboundKind, record: unknown, ts: number = Date.now()): Promise<void> {
  const run = queue.then(async () => {
    try {
      const { [OUTBOUND_HISTORY_KEY]: stored } = await chrome.storage.local.get<Record<string, OutboundEntry[] | undefined>>(OUTBOUND_HISTORY_KEY);
      const list = Array.isArray(stored) ? stored : [];
      await chrome.storage.local.set({ [OUTBOUND_HISTORY_KEY]: pushEntry(list, { ts, kind, summary: summarize(kind, record), detail: record }) });
    } catch {
      /* the log is a courtesy to the reader; it must never break the call it describes */
    }
  });
  queue = run;
  return run;
}

export async function getOutboundHistory(): Promise<OutboundEntry[]> {
  const { [OUTBOUND_HISTORY_KEY]: stored } = await chrome.storage.local.get<Record<string, OutboundEntry[] | undefined>>(OUTBOUND_HISTORY_KEY);
  return Array.isArray(stored) ? stored : [];
}
