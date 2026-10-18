# ctrl-flow proxy

A small Cloudflare Worker that holds every API key the extension must never ship. It forwards
`name_spaces`, `assign_tabs`, `standup` and `coverage_doc` to an LLM, speaks text with ElevenLabs
(`tts`), and reads and writes the TigerData activity mirror (`sync_events`, `activity_stats`).

## Setup

```sh
cd proxy
npm install
```

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in real values (this file is gitignored):

```sh
cp .dev.vars.example .dev.vars
```

Then run:

```sh
npm run dev
```

This starts the Worker locally (default `http://localhost:8787`) using the secrets from
`.dev.vars`.

## Configure CORS

Edit `wrangler.jsonc` → `vars.ALLOWED_ORIGIN` to your extension's exact origin, e.g.
`chrome-extension://likggcapbkekeffagciamplbcmcobfcd`. Get the ID from `chrome://extensions`
(developer mode on) once the extension is loaded, or compute it from the public key the same
way `scripts/gen-key.sh` does in the extension repo.

## TigerData (Tiger Cloud Postgres)

Optional. Leave it unconfigured and `sync_events` / `activity_stats` return 501; the extension
treats that as "cloud history is unavailable" and carries on.

**1. Create a service.** A free Tiger Cloud service is enough: 750 MB, no credit card, and the
full TimescaleDB extension. Note that it goes **read-only** past 750 MB.

**2. Create the schema.** Run this once in the Tiger Cloud SQL console:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE activity_events (
  device_id uuid        NOT NULL,
  local_id  bigint      NOT NULL,   -- the client's Dexie events.id, for idempotent re-sync
  ts        timestamptz NOT NULL,
  kind      text        NOT NULL,
  domain    text,
  title     text,
  PRIMARY KEY (device_id, local_id, ts)   -- a hypertable PK must include the partition column
);

SELECT create_hypertable('activity_events', by_range('ts'));

CREATE MATERIALIZED VIEW activity_daily
WITH (timescaledb.continuous) AS
SELECT device_id, time_bucket('1 day', ts) AS day, kind, domain, count(*) AS events
FROM activity_events
GROUP BY device_id, day, kind, domain;

SELECT add_continuous_aggregate_policy('activity_daily',
  start_offset      => INTERVAL '7 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

-- Keeps the service under the free tier's 750 MB cap with no app-side code.
SELECT add_retention_policy('activity_events', INTERVAL '90 days');
```

`activity_daily` is a real-time aggregate (`materialized_only` defaults to false), so rows newer
than `end_offset` are unioned in at query time and today's activity appears immediately.

**3. Put Hyperdrive in front of it.**

```sh
npx wrangler hyperdrive create cadence-tiger --connection-string="postgres://..."
```

Paste the printed id into `wrangler.jsonc` → `hyperdrive[0].id`.

This is not optional tuning. A free Tiger service pins `max_connections` to 25 and reserves 17 of
them, leaving **8**; a Worker opening its own connection per request would exhaust that quickly.
Hyperdrive pools on the edge and is free on the Workers free plan (100k queries/day).

## ElevenLabs

Optional. Without `ELEVENLABS_API_KEY` the `tts` task returns 501 and the extension falls back to
the browser's built-in voice.

Model and voice live in `wrangler.jsonc` → `vars`, next to the LLM model IDs. The default is
`eleven_flash_v2_5`, which bills at half a credit per character instead of one — on the free plan
that is 20k characters a month rather than 10k. A standup is 500–1500 characters, so the free plan
covers roughly twenty uncached reads a month; the extension caches clips by a hash of their text,
so re-reading an unchanged standup costs nothing.

Free-plan audio carries **no commercial rights** and requires attribution when shared.

## Deploy

```sh
npx wrangler login          # once, opens a browser to authorize
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CADENCE_TOKEN
npx wrangler secret put ELEVENLABS_API_KEY   # optional; tts returns 501 without it
npm run deploy
```

`wrangler deploy` prints the Worker's URL (`https://cadence-proxy.<your-subdomain>.workers.dev`).
Put that URL and the same `CADENCE_TOKEN` value into the extension's `.env` file as
`WXT_PROXY_URL` and `WXT_PROXY_TOKEN` (see the repo root `.env.example`).

## Tail logs (debugging)

```sh
npm run tail
```

Streams live logs from the deployed Worker — useful for diagnosing CORS, 401s, or model
failures without redeploying.

## Endpoint

One route. Dispatch is by the `task` field in the body, not by path.

```
POST /task
X-Cadence-Token: <CADENCE_TOKEN>
Content-Type: application/json

{ "task": "<name>", "input": { ... } }
```

| Task | Input | Success response |
| --- | --- | --- |
| `name_spaces` | `{ urls, edges?, typed? }` | `[{ name, urls }]` |
| `assign_tabs` | `{ urls, existingSpaces, context?, edges?, typed? }` | `[{ url, spaceName, newSpaceName }]` |
| `standup` | `{ range, spaces?, pages?, typing?, github?, meetings?, today? }` | `{ yesterday, today, blockers }` |
| `coverage_doc` | `{ range, recurringMeetings?, rituals?, spaces?, weeklyDuties? }` | `{ markdown }` |
| `sync_events` | `{ deviceId, events: [{ localId, ts, kind, domain, title }] }` | `{ inserted, received }` |
| `activity_stats` | `{ deviceId, days? }` | `{ days, topDomains, total }` |
| `tts` | `{ text }` | `{ audio, mime, chars }` |

`tts` returns **base64 in JSON**, not a binary body: `index.ts` wraps every reply in
`JSON.stringify`, and the desktop app re-wraps the main-process result as `application/json`
(`desktop/renderer/ai-fetch.ts`). Base64 is what lets audio ride the existing client path unchanged.

Status codes:

- Unknown `task` → 400
- Missing/wrong `X-Cadence-Token` → 401
- Body over 50 KB → 413
- `tts` without `ELEVENLABS_API_KEY`, or a database task without the Hyperdrive binding → 501
- `tts` when the ElevenLabs monthly quota is exhausted → 429 (the client falls back to the browser voice)
- Model fails to return valid JSON after one retry, or a database error → 502
