# Cadence Testing Report

## Progress
- [x] Step 1: Re-run collector.spec.ts
- [x] Step 2: Full suite twice (+ no-test-hooks check); re-run twice more after harness edits
- [x] Step 3: `playwright.live.config.ts` (skips cleanly with no env vars)
- [x] Step 4: README "Testing" section
- [x] Step 5: Final report + manual checklist
- [x] Final verification (tsc, normal build, hook-leak check, git scope)

## 1. Summary
The automated suite is green and stable: two consecutive full runs of 24 tests gave 23 passed, 0 failed, 1 skipped, and the hooks-leak check passes on the production build. The one skip is the OS app-switch test: the OS focus does change, but Playwright-launched Chromium never emits `chrome.windows.onFocusChanged`, so the focus-lost/gained events can only be verified by hand. Collector, privacy, side panel, rituals, Auto Project Spaces, persistence, and the notification router work against the **mock** proxy and the **Demo** calendar. Nothing has been tested against the real deployed proxy (the opt-in live suite exists and skips until `WXT_PROXY_URL`/`WXT_PROXY_TOKEN` are set), Google OAuth is not set up, Standup and Coverage Doc are not built, and Repeat-to-Macro was cut. No product bugs were found by the tests, but see section 5 for caveats.

## 2. Results table
Per-file counts are from the full-suite output (identical in every run).

| Spec file | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|
| collector.spec.ts | 5 | 4 | 0 | 1 |
| persistence.spec.ts | 1 | 1 | 0 | 0 |
| privacy.spec.ts | 4 | 4 | 0 | 0 |
| rituals.spec.ts | 5 | 5 | 0 | 0 |
| sidepanel.spec.ts | 3 | 3 | 0 | 0 |
| spaces.spec.ts | 6 | 6 | 0 | 0 |
| **Total** | **24** | **23** | **0** | **1** |

Full-suite runs (`npm run test:e2e`: production build, hook-leak check, test build, playwright, 1 worker):

| Run | When | Passed | Failed | Skipped | Playwright time | hook-leak check |
|---|---|---|---|---|---|---|
| 1 | before harness type fixes | 23 | 0 | 1 | 58.7s | PASS |
| 2 | before harness type fixes | 23 | 0 | 1 | 58.7s | PASS |
| 3 | after harness fixes (final) | 23 | 0 | 1 | 56.8s | PASS |
| 4 | after harness fixes (final, consecutive) | 23 | 0 | 1 | 58.7s | PASS |

Other: `collector.spec.ts` alone: 4 passed, 1 skipped (27.5s). `npm run test:e2e:live` with no env vars: 4 skipped, exit clean. The live specs run against the *mock* proxy (sanity check of the assertions only): 4 passed. `npx tsc --noEmit`: 0 errors. Normal `npm run build` succeeds, and `check-no-test-hooks` passes on it.

Note: the prior session reported `collector.spec.ts` as 6 tests; it actually has 5.

## 3. Capability status

| Capability | Status | Evidence | Known gaps |
|---|---|---|---|
| Event collector (all 9 event kinds) | Partially works | 8/9 kinds asserted: `tab_opened`, `tab_activated`, `tab_closed`, `navigated`, `click` (collector.spec); `typing_burst` x4 field types incl. iframe (collector.spec); `field_changed` (privacy.spec); query/fragment stripped (collector.spec) | `chrome_focus_lost`/`chrome_focus_gained`: test skipped (env limit). Handler code (background.ts:231) reads correct but is unverified in a real browser. |
| Typing counts-only | Works | collector "typing…" test (`keyCount > 0`); privacy "secret typed… never appears in any table" | — |
| Privacy blocklist / pause / incognito | Partially works | privacy: blocklisted domain logs 0 events; paused writes 0 events | Incognito is only a manifest setting (`incognito: 'not_allowed'` in wxt.config.ts); not exercised. Manual item 3. |
| "Last AI request" viewer | Works | privacy "lastAiRequest… only url/title-shaped data" | Viewer UI (debug.html) not asserted; data shape is. |
| Side panel | Works | sidepanel: four tabs render; event count updates; pause toggle writes flag | — |
| Pre-Meeting Ritual | Partially works | rituals: recurring meeting detected w/ right URLs, `occurrences = 2`, status `suggested`; trigger alarm + notification button opens tab group named after ritual; "Never" stops alarms; "Auto" opens immediately; removed doc stays removed | Not tested: Accept / Not now statuses, the "Test now" button, negative cases of the learning rule (1 occurrence, non-matching docs), whether a notification actually displays. |
| Auto Project Spaces | Partially works | spaces: mock-AI named spaces appear in UI; AI failure -> domain fallback marked offline; rename + moved tab survive recompute; Shelve -> named tab group, Restore; switch offer after demo threshold + throttle blocks repeat; Close-and-save keeps recently-typed tab | Not tested: pinned and always-open exclusions in Close-and-save; real-AI naming quality; the 30s/10min real (non-demo) timings. |
| Notification router prefixes | Works (indirect) | Ritual prefix exercised in rituals tests, space prefix in the switch-offer / spaces tests, both via `callNotificationButtonClicked` | No dedicated test for an unknown prefix. Real notification UI untested. |
| Persistence across worker restart | Partially works | persistence: data survives closing and relaunching the context on the same profile; new events still log | Test restarts the whole browser context, not a service-worker-only termination. Rituals/spaces rows covered only indirectly by the manual item 7. |
| Dexie schema v1–v3 intact | Works (indirect) | `lib/db.ts` declares versions 1, 2, 3; every test opens the DB and reads/writes all tables via the hooks | No upgrade-from-v1 data migration test. |
| AI proxy | Mock-tested; live-untested | All space tests use `e2e/mock-proxy.mjs` (token check, 413 on >50KB, 501 for standup/coverage_doc, injected failure). `e2e/live/proxy.live.ts` ready (name_spaces, assign_tabs, 401, 501) | Real proxy never run; skips cleanly. `proxy/` itself has no unit tests. |
| Calendar | Demo works; Google OAuth not set up | Rituals use the seeded Demo calendar | Google OAuth path untested (not configured). |
| Standup | Not built | Proxy returns 501 (asserted in live spec, validated against mock) | — |
| Coverage Doc | Not built | Same | — |
| Repeat-to-Macro | Cut | — | — |

## 4. Failures and fixes

| # | Failure | Diagnosis | Class | Resolution |
|---|---|---|---|---|
| 1 | collector OS-focus test: `chrome_focus_lost` not found | (a) Test re-activated `"Google Chrome"`, i.e. the user's real browser, not the Playwright Chromium. Fixed to activate by PID. (b) Still failed: `osascript` works and the frontmost app genuinely changed (`Google Chrome for Testing` -> `Finder`), but a raw `chrome.windows.onFocusChanged` listener in the service worker received nothing. Product handler is correct. | (a) test bug; (b) environment limit | `test.skip` with reason; added to manual checklist |
| 2 | `tsc --noEmit` errors in `e2e/helpers.ts:32` (`string \| undefined`) and `e2e/spaces.spec.ts:212` (unused `@ts-expect-error`) | Type-only | test bug | Fixed (`?? ''`, directive removed). Full suite re-run twice after. |

No flaky or cross-file failures observed in four consecutive full runs.

## 5. Product bugs found
None confirmed by the tests. Items for Person A to be aware of (not bugs, but not verified):
- `chrome_focus_lost` / `chrome_focus_gained` handler (entrypoints/background.ts:231) could not be verified in automation; check it in real Chrome (manual item 2).
- `incognito: 'not_allowed'` (wxt.config.ts:20) is the only incognito protection; verify manually.

## 6. Skipped tests and why
- `collector.spec.ts:134` "switching to another macOS app and back logs chrome_focus_lost then chrome_focus_gained": Playwright-launched Chromium does not emit `chrome.windows.onFocusChanged` on OS app switches, even though the OS frontmost app changes. Environment limit. Manual checklist item 2.
- `e2e/live/proxy.live.ts` (4 tests): skip by design unless `WXT_PROXY_URL` and `WXT_PROXY_TOKEN` are set.

## 7. What automation cannot cover
- Real Chrome profile (branded Chrome ignores `--load-extension` in automation; Playwright Chromium has a different profile, no sign-in, no real extension install flow).
- Real notification UI (tests call the click handler directly and capture `notifications.create` args).
- OS focus (see section 6).
- Deployed proxy (live suite is ready, unrun) including real model output quality and latency.
- Google OAuth calendar.
- Speech.
- Incognito behavior, `chrome://extensions` error panel, "Status code: 15" permission failures.

## 8. Files changed (per `git status`/`git diff`)
Prior session (uncommitted, as far as git shows):
- `entrypoints/background.ts` (alarm handler extracted to `handleAlarm`; installs test hooks when `WXT_TEST=1`)
- `lib/calendar.ts` (+5 lines: test-only `setDemoCalendarEvents`)
- `lib/test-hooks.ts` (new), `package.json`, `package-lock.json`
- `playwright.config.ts`, `e2e/` (specs, helpers, mock-proxy, fixtures-server, check-no-test-hooks, fixtures/)

This session:
- `e2e/collector.spec.ts` (focus test: PID-based activation, then `test.skip` with reason)
- `e2e/helpers.ts`, `e2e/spaces.spec.ts` (type fixes)
- `playwright.live.config.ts` (new), `e2e/live/proxy.live.ts` (new; `.live.ts` suffix so the default config ignores it)
- `README.md` (Testing section), `TESTING_REPORT.md` (new)
- Deleted the generated `test-results/` directory. `package.json` was not changed (the `test:e2e:live` script already existed).

Scope notes: `wxt.config.ts` is unchanged (empty `git diff`). **`lib/calendar.ts` has an uncommitted +5-line diff from the prior session** (test seeding hook, needed by `lib/test-hooks.ts`). It was not touched this session, but it overlaps with the teammate-owned file and will need coordinating on merge. `entrypoints/background.ts` is likewise modified outside the "allowed" list (prior session). Neither was changed or reverted here.

## 9. Manual test checklist (real Chrome)
Setup: `npm run build`, `chrome://extensions` -> Developer mode -> Load unpacked -> `.output/chrome-mv3`. For proxy-dependent items use a build with `WXT_PROXY_URL`/`WXT_PROXY_TOKEN` set to the deployed proxy.

1. **Load and health**
   - Load unpacked. Click "service worker" under the extension to inspect it.
   - **Expected:** no errors on the extension card; worker console has no red errors; the `events` table in IndexedDB (Application tab) gains rows as you browse.
   - **Warning:** "Service worker registration failed. Status code: 15" means a missing/invalid permission in the manifest; fix the manifest and reload.
2. **Collector**
   - Open, switch between, and close several tabs; navigate to a page; click a button; alt-tab to another app and back; type in a text field.
   - **Expected:** `tab_opened`, `tab_activated`, `tab_closed`, `navigated`, `click` rows with url/title; URLs have no query string or fragment; **`chrome_focus_lost` then `chrome_focus_gained`** appear when leaving/returning to Chrome (this replaces the skipped test); typing produces `typing_burst` rows with only `keyCount`, no text.
3. **Privacy**
   - Type `cadence-secret-123` in a password field and in a normal field, blur both, then export the data JSON and search it. **Expected:** 0 matches.
   - Visit a blocklisted banking/health site. **Expected:** no events recorded for it.
   - Turn on Pause, browse. **Expected:** nothing recorded; resume and recording returns.
   - Open an incognito window (extension not allowed in incognito). **Expected:** nothing recorded.
   - Open "Last AI request". **Expected:** only titles, URLs, and domains; no typed text, no keystrokes.
4. **Pre-Meeting Ritual (demo mode)**
   - With Demo calendar and demo mode on, open the same 2 docs around 2 "Team sync" occurrences (or seed accordingly).
   - **Expected:** the Rituals tab lists the ritual as *suggested* with those docs.
   - Press **Test now**. **Expected:** a notification appears; clicking "Open docs" opens a tab group named after the meeting.
   - Try **Accept**, **Not now**, **Never**. **Expected:** status updates each time; after Never no further notifications; a doc removed from the ritual stays removed after refresh.
5. **Auto Project Spaces** (needs deployed proxy; without it, check the domain fallback)
   - **Expected:** spaces get human names (without proxy: domain-based names marked offline).
   - Stay 30s in a different space's tab. **Expected:** a switch offer; it does not repeat within 10 min for the same pair.
   - **Shelve** a space. **Expected:** its tabs collapse into a named group; **Restore** brings them back.
   - **Close and save.** **Expected:** pinned tabs, always-open tabs, and recently-typed-in tabs are not closed.
   - Rename a space, refresh the panel. **Expected:** the name sticks.
6. **Proxy** (`$URL`, `$TOKEN` = deployed values)
   - `curl -i -X POST $URL/task -H 'Content-Type: application/json' -d '{"task":"name_spaces","input":{"urls":[]}}'` (no token). **Expected:** 401/403.
   - POST a body larger than 50 KB with a valid token. **Expected:** 413.
   - POST `{"task":"standup","input":{}}` with a valid token. **Expected:** 501.
   - Or run `WXT_PROXY_URL=... WXT_PROXY_TOKEN=... npm run test:e2e:live`.
7. **Persistence**
   - Quit Chrome fully and reopen it. **Expected:** rituals, spaces, renames, and shelved groups' records are still present; new events still log.
8. **Pre-demo smoke run** (6 steps, in demo order)
   1. Load unpacked fresh; **check:** no errors, worker alive.
   2. Browse a few docs; **check:** event count climbs in the side panel.
   3. Show privacy: Pause toggle + "Last AI request"; **check:** no content, only titles/URLs/domains.
   4. Rituals tab -> **Test now**; **check:** notification -> "Open docs" -> named tab group.
   5. Spaces tab: named spaces, then switch offer after 30s; **check:** Shelve + Restore work, rename sticks.
   6. Restart Chrome; **check:** everything persisted. Have the offline domain-fallback ready in case the proxy/network is down.

## Addendum: proxy deployed (2026-10-17)
- Deployed: https://cadence-proxy.cadence-dubhacks.workers.dev (`ALLOWED_ORIGIN=chrome-extension://likggcapbkekeffagciamplbcmcobfcd`).
- curl: no/wrong token 401; body >50KB 413; `standup` 501; `name_spaces` (NYT + Google Doc on ocean warming, 2 Discord tabs) 200 with two correctly grouped spaces. CORS preflight allows only the extension origin. The Worker does not reject a non-browser request with a wrong `Origin` (token is the real guard).
- `npm run test:e2e`: 23 passed, 0 failed, 1 skipped (58.7s). `npm run test:e2e:live` (real proxy): 4 passed, 0 failed, 0 skipped (3.3s). So AI proxy is now live-tested.

## Addendum 2: Spaces co-usage, switch offer, ritual simulation (2026-10-17)

### Diagnosis
- **A. Spaces not grouped.** The model only ever received URL + title. Live proxy, same 4-tab fixture (2 articles, "Untitled document", 1 unrelated), titles only: `["AI and LLM reading" (2 articles), "Cooking"]`, i.e. the doc was left out. With co-usage edges: all three in one space. Second cause: tabs already sitting in `auto_offline` domain spaces were never re-eligible, and after first run only `assign_tabs` (unassigned tabs only) ran, so a working proxy could not regroup them.
- **B. Switch offer.** Reproduced by `spaces.spec.ts` "…activated before the 5-minute window" (failed before the fix): dwell was computed only from `tab_activated` events in the trailing 5 minutes, so a tab sat on longer than that (typing notes) had dwell 0. Fixed by also reading the last activation before the window. The panel-open path (banner in side panel) was previously untestable; it is now tested by stubbing `chrome.runtime.getContexts`.
- **C. Rituals.** Demo "Team sync" occurs every 3h from local midnight (past occurrences exist after 03:00 today), but detection needs the same docs opened within -15/+5 min of both of the last two occurrences, so it only appears if you happen to have the same tabs open at two consecutive 3-hour marks. Before 03:00 there is only one past occurrence, so it can never appear. Debug-page simulation added.

### Changes
- `lib/co-usage.ts` (new, pure): pair stats (direct switches within 10 min, "near" within 90 s), edges capped at 60, typing-burst counts per tab index, context picker, offline union-find merge.
- `lib/spaces.ts`: sends `edges`/`typed` (and `context` for `assign_tabs`); candidates capped at 150, titles at 120 chars; auto-offline spaces are regrouped by AI when it succeeds; offline fallback merges tabs with >=3 direct switches across domains.
- `proxy/src/tasks.ts`: prompts make co-usage the primary signal; edges/typed/context validated and capped. **Redeployed.**
- `lib/db.ts`: renaming a space now sets `status: 'user'` (protects it from regrouping); `lib/types.ts`: optional `programmatic` / `synthetic` event fields. No Dexie schema change (v1-v3 untouched, extra fields are unindexed).
- `lib/programmatic.ts` + `background.ts`/`spaces.ts`/`rituals.ts`: tab activations caused by Cadence (restore, open ritual docs) are flagged and ignored by switch detection and co-usage.
- `lib/ritual-simulation.ts` + debug page: "Simulate 2 past Team syncs" / "Wipe simulated data". Real detection thresholds unchanged. It writes via `setDemoCalendarEvents` (exported from `lib/calendar.ts`; that file is not modified).
- Tests: `e2e/unit/co-usage.spec.ts` (9), `e2e/spaces-usage.spec.ts` (6), `e2e/rituals-sim.spec.ts` (1), regression test in `spaces.spec.ts` (1), co-usage live test (1). Mock proxy honors edges and has `/__mock/last`.

### Results
- `npm run test:e2e`: 41 tests = 40 passed, 0 failed, 1 skipped (OS focus), 1.2m, on three consecutive runs after the last change. check-no-test-hooks: PASS each time.
- `npm run test:e2e:live` (deployed proxy): 5 passed, 0 failed (ran 3 times).
- `tsc` (app and proxy): 0 errors.

### Failures seen and fixed this session (all test bugs)
- `spaces-usage` "programmatic" test failed in full suite only: the earlier panel-open test left `chrome.runtime.getContexts` stubbed in the shared worker. Now restored.
- `rituals.spec.ts` "opens a tab group" failed ~1 run in 20 on the new tab's URL (empty/pending/error page while loading unreachable `docs.google.com`). Origin now stubbed and the URL polled.

### Not covered
- Real notification display; the real Chrome side-panel surface (stubbed); the 30 s dwell with real clocks; AI output varies between calls (e.g. one live run left the recipe tab unassigned, which the prompt allows).
- Programmatic-flag coverage is by seeded events; the actual Restore/ritual flow setting the flag was not asserted end to end.

## Addendum 3: Focus Flip (2026-10-17)
Opt-in (off by default) flipping between a writing tab and a reference tab. Files: `lib/flip-learning.ts` (pure learning), `lib/focus-flip.ts` (runtime), `lib/programmatic.ts` (tab-aware Cadence-initiated marks), `entrypoints/content.ts` (throttled counts-only pulses, inert unless enabled), `entrypoints/sidepanel/components/FocusFlipSection.tsx`, Dexie **v4** `flipPairs` (v1–v3 untouched).
- Tests: `e2e/unit/flip-learning.spec.ts` (10), `e2e/focus-flip.spec.ts` (11). Negative control: removing the "skip the switch offer for programmatic activations" guard makes the Spaces test fail.
- `npm run test:e2e` x2 (consecutive): 62 tests, 61 passed, 0 failed, 1 skipped (OS focus), 5.0m each; hook-leak check PASS. `test:e2e:live`: 5 passed. `tsc`: 0 errors.
- Not covered by automation: the real "Chrome not focused" check (`chrome.windows.getLastFocused().focused`; e2e uses a test probe), real Docs/NYT pages, service-worker sleep during a long (up to 60 s) flip (mitigated by keep-alive pings plus a `chrome.alarms` backup; not exercised).
- Toggling off mid-flip cancels the pending return and leaves you on the reference tab (it does not switch back).
