# WXT + React

This template should help get you started developing with React in WXT.

## Testing

End-to-end tests drive the real extension in Playwright's bundled Chromium, against a mock AI proxy and a local fixtures server.

**Prerequisites:** Node 20+, `npm install`, then `npx playwright install chromium`. Tests open a visible browser window (extensions need headed mode).

```bash
npm run test:e2e        # production build + hook-leak check + test build + full suite
npm run test:e2e:live   # opt-in: real deployed proxy only
```

`test:e2e:live` needs `WXT_PROXY_URL` and `WXT_PROXY_TOKEN` in the environment. If either is missing, all live tests skip with a message (it does not fail). The token is never printed.

**`WXT_TEST=1`** (set only by `npm run build:test`) installs `globalThis.__cadenceTest` in the service worker: table reads/seeding, alarm firing, and notification-click simulation. Normal builds strip it entirely; `e2e/check-no-test-hooks.mjs` greps the production output for the marker and fails if it is found (it runs first in `test:e2e`).

**Why not branded Chrome?** Google Chrome no longer honors `--load-extension` in automation, so the suite uses Playwright's bundled Chromium. Behaviors that need real Chrome (OS focus, real notification UI, Google OAuth) are in the manual checklist.

`npm run test:e2e` now includes Focus Flip tests that wait on real timers (about 5 minutes for the whole suite).

Results, capability status, and the manual checklist: [`TESTING_REPORT.md`](./TESTING_REPORT.md).
