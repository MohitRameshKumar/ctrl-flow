// PRIV-8: everything ctrl-flow sends off the device is recorded where the user can read it. The AI
// proxy has its own record (lib/ai.ts); this one covers the paper lookups. Only the lookup source,
// what was sent (the selected title) and the result are kept. No URLs of pages, no page content.
import { getLastAiRequest } from './ai';
import type { LookupLog } from './pdf-resolver';

const KEY = 'lastOutboundRequest';

export interface OutboundRecord {
  ts: number;
  kind: 'pdf-lookup';
  /** Lookups in the order they ran. */
  lookups: LookupLog[];
  outcome: string;
}

export async function recordOutbound(record: OutboundRecord): Promise<void> {
  await chrome.storage.local.set({ [KEY]: record });
}

export async function getLastOutbound(): Promise<OutboundRecord | null> {
  const { [KEY]: r } = await chrome.storage.local.get<Record<string, OutboundRecord | undefined>>(KEY);
  return r ?? null;
}

/** The most recent thing that left the device, AI call or paper lookup, for "Last outbound request". */
export async function getLastOutboundAny(): Promise<{ via: 'ai' | 'pdf-lookup'; record: unknown; ts: number } | null> {
  const [ai, lookup] = await Promise.all([getLastAiRequest(), getLastOutbound()]);
  if (ai && (!lookup || ai.ts >= lookup.ts)) return { via: 'ai', record: ai, ts: ai.ts };
  if (lookup) return { via: 'pdf-lookup', record: lookup, ts: lookup.ts };
  return null;
}
