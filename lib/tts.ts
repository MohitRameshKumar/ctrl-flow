/**
 * Reading text aloud, via ElevenLabs with the browser voice as a fallback.
 *
 * The ElevenLabs key lives on the Worker, never in the extension, so generation goes through the
 * same `/task` proxy as everything else and comes back as base64 mp3 (see proxy/src/tasks.ts for
 * why base64 rather than a binary body).
 *
 * Two things make this safe to ship on a free plan. Clips are cached by a hash of their text, so
 * re-reading an unchanged standup costs nothing — which matters when the monthly allowance is
 * about twenty standups. And every failure path, including a 429 when that allowance runs out,
 * falls back to `speechSynthesis`, so "Read aloud" never simply does nothing.
 */
import { runTask } from './ai';
import { getTtsCached, putTtsCached } from './db';
import { recordOutbound } from './outbound-log';

const TIMEOUT_MS = 30000;

/** Mirrors MAX_TTS_CHARS in proxy/src/tasks.ts; trimming here keeps the cache key honest. */
export const MAX_TTS_CHARS = 2000;

export type TtsSource = 'elevenlabs' | 'cache' | 'browser';

export interface SpeakResult {
  via: TtsSource;
  /** Set when the browser voice was used because the cloud voice was unavailable. */
  error?: string;
  /** A later `stop` or `speak` superseded this call, so nothing was played. Callers should
   *  ignore `via`: the user cancelled, and reporting which voice "would have" spoken is noise. */
  cancelled?: boolean;
}

interface TtsResponse {
  audio: string;
  mime: string;
  chars: number;
}

/** The clip currently playing, so `stop` can reach it and the object URL can be revoked. */
let current: { audio: HTMLAudioElement; url: string } | null = null;

/**
 * Bumped by every `stop` and every new `speak`.
 *
 * Generation can take a couple of seconds, and an in-flight fetch cannot be recalled. Without this,
 * pressing Read aloud and then Stop would leave the request running and start playing the moment it
 * came back — after the user had already cancelled it.
 */
let epoch = 0;

/** SHA-256 of the exact text. Any edit, including whitespace, is a different clip. */
export async function ttsCacheKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Stops whatever is playing, from either engine, and releases the object URL. */
export function stop(): void {
  epoch++;
  if (current) {
    current.audio.pause();
    current.audio.src = '';
    URL.revokeObjectURL(current.url);
    current = null;
  }
  globalThis.speechSynthesis?.cancel();
}

function playBrowserVoice(text: string, onEnd: () => void): void {
  const synth = globalThis.speechSynthesis;
  if (!synth) {
    onEnd();
    return;
  }
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onend = onEnd;
  utterance.onerror = onEnd;
  synth.speak(utterance);
}

function playBlob(blob: Blob, onEnd: () => void): void {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  current = { audio, url };
  const finish = () => {
    if (current?.audio === audio) {
      URL.revokeObjectURL(url);
      current = null;
    }
    onEnd();
  };
  audio.onended = finish;
  audio.onerror = finish;
  void audio.play().catch(finish);
}

/**
 * Speaks `text`, resolving once playback has *started* (not finished); `onEnd` fires when it stops.
 *
 * Never rejects: an unreachable proxy, an unconfigured key, an exhausted quota or a decode failure
 * all end with the browser voice speaking and `via: 'browser'` in the result.
 */
export async function speak(text: string, onEnd: () => void = () => {}): Promise<SpeakResult> {
  stop();
  const mine = epoch;
  /** True once a later `stop` or `speak` has superseded this call. */
  const cancelled = () => epoch !== mine;

  const trimmed = text.trim().slice(0, MAX_TTS_CHARS);
  if (trimmed === '') {
    onEnd();
    return { via: 'browser' };
  }

  // Nothing is played and `onEnd` is not fired: the caller that cancelled has already reset its
  // own state, and firing the end callback now would fight with it.
  const fallback = (error: string): SpeakResult => {
    if (cancelled()) return { via: 'browser', error, cancelled: true };
    playBrowserVoice(trimmed, onEnd);
    return { via: 'browser', error };
  };

  let hash: string;
  try {
    hash = await ttsCacheKey(trimmed);
  } catch (err) {
    return fallback(String(err));
  }

  const cached = await getTtsCached(hash).catch(() => undefined);
  if (cancelled()) return { via: 'cache', cancelled: true };
  if (cached) {
    playBlob(cached.blob, onEnd);
    // Logged even though nothing left the device: a reader checking "what did this just send?"
    // deserves the answer "nothing, it was cached" rather than a stale entry from last time.
    await recordOutbound({ ts: Date.now(), kind: 'tts', chars: trimmed.length, via: 'cache', outcome: 'played from cache' });
    return { via: 'cache' };
  }

  const result = await runTask<TtsResponse>('tts', { text: trimmed }, TIMEOUT_MS, { record: false });

  if (!result.ok) {
    const reason = result.status === 429 ? 'monthly voice quota reached' : result.error;
    await recordOutbound({ ts: Date.now(), kind: 'tts', chars: trimmed.length, via: 'browser', outcome: `failed: ${reason}` });
    return fallback(reason);
  }

  let blob: Blob;
  try {
    blob = base64ToBlob(result.data.audio, result.data.mime || 'audio/mpeg');
  } catch (err) {
    await recordOutbound({ ts: Date.now(), kind: 'tts', chars: trimmed.length, via: 'browser', outcome: 'failed: bad audio' });
    return fallback(String(err));
  }

  // Cache even when cancelled — the credits are already spent, so keep what they bought.
  await putTtsCached(hash, blob).catch(() => {});
  if (cancelled()) return { via: 'elevenlabs', cancelled: true };
  playBlob(blob, onEnd);
  await recordOutbound({
    ts: Date.now(),
    kind: 'tts',
    chars: trimmed.length,
    via: 'elevenlabs',
    outcome: `generated ${Math.round(blob.size / 1024)} KB of audio`,
  });
  return { via: 'elevenlabs' };
}
