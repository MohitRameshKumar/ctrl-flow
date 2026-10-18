/**
 * One-way mirror of activity metadata into TigerData (Tiger Cloud Postgres).
 *
 * Dexie stays the source of truth. Nothing here reads from the cloud on a hot path, nothing blocks
 * on the network, and the feature is off until the user turns it on — the app works exactly as
 * before with this disabled.
 *
 * PRIV: only `ts`, `kind`, `domain` and `title` ever leave the device. URLs, CSS selectors, click
 * labels and form field names are dropped in `toRow` and never reach the request body, and the
 * destination table has no columns for them. Events are already blocklist-filtered on the way into
 * Dexie (entrypoints/background.ts), so anything the user excluded was never stored to begin with.
 */
import { runTask } from './ai';
import { db } from './db';
import { recordOutbound } from './outbound-log';
import { getCloudSyncEnabled } from './settings';
import type { CadenceEvent } from './types';

const DEVICE_ID_KEY = 'deviceId';
const STATE_KEY = 'cloudSyncState';
const TIMEOUT_MS = 20000;

/**
 * Longest title sent. The server's own sanitiser caps at 200; this tighter cap is what makes the
 * batch size arithmetic below deterministic, since the title is the only unbounded field.
 */
export const MAX_TITLE_CHARS = 120;

/**
 * Rows per request. A row with a maximum-length title and a long domain serialises to roughly
 * 260 bytes, so 150 rows stay near 40 KB against the Worker's 50 KB body cap
 * (MAX_BODY_BYTES in proxy/src/index.ts). The server caps at 300 rows independently.
 */
export const SYNC_BATCH_SIZE = 150;

/** Batches per run, so a first sync over a large history catches up without one unbounded loop. */
const MAX_BATCHES_PER_RUN = 8;

/** Exactly what is sent. Mirrored by `activity_events` in TigerData; see proxy/src/db.ts. */
export interface ActivityRow {
  localId: number;
  ts: number;
  kind: string;
  domain: string;
  title: string;
}

export interface CloudSyncState {
  /** Highest Dexie `events.id` already sent. Only ever moves forward. */
  lastSyncedEventId: number;
  lastSyncAt: number | null;
  totalSynced: number;
  lastError: string | null;
}

const EMPTY_STATE: CloudSyncState = {
  lastSyncedEventId: 0,
  lastSyncAt: null,
  totalSynced: 0,
  lastError: null,
};

export type SyncOutcome =
  | { ok: true; sent: number; inserted: number; skipped: boolean }
  | { ok: false; error: string };

/** A stable anonymous id for this install. Not a user account: no email, no name, no login. */
export async function getDeviceId(): Promise<string> {
  const { [DEVICE_ID_KEY]: existing } = await chrome.storage.local.get<Record<string, string | undefined>>(
    DEVICE_ID_KEY,
  );
  if (typeof existing === 'string' && existing !== '') return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
  return id;
}

export async function getCloudSyncState(): Promise<CloudSyncState> {
  const { [STATE_KEY]: state } = await chrome.storage.local.get<Record<string, Partial<CloudSyncState> | undefined>>(
    STATE_KEY,
  );
  return { ...EMPTY_STATE, ...(state ?? {}) };
}

async function setCloudSyncState(patch: Partial<CloudSyncState>): Promise<CloudSyncState> {
  const next = { ...(await getCloudSyncState()), ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

/** Resets the high-water mark so the next sync re-sends from the start. Inserts are idempotent. */
export async function resetCloudSyncState(): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: EMPTY_STATE });
}

/**
 * Narrows a stored event to the four fields the hypertable accepts.
 *
 * Returns null for rows that must not be mirrored: synthetic events (written by the debug page's
 * "Simulate") would pollute a real time-series, and a row with no id cannot take part in the
 * high-water mark.
 */
export function toRow(event: CadenceEvent): ActivityRow | null {
  if (event.synthetic === true) return null;
  if (typeof event.id !== 'number') return null;
  return {
    localId: event.id,
    ts: event.ts,
    kind: event.kind,
    domain: event.domain ?? '',
    title: (event.title ?? '').slice(0, MAX_TITLE_CHARS),
  };
}

/** The field names that leave the device, for the outbound log to state plainly. */
export const SYNCED_FIELDS = ['ts', 'kind', 'domain', 'title'] as const;

function isoOrEmpty(ts: number | undefined): string {
  return typeof ts === 'number' && ts > 0 ? new Date(ts).toISOString() : '';
}

/**
 * Pushes everything recorded since the last run.
 *
 * Call this *before* the retention purge: the purge deletes events past the user's retention
 * window, and anything deleted before it syncs is simply never sent, since the high-water mark
 * only moves forward. Failure is non-fatal — the mark does not advance, so the next run retries
 * the same batch, and the primary key on (device_id, local_id, ts) makes that a no-op server-side
 * if the write actually landed.
 */
export async function syncEvents(): Promise<SyncOutcome> {
  if (!(await getCloudSyncEnabled())) return { ok: true, sent: 0, inserted: 0, skipped: true };

  const deviceId = await getDeviceId();
  let { lastSyncedEventId } = await getCloudSyncState();
  let sent = 0;
  let inserted = 0;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    const events = await db.events.where('id').above(lastSyncedEventId).limit(SYNC_BATCH_SIZE).toArray();
    if (events.length === 0) break;

    // The mark advances past every row we looked at, including ones `toRow` rejected — otherwise a
    // run of synthetic events at the head would stall the sync forever.
    const highestId = events.reduce((max, e) => Math.max(max, e.id ?? 0), lastSyncedEventId);
    const rows = events.flatMap((e) => {
      const row = toRow(e);
      return row ? [row] : [];
    });

    if (rows.length > 0) {
      const result = await runTask<{ inserted: number; received: number }>(
        'sync_events',
        { deviceId, events: rows },
        TIMEOUT_MS,
        { record: false },
      );

      if (!result.ok) {
        await setCloudSyncState({ lastError: result.error });
        await recordOutbound({
          ts: Date.now(),
          kind: 'cloud-sync',
          sent: rows.length,
          inserted: 0,
          from: isoOrEmpty(rows[0]?.ts),
          to: isoOrEmpty(rows[rows.length - 1]?.ts),
          fields: [...SYNCED_FIELDS],
          outcome: `failed: ${result.error}`,
        });
        return { ok: false, error: result.error };
      }

      sent += rows.length;
      inserted += result.data?.inserted ?? 0;
      firstTs ??= rows[0]?.ts;
      lastTs = rows[rows.length - 1]?.ts;
    }

    lastSyncedEventId = highestId;
    await setCloudSyncState({ lastSyncedEventId });
    if (events.length < SYNC_BATCH_SIZE) break;
  }

  const state = await setCloudSyncState({
    lastSyncAt: Date.now(),
    lastError: null,
    totalSynced: (await getCloudSyncState()).totalSynced + inserted,
  });

  if (sent > 0) {
    await recordOutbound({
      ts: state.lastSyncAt ?? Date.now(),
      kind: 'cloud-sync',
      sent,
      inserted,
      from: isoOrEmpty(firstTs),
      to: isoOrEmpty(lastTs),
      fields: [...SYNCED_FIELDS],
      outcome: `stored ${inserted} of ${sent}`,
    });
  }

  return { ok: true, sent, inserted, skipped: false };
}

export interface DailyStat {
  day: string;
  kind: string;
  events: number;
}

export interface ActivityStats {
  days: DailyStat[];
  topDomains: { domain: string; events: number }[];
  total: number;
}

/** Reads the TigerData continuous aggregate back for the Settings panel. */
export async function fetchActivityStats(days = 14): Promise<{ ok: true; stats: ActivityStats } | { ok: false; error: string }> {
  const deviceId = await getDeviceId();
  const result = await runTask<ActivityStats>('activity_stats', { deviceId, days }, TIMEOUT_MS, { record: false });
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    stats: {
      days: result.data?.days ?? [],
      topDomains: result.data?.topDomains ?? [],
      total: result.data?.total ?? 0,
    },
  };
}
