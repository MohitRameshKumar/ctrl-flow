// PRIV-8: everything ctrl-flow sends off the device is recorded where the user can read it. The AI
// proxy has its own record (lib/ai.ts); this one covers the paper lookups, the TigerData sync and
// text to speech. Each call is also added to the 10-entry history (lib/outbound-history.ts). Only the
// source, a summary of what was sent and the result are kept: no URLs of pages, no page content, no
// synced rows. The one exception is read-aloud: the standup text the user chose to have spoken is
// shown, cut to 300 characters with its full length noted.
import { getLastAiRequest } from './ai';
import { appendOutbound } from './outbound-history';
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

/** Longest stretch of the spoken text kept in the log. */
export const TTS_LOG_TEXT_CHARS = 300;

/** A standup read aloud: what was sent (cut for display), its full length, and where the audio came from. */
export interface TtsRecord {
  ts: number;
  kind: 'tts';
  /** Full length of the text, in characters. */
  chars: number;
  /** The text sent to ElevenLabs, cut to TTS_LOG_TEXT_CHARS. Absent when nothing was sent (played from cache). */
  text?: string;
  /** True when `text` is shorter than the full text. */
  truncated?: boolean;
  /** "cache" means nothing left the device at all. */
  via: 'elevenlabs' | 'cache' | 'browser';
  outcome: string;
}

export type OutboundRecord = PdfLookupRecord | CloudSyncRecord | TtsRecord;

/** The `text` / `truncated` fields for a TTS record. Pure. */
export function ttsText(text: string): { text: string; truncated: boolean } {
  return text.length > TTS_LOG_TEXT_CHARS ? { text: text.slice(0, TTS_LOG_TEXT_CHARS), truncated: true } : { text, truncated: false };
}

export async function recordOutbound(record: OutboundRecord): Promise<void> {
  await chrome.storage.local.set({ [KEY]: record });
  await appendOutbound(record.kind, record, record.ts);
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
