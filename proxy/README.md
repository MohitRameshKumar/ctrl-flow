# Cadence LLM proxy

A small Cloudflare Worker that forwards `name_spaces` and `assign_tabs` requests to Claude
Haiku 5.5 so the extension never ships an API key. `standup` and `coverage_doc` are stubs
(501) for a later task.

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

## Deploy

```sh
npx wrangler login          # once, opens a browser to authorize
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CADENCE_TOKEN
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

```
POST /task
X-Cadence-Token: <CADENCE_TOKEN>
Content-Type: application/json

{ "task": "name_spaces" | "assign_tabs" | "standup" | "coverage_doc", "input": { ... } }
```

- Unknown `task` → 400
- Missing/wrong `X-Cadence-Token` → 401
- Body over 50 KB → 413
- `standup` / `coverage_doc` → 501 (not implemented yet)
- Model fails to return valid JSON after one retry → 502
