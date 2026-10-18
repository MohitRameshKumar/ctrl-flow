// PRIV-8: everything ctrl-flow sends off the device is recorded where the user can read it. The AI
// proxy has its own record (lib/ai.ts); this one covers the paper lookups, the TigerData sync and
// text to speech. Only the source, a summary of what was sent and the result are kept. No URLs of
// pages, no page content, no synced rows, no spoken text.
import { getLastAiRequest } from './ai';
import type { LookupLog } from './pdf-resolver';

const KEY = 'lastOutboundRequest';

/** The paper lookups this file was originally written for. */
export interface PdfLookupRecord {
  ts: number;
  kind: 'pdf-lookup';
  /** Lookups in the order they ran. */
  lookups: LookupLog[];
  outcome: string;
}

/** A batch pushed to TigerData. A summary only — never the rows themselves. */
export interface CloudSyncRecord {
  ts: number;
  kind: 'cloud-sync';
  /** How many event rows were sent, and how many the server said it stored. */
  sent: number;
  inserted: number;
  /** The span those events cover, as local date-times. */
  from: string;
  to: string;
  /** Exactly which fields left the device, so the viewer can state it rather than promise it. */
  fields: string[];
  outcome: string;
}

/** A standup read aloud. The text is never stored; only its size and where the audio came from. */
export interface TtsRecord {
  ts: number;
  kind: 'tts';
  chars: number;
  /** "cache" means nothing left the device at all. */
  via: 'elevenlabs' | 'cache' | 'browser';
  outcome: string;
}

export type OutboundRecord = PdfLookupRecord | CloudSyncRecord | TtsRecord;

export async function recordOutbound(record: OutboundRecord): Promise<void> {
  await chrome.storage.local.set({ [KEY]: record });
}

export async function getLastOutbound(): Promise<OutboundRecord | null> {
  const { [KEY]: r } = await chrome.storage.local.get<Record<string, OutboundRecord | undefined>>(KEY);
  return r ?? null;
}

export type OutboundVia = 'ai' | OutboundRecord['kind'];

/** The most recent thing that left the device — AI call, paper lookup, cloud sync or TTS. */
export async function getLastOutboundAny(): Promise<{ via: OutboundVia; record: unknown; ts: number } | null> {
  const [ai, other] = await Promise.all([getLastAiRequest(), getLastOutbound()]);
  if (ai && (!other || ai.ts >= other.ts)) return { via: 'ai', record: ai, ts: ai.ts };
  if (other) return { via: other.kind, record: other, ts: other.ts };
  return null;
}
