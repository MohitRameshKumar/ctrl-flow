# Ctrl-flow Desktop

A downloadable Win/macOS app that replaces the Chrome extension. It launches the user's real
installed Chrome with a debugging port and drives it over the Chrome DevTools Protocol, so there is
nothing to install in the browser: download, run, done.

## The one idea

**Nothing in `lib/` or `entrypoints/` was rewritten.** Instead `desktop/renderer/chrome-shim/`
provides exactly the `chrome.*` surface the existing code already uses, backed by CDP, Electron and
Node. All 41 modules in `lib/` and all 16 side-panel components run unchanged, and Dexie keeps
working because an Electron renderer *is* Chromium.

That was viable because the codebase already had the seams:

- `lib/macro-executor.ts` holds only replay *rules* behind a `RunHost` interface, and
  `lib/macro-host-chrome.ts` is "the only execution file that touches `chrome.*`"
- `lib/macro-source.ts`: *"A desktop recorder would implement the same two members and the
  detectors in `macro-detection.ts` would not change at all"*
- `entrypoints/background.ts` is `export default defineBackground(...)`, so a three-line global
  shim (`desktop/renderer/wxt-globals.ts`) lets it be imported and run verbatim

## Layout

```
desktop/
  main/           Electron main process
    index.ts        windows, tray, app:// scheme, IPC, the gate scripts
    browser.ts      CDP connection, collector injection, tab operations
    cdp.ts          minimal CDP client (flat sessions over one socket)
    chrome-launcher.ts  browser discovery, flags, DevToolsActivePort
    tab-registry.ts CDP targets -> chrome.tabs semantics (pure, unit-tested)
    overlay.ts      leader overlay window + globalShortcut
    storage.ts      storage.local (disk) + storage.session (memory)
    focus-rule.ts   "is the browser in use" (pure, unit-tested)
  preload/        contextBridge surfaces (index.ts, overlay.ts)
  renderer/
    chrome-shim/    the globalThis.chrome implementation
    main.tsx        boot order: wxt globals -> shim -> bridges -> background -> UI
    DesktopApp.tsx  sidebar shell reusing the existing tab components
    browser-bridge.ts / leader-bridge.ts   CDP <-> shim wiring
    onboarding/     first-run flow
    overlay/        the leader overlay renderer
  injected/       the collector bundle injected into every page (IIFE)
```

## Commands

```bash
npm run build:desktop   # injected collector + main/preload/renderer
npm run dev:desktop     # same, with HMR for the renderer
npm run compile:desktop # tsc --noEmit over desktop/
npm run dist:win        # NSIS installer  -> release/Cadence-Setup.exe
npm run dist:mac        # dmg (arm64+x64) -> release/Cadence-<arch>.dmg
```

The extension still builds unchanged: `npm run build`.

## Verification gates

Each one launches the app for real and prints a pass/fail table. They are the fastest way to know
the port still works after a change.

```bash
node desktop/smoke.mjs      # P0  app, shim, Dexie, settings — with no browser attached
node desktop/p1-smoke.mjs   # P1  real browsing is recorded (clicks prove collector injection)
node desktop/p2-smoke.mjs   # P2  a saved macro replays and really clicks in the page
node desktop/p3-smoke.mjs   # P3  leader key -> native overlay -> runs a macro
node desktop/p4-smoke.mjs   # P4  AI over IPC, Standup, virtual groups   (needs the mock proxy)
node desktop/p5-smoke.mjs   # P5  focus inference does not misfire on Cadence's own window
node desktop/shot.mjs x.png # screenshot the window
```

`p4-smoke.mjs` starts `e2e/mock-proxy.mjs` itself, but the proxy URL is baked in at build time, so
build with it first:

```bash
WXT_PROXY_URL=http://127.0.0.1:4471 WXT_PROXY_TOKEN=test-token npm run build:desktop
```

Plus `npx vitest run` for the pure units (storage shim, tab registry, alarms, virtual groups,
focus rule, injected-function self-containment).

## Decisions worth knowing before changing things

- **The core window is never destroyed and sets `backgroundThrottling: false`.** It runs the
  collector, the alarms and any in-flight replay. Chromium throttles hidden windows' timers by
  default, which would stop alarms and stretch the executor's pacing — only while the window is
  hidden, i.e. exactly during a demo. `index.ts` also logs timer drift so this is visible if it
  ever regresses.
- **The renderer is served from `app://`, never `file://`.** IndexedDB on `file://` has an opaque,
  unstable origin, so Dexie's database can silently vanish between builds.
- **`storage.session` is cleared when *Chrome* exits, not just when the app restarts.**
  `lib/macro-run-channel.ts` relies on the browser clearing it so "a crashed run cannot haunt the
  next session". A leftover `macroReplayInProgress` makes `writeEvent` return early and silently
  stops all recording; a leftover `activeTabsSeeded` leaves the starting tab invisible.
- **`tabs.group` must resolve, never reject.** `lib/spaces.ts`'s `switchToSpace` calls it with no
  try/catch, so a rejection would break switch-to-space entirely. CDP has no tab-groups API, so the
  shim keeps groups itself and `tabGroups.query` answers from that map — which is what makes
  `restoreSpace` and `switchToSpace` take their correct fallback paths unchanged.
- **Injected functions must stay self-contained.** `chrome.scripting.executeScript({func})` is
  implemented with `Function.prototype.toString()`, so the renderer build must not minify or hoist
  helpers out of `lib/macro-injected.ts`. Guarded by
  `tests/desktop-injected-selfcontained.test.ts`.
- **Tab activation has no CDP event.** The injected collector reports `visibilitychange`, deduped
  per window; and whenever *we* activate a tab we record it directly, which is the only thing that
  works for `chrome://` pages where nothing can be injected.
- **Cadence's own window counts as "the browser is in use".** See `focus-rule.ts`.
- **The leader key does not go through `handleLeaderCommand`.** That function chooses between the
  overlay and the side panel using `canHostOverlay(tab.url)`, which exists because content scripts
  cannot run on `chrome://` pages. A native window has no such limit, so `leader-bridge.ts` builds
  the menu with the same `getMenu()` and shows the overlay directly.
