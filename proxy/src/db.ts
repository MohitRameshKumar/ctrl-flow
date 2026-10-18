/**
 * TigerData (Tiger Cloud) Postgres access for the Worker.
 *
 * Reached through a Cloudflare Hyperdrive binding, not a direct connection string. That is not
 * decoration: a free Tiger service pins `max_connections` to 25 and reserves 17 of them, leaving 8.
 * A Worker opening its own connection per request would exhaust that under any real traffic, so
 * Hyperdrive pools on the edge and the Worker only ever borrows.
 *
 * The table is a TimescaleDB hypertable with a continuous aggregate over it; see proxy/README.md
 * for the one-time DDL.
 */
import { Client } from 'pg';

export interface PgEnv {
  /** Hyperdrive binding in front of the Tiger Cloud service. Absent when the DB is not configured. */
  HYPERDRIVE?: Hyperdrive;
}

/** One synced browsing event. Deliberately no URL, selector, label or field name — see lib/cloud-sync.ts. */
export interface ActivityRow {
  localId: number;
  /** Epoch milliseconds. */
  ts: number;
  kind: string;
  domain: string;
  title: string;
}

export interface DailyStat {
  day: string;
  kind: string;
  events: number;
}

export interface StatsResult {
  days: DailyStat[];
  topDomains: { domain: string; events: number }[];
  total: number;
}

export class DbNotConfiguredError extends Error {
  constructor() {
    super('HYPERDRIVE binding is not configured');
  }
}

/**
 * Runs `fn` with a connected client. The close is handed to `waitUntil` rather than awaited so the
 * response goes out without waiting on the socket teardown.
 */
async function withClient<T>(env: PgEnv, ctx: ExecutionContext, fn: (client: Client) => Promise<T>): Promise<T> {
  if (!env.HYPERDRIVE) throw new DbNotConfiguredError();
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    ctx.waitUntil(client.end());
  }
}

/**
 * Appends a batch of events for one device.
 *
 * `unnest` keeps the parameter count at six no matter how many rows are in the batch, and the
 * hypertable's primary key (device_id, local_id, ts) makes the insert idempotent — re-syncing a
 * range that already landed inserts nothing instead of duplicating it.
 */
export async function insertEvents(
  env: PgEnv,
  ctx: ExecutionContext,
  deviceId: string,
  rows: ActivityRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  return withClient(env, ctx, async (client) => {
    const result = await client.query(
      `INSERT INTO activity_events (device_id, local_id, ts, kind, domain, title)
       SELECT $1::uuid, * FROM unnest(
         $2::bigint[], $3::timestamptz[], $4::text[], $5::text[], $6::text[]
       )
       ON CONFLICT DO NOTHING`,
      [
        deviceId,
        rows.map((r) => r.localId),
        rows.map((r) => new Date(r.ts).toISOString()),
        rows.map((r) => r.kind),
        rows.map((r) => r.domain),
        rows.map((r) => r.title),
      ],
    );
    return result.rowCount ?? 0;
  });
}

/**
 * Reads the continuous aggregate for one device.
 *
 * `activity_daily` is a real-time aggregate (materialized_only is false by default), so rows newer
 * than the refresh policy's end_offset are unioned in at query time and today's activity shows up
 * immediately rather than after the next refresh.
 */
export async function queryStats(
  env: PgEnv,
  ctx: ExecutionContext,
  deviceId: string,
  days: number,
): Promise<StatsResult> {
  return withClient(env, ctx, async (client) => {
    const [daily, domains, total] = await Promise.all([
      client.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, kind, sum(events)::bigint AS events
         FROM activity_daily
         WHERE device_id = $1::uuid AND day >= now() - make_interval(days => $2::int)
         GROUP BY day, kind
         ORDER BY day`,
        [deviceId, days],
      ),
      client.query(
        `SELECT domain, sum(events)::bigint AS events
         FROM activity_daily
         WHERE device_id = $1::uuid AND day >= now() - make_interval(days => $2::int) AND domain <> ''
         GROUP BY domain
         ORDER BY events DESC
         LIMIT 8`,
        [deviceId, days],
      ),
      client.query(`SELECT count(*)::bigint AS total FROM activity_events WHERE device_id = $1::uuid`, [deviceId]),
    ]);

    // pg returns bigint as a string to avoid precision loss; these counts are far below 2^53.
    return {
      days: daily.rows.map((r) => ({ day: String(r.day), kind: String(r.kind), events: Number(r.events) })),
      topDomains: domains.rows.map((r) => ({ domain: String(r.domain), events: Number(r.events) })),
      total: Number(total.rows[0]?.total ?? 0),
    };
  });
}
