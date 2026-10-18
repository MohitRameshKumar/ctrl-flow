/**
 * Electron main process.
 *
 * Owns: the single long-lived "core" renderer that runs all of Cadence's logic, the `app://` scheme
 * it is served from, the tray, and every native capability the `chrome.*` shim needs.
 *
 * Two decisions here are correctness-critical, not preferences:
 *
 * 1. **The core window is never destroyed and never background-throttled.** It runs the collector,
 *    the alarms, and any in-flight macro replay, so if Chromium throttles its timers (which it does
 *    for hidden or occluded windows by default) then alarms stop firing, the executor's `sleep()`
 *    pacing stretches to minutes, and the run-command poll that implements Stop dies â€” all only
 *    while the window is hidden, which is exactly when a demo is happening.
 *
 * 2. **The renderer is served from `app://`, never `file://`.** IndexedDB on `file://` has an
 *    opaque, unstable origin, so Dexie's database can silently vanish between builds â€” taking the
 *    entire "Cadence learned your routines" premise with it. A registered standard scheme also
 *    lets `fetch(chrome.runtime.getURL('/demo-calendar.json'))` work.
 */

import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  ipcMain,
  nativeImage,
  protocol,
  shell,
} from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INVOKE,
  OVERLAY,
  PUSH,
  type AiFetchRequest,
  type AiFetchResponse,
  type BadgeState,
  type StorageArea,
  type ToastOptions,
} from '../shared/ipc';
import * as store from './storage';
import { BrowserController } from './browser';
import {
  handleOverlayMessage,
  hideOverlay,
  overlayIsOpen,
  registerShortcuts,
  unregisterShortcuts,
  resizeOverlay,
  setOverlayMessageHandler,
  showOverlay,
  showOverlayNotice,
  showOverlayPreview,
} from './overlay';


const APP_SCHEME = 'app';
const APP_HOST = 'cadence';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** `package.json` is `"type": "module"`, so this bundle is ESM and has no `__dirname`. */
const here = dirname(fileURLToPath(import.meta.url));

/** Registered before `app.ready`, which is the only time this call is honored. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Belt and braces alongside the per-window `backgroundThrottling: false`.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let coreWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

/** Live notifications by Cadence id, so `chrome.notifications.clear(id)` can find them. */
const liveToasts = new Map<string, Notification>();

const browser = new BrowserController();

/** What `chrome.commands.getAll()` reports — the bindings that actually registered. */
let registeredCommands: { name: string; shortcut: string; description: string }[] = [];

/* ------------------------------------------------------------------ *
 * app:// static file serving
 * ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function rendererRoot(): string {
  // Packaged: resources/app.asar/out/renderer. Unpackaged dev build: <repo>/out/renderer.
  return join(app.getAppPath(), 'out', 'renderer');
}

function registerAppProtocol(): void {
  const root = rendererRoot();
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // Contain the path inside the renderer root â€” never serve outside it.
    const target = normalize(join(root, pathname));
    if (!target.startsWith(resolvePath(root))) {
      return new Response('forbidden', { status: 403 });
    }

    const file = existsSync(target) ? target : join(root, 'index.html');
    try {
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      return new Response(new Uint8Array(body), {
        headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' },
      });
    } catch (err) {
      console.error('[cadence] app:// read failed', file, err);
      return new Response('not found', { status: 404 });
    }
  });
}

/* ------------------------------------------------------------------ *
 * The core window
 * ------------------------------------------------------------------ */

function createCoreWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'Cadence',
    backgroundColor: '#11131a',
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // See the header: throttling this renderer breaks alarms and replay pacing.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Clicking Cadence must not read as "the user left the browser"; see setCadenceFocused.
  win.on('focus', () => browser.setCadenceFocused(true));
  win.on('blur', () => browser.setCadenceFocused(false));

  // Hide instead of close. The collector and any running macro live in this renderer.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Cadence's own pages open in-app; anything else is a real link and belongs in the browser.
    if (url.startsWith(APP_ORIGIN)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[cadence] core renderer gone', details);
    if (!quitting) win.reload();
  });

  // The smoke flag rides on the URL so the renderer can see it without shipping any test code
  // that is reachable in a normal launch.
  // `expose` hands the P1 checker the already-loaded modules; `smoke` additionally suppresses the
  // browser launch, since the P0 gate is specifically "works with no browser attached".
  const needsModules =
    process.env.CADENCE_P1 ||
    process.env.CADENCE_P2 ||
    process.env.CADENCE_P3 ||
    process.env.CADENCE_P4 ||
    process.env.CADENCE_P5;
  const query = process.env.CADENCE_SMOKE ? '?smoke=1&expose=1' : needsModules ? '?expose=1' : '';
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(`${devUrl}${query}`);
  else void win.loadURL(`${APP_ORIGIN}/index.html${query}`);

  return win;
}

export function getCoreWindow(): BrowserWindow | null {
  return coreWindow;
}

export function showCoreWindow(): void {
  if (!coreWindow) return;
  if (coreWindow.isMinimized()) coreWindow.restore();
  coreWindow.show();
  coreWindow.focus();
}

/* ------------------------------------------------------------------ *
 * Tray
 * ------------------------------------------------------------------ */

function trayIcon(): Electron.NativeImage {
  const candidates = [
    join(rendererRoot(), 'icon', '32.png'),
    join(app.getAppPath(), 'public', 'icon', '32.png'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const image = nativeImage.createFromPath(path);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip('Cadence');
  rebuildTrayMenu();
  tray.on('click', showCoreWindow);
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Cadence', click: showCoreWindow },
      { type: 'separator' },
      {
        label: 'Quit Cadence',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/** `chrome.action.setBadgeText` / `setTitle` land here. */
function applyBadge(state: BadgeState): void {
  if (!tray) return;
  const text = state.text?.trim();
  tray.setToolTip(state.title ? `Cadence â€” ${state.title}` : 'Cadence');
  if (process.platform === 'darwin') {
    app.dock?.setBadge(text ?? '');
  } else if (coreWindow) {
    // Windows has no text badge; the overlay icon is the closest equivalent.
    coreWindow.setOverlayIcon(text ? trayIcon() : null, text ?? '');
  }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

function registerIpc(): void {
  ipcMain.handle(INVOKE.storageGet, (_e, area: StorageArea, keys: string | string[] | null) =>
    store.get(area, keys),
  );
  ipcMain.handle(INVOKE.storageSet, (_e, area: StorageArea, items: Record<string, unknown>) => {
    store.set(area, items);
  });
  ipcMain.handle(INVOKE.storageRemove, (_e, area: StorageArea, keys: string | string[]) => {
    store.remove(area, keys);
  });
  ipcMain.handle(INVOKE.storageClear, (_e, area: StorageArea) => {
    store.clear(area);
  });

  ipcMain.handle(INVOKE.windowShow, () => {
    showCoreWindow();
  });
  ipcMain.handle(
    INVOKE.windowIsVisible,
    () => !!coreWindow && coreWindow.isVisible() && !coreWindow.isMinimized(),
  );

  ipcMain.handle(INVOKE.badgeSet, (_e, state: BadgeState) => {
    applyBadge(state);
  });

  /**
   * Notifications.
   *
   * P0 uses the OS notification so nothing throws. This gets replaced by Cadence's own
   * always-on-top toast window in P3, and that is a design decision rather than a nicety:
   * Electron's `Notification.actions` is **macOS-only**, and notification buttons are the accept
   * path for macro offers, ritual offers, space-switch offers and the Leader-R confirm. On Windows
   * they would simply be dead. `lib/notifications.ts` already funnels every button click through
   * one prefix router, so a custom window serves all four features identically on both OSes.
   */
  ipcMain.handle(INVOKE.toastCreate, (_e, id: string, options: ToastOptions) => {
    const existing = liveToasts.get(id);
    if (existing) existing.close();
    const toast = new Notification({
      title: options.title,
      body: options.message,
      silent: true,
    });
    toast.on('click', () => {
      broadcast(PUSH.toastClicked, id);
      showCoreWindow();
    });
    toast.on('close', () => liveToasts.delete(id));
    liveToasts.set(id, toast);
    toast.show();
  });

  ipcMain.handle(INVOKE.toastClear, (_e, id: string) => {
    liveToasts.get(id)?.close();
    liveToasts.delete(id);
  });

  ipcMain.handle(INVOKE.commandsGetAll, () => registeredCommands);

  ipcMain.handle(INVOKE.platformInfo, () => ({
    os: process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux',
    arch: process.arch,
  }));

  ipcMain.handle(INVOKE.appPaths, () => ({
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
  }));

  /* ---- browser control ---- */

  ipcMain.handle(INVOKE.browserLaunch, (_e, settings: Record<string, unknown>) =>
    browser.launch({ initialSettings: settings }),
  );
  ipcMain.handle(INVOKE.browserStatus, () => browser.getStatus());
  ipcMain.handle(INVOKE.browserShutdown, () => browser.shutdown());

  ipcMain.handle(INVOKE.tabsQuery, (_e, info: Record<string, unknown>) => browser.registry.query(info));
  ipcMain.handle(INVOKE.tabsGet, (_e, tabId: number) => browser.registry.get(tabId));
  ipcMain.handle(INVOKE.tabsCreate, (_e, props: { url?: string; active?: boolean }) =>
    browser.createTab(props),
  );
  ipcMain.handle(
    INVOKE.tabsUpdate,
    async (_e, tabId: number, props: { active?: boolean; url?: string }) => {
      // `autoDiscardable` has no CDP equivalent; it is only ever a hint, and `macro-host-chrome.ts`
      // already treats a failure as non-fatal.
      if (props.active) await browser.activateTab(tabId);
      return browser.registry.get(tabId);
    },
  );
  ipcMain.handle(INVOKE.tabsRemove, (_e, tabIds: number[]) => browser.closeTabs(tabIds));
  ipcMain.handle(INVOKE.tabsReload, (_e, tabId: number) => browser.reloadTab(tabId));
  ipcMain.handle(
    INVOKE.tabsExecuteScript,
    (_e, args: { tabId: number; allFrames: boolean; source: string }) => browser.executeScript(args),
  );

  ipcMain.handle(INVOKE.windowsFocus, (_e, windowId: number) => browser.focusWindow(windowId));
  ipcMain.handle(INVOKE.windowsLastFocused, () => browser.lastFocusedWindow());

  /* ---- leader overlay ---- */

  // The core renderer builds the menu (via lib/leader.ts) and hands it over to be displayed.
  ipcMain.handle(INVOKE.overlayShow, (_e, payload: unknown) => showOverlay(payload));
  ipcMain.handle(INVOKE.overlayPreview, (_e, payload: { text: string; runnable: boolean }) =>
    showOverlayPreview(payload),
  );
  ipcMain.handle(INVOKE.overlayNotice, (_e, text: string) => showOverlayNotice(text));
  ipcMain.handle(INVOKE.overlayHide, () => hideOverlay());

  // From the overlay window itself.
  ipcMain.on(OVERLAY.message, (_e, message: unknown) => handleOverlayMessage(message));
  ipcMain.on(OVERLAY.close, () => hideOverlay());
  ipcMain.on(OVERLAY.resize, (_e, height: number) => resizeOverlay(height));

  /**
   * The AI proxy call, made from Node rather than the renderer.
   *
   * `proxy/src/index.ts` authenticates on the `X-Cadence-Token` header alone and only ever echoes
   * its configured `ALLOWED_ORIGIN` back in response headers â€” it never reads the request's Origin.
   * So a main-process fetch (which sends no Origin and is not subject to CORS) works against the
   * deployed Worker with no proxy changes at all.
   */
  ipcMain.handle(INVOKE.aiFetch, async (_e, req: AiFetchRequest): Promise<AiFetchResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cadence-Token': req.token },
        body: req.body,
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch (err) {
      return { status: null, body: null, error: String(err) };
    } finally {
      clearTimeout(timer);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Timer-drift watchdog
 * ------------------------------------------------------------------ */

/**
 * Logs when the main process's own timers slip badly.
 *
 * Cheap insurance against the single highest-ranked risk in this port: if throttling ever does take
 * hold, the symptom in the UI is "alarms stopped and macros feel stuck", which is miserable to
 * diagnose live. A drift line in the log names it immediately.
 */
function watchTimerDrift(): void {
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const drift = now - last - 1000;
    if (drift > 1500) console.warn(`[cadence] main timer drift ${drift}ms`);
    last = now;
  }, 1000);
}

/* ------------------------------------------------------------------ *
 * P0 smoke checks
 * ------------------------------------------------------------------ */

/**
 * Interrogates the core renderer and prints a machine-readable verdict.
 *
 * Lives here rather than in the renderer so no test code ships in the production bundle â€” the same
 * discipline `e2e/check-no-test-hooks.mjs` enforces for the extension. Driven by `desktop/smoke.mjs`.
 */
async function runSmokeChecks(win: BrowserWindow): Promise<void> {
  const script = `(async () => {
    const boot = window.__cadenceBoot || {};
    const checks = {};
    checks.preloadBridge = typeof window.cadenceNative === 'object';
    checks.wxtGlobals = boot.wxtGlobals === true;
    checks.chromeShimInstalled = typeof chrome === 'object' && typeof chrome.storage === 'object';
    checks.backgroundMainRan = boot.backgroundMain === true;
    checks.reactMounted = boot.mounted === true
      && !!document.querySelector('#root')
      && document.querySelector('#root').childElementCount > 0;

    // The app:// origin must be a real, stable origin or IndexedDB has no durable home.
    checks.appOrigin = location.protocol === 'app:' || location.protocol === 'http:';

    try {
      await chrome.storage.local.set({ __smoke: 'yes' });
      const got = await chrome.storage.local.get('__smoke');
      checks.storageRoundTrip = got.__smoke === 'yes';
      await chrome.storage.local.remove('__smoke');
      const gone = await chrome.storage.local.get('__smoke');
      checks.storageRemove = gone.__smoke === undefined;
    } catch (e) { checks.storageRoundTrip = String(e); }

    // onChanged must fire in the context that wrote â€” App.tsx's pause toggle depends on it.
    try {
      checks.onChangedEchoesToWriter = await new Promise((resolve) => {
        const t = setTimeout(() => resolve('no event within 2s'), 2000);
        const fn = (changes, area) => {
          if (!changes.__smokeEcho) return;
          clearTimeout(t);
          chrome.storage.onChanged.removeListener(fn);
          resolve(area === 'local' && changes.__smokeEcho.newValue === 1);
        };
        chrome.storage.onChanged.addListener(fn);
        chrome.storage.local.set({ __smokeEcho: 1 });
      });
      await chrome.storage.local.remove('__smokeEcho');
    } catch (e) { checks.onChangedEchoesToWriter = String(e); }

    // Dexie: the real test is that the schema this build expects actually opens.
    try {
      const db = (boot.modules || {}).db;
      if (!db) throw new Error('smoke modules not exposed');
      await db.open();
      const names = db.tables.map((t) => t.name).sort();
      const required = ['events','rituals','spaces','spaceUrls','shelves','flipPairs','macros','macroRuns'].sort();
      checks.dexieOpened = required.every((n) => names.includes(n)) ? true : 'tables: ' + names.join(',');
      await db.events.count();
      checks.dexieQueryable = true;
    } catch (e) { checks.dexieOpened = String(e); }

    // Settings must persist through lib/settings.ts, not just raw storage.
    try {
      const s = (boot.modules || {}).settings;
      if (!s) throw new Error('smoke modules not exposed');
      await s.setRunSpeed('fast');
      checks.settingsPersist = (await s.getRunSpeed()) === 'fast';
      await s.setRunSpeed('normal');
    } catch (e) { checks.settingsPersist = String(e); }

    // Alarms: no MV3 30s clamp here, so a sub-second alarm must actually fire.
    try {
      checks.alarmsFire = await new Promise((resolve) => {
        const t = setTimeout(() => resolve('did not fire within 3s'), 3000);
        chrome.alarms.onAlarm.addListener(function fn(a) {
          if (a.name !== '__smokeAlarm') return;
          clearTimeout(t); resolve(true);
        });
        chrome.alarms.create('__smokeAlarm', { when: Date.now() + 300 });
      });
    } catch (e) { checks.alarmsFire = String(e); }

    // tabs.group must RESOLVE with no browser attached: lib/spaces.ts switchToSpace calls it
    // without a try/catch, so a rejection breaks the whole switch-to-space action.
    try {
      const gid = await chrome.tabs.group({ tabIds: [1, 2] });
      await chrome.tabGroups.update(gid, { title: 'Smoke', collapsed: false });
      const found = await chrome.tabGroups.query({ title: 'Smoke' });
      checks.tabsGroupResolves = typeof gid === 'number' && found.length === 1;
    } catch (e) { checks.tabsGroupResolves = String(e); }

    // The null backend must degrade, not throw, so the UI is usable before Chrome attaches.
    try {
      checks.tabsQueryEmptyWithoutBrowser = (await chrome.tabs.query({})).length === 0;
    } catch (e) { checks.tabsQueryEmptyWithoutBrowser = String(e); }

    // getContexts gates banner-vs-notification; it must answer from real window visibility.
    try {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
      checks.getContextsAnswers = Array.isArray(ctx);
    } catch (e) { checks.getContextsAnswers = String(e); }

    // calendar.ts short-circuits to the bundled demo file while the client id is a placeholder.
    try {
      const res = await fetch(chrome.runtime.getURL('/demo-calendar.json'));
      checks.getURLFetchable = res.ok;
    } catch (e) { checks.getURLFetchable = String(e); }

    return { checks, errors: (boot.errors || []).slice(0, 10) };
  })()`;

  // Give boot() a moment; the renderer resolves its own async work before we look.
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const report = await win.webContents.executeJavaScript(script, true);
    console.log(`CADENCE_SMOKE_RESULT ${JSON.stringify(report)}`);
  } catch (err) {
    console.log(
      `CADENCE_SMOKE_RESULT ${JSON.stringify({ checks: { evaluate: String(err) }, errors: [] })}`,
    );
  }
}

/**
 * P5 gate: focus inference does not misfire on Cadence's own window.
 *
 * In the extension the panel lives inside Chrome, so using Cadence never blurs the browser. On
 * desktop it is a separate OS window, and a naive mapping would fire `chrome_focus_lost` every
 * time the user clicked the app — cancelling any flip and writing a bogus event. Worse,
 * `focus-flip.ts`'s `isChromeFocused()` would read false while Cadence is in front, so a flip
 * could never arm at all.
 */
async function runP5Checks(win: BrowserWindow): Promise<void> {
  const checks: Record<string, unknown> = {};
  const errors: string[] = [];

  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && browser.getStatus().state !== 'connected') {
      await new Promise((r) => setTimeout(r, 300));
    }
    checks.browserConnected = browser.getStatus().state === 'connected';

    // Open a page so there is a visible tab reporting focus.
    await browser.createTab({ url: 'about:blank', active: true });
    await new Promise((r) => setTimeout(r, 1200));

    const countFocusEvents = async () =>
      (await win.webContents.executeJavaScript(
        `(async () => {
          const { db } = window.__cadenceBoot.modules;
          const all = await db.events.toArray();
          return all.filter((e) => e.kind === 'chrome_focus_lost').length;
        })()`,
        true,
      )) as number;

    const before = await countFocusEvents();

    // Simulate the user clicking the Cadence window.
    browser.setCadenceFocused(true);
    await new Promise((r) => setTimeout(r, 900));

    checks.cadenceFocusCountsAsBrowserFocus = browser.isBrowserFocused()
      ? true
      : 'isBrowserFocused() went false while Cadence had focus';

    const lastFocused = await browser.lastFocusedWindow();
    // focus-flip.ts gates arming on exactly this value.
    checks.isChromeFocusedStaysTrue = lastFocused.focused === true
      ? true
      : JSON.stringify(lastFocused);

    const after = await countFocusEvents();
    checks.noFocusLostFromOwnWindow = after === before
      ? true
      : `chrome_focus_lost went ${before} -> ${after} when Cadence took focus`;

    // Releasing Cadence's focus must not *itself* blur: the browser still has focus here, and
    // reporting otherwise would write a spurious chrome_focus_lost. The composition rule itself
    // is covered directly by tests/desktop-focus-rule.test.ts.
    browser.setCadenceFocused(false);
    await new Promise((r) => setTimeout(r, 600));
    const afterRelease = await countFocusEvents();
    checks.noFocusLostWhenLeavingCadence = afterRelease === before
      ? true
      : `chrome_focus_lost went ${before} -> ${afterRelease} on leaving Cadence`;
  } catch (err) {
    errors.push(String(err));
  }

  console.log(`CADENCE_P5_RESULT ${JSON.stringify({ checks, errors })}`);
}

/**
 * P4 gate: AI tasks over IPC, Standup generation, and virtual groups behaving like shelves.
 */
async function runP4Checks(win: BrowserWindow): Promise<void> {
  const script = `(async () => {
    const checks = {};
    const errors = [];
    try {
      const { db, ai, standup, spaces, tabsLib } = window.__cadenceBoot.modules || {};

      // --- the AI path ---------------------------------------------------------------
      // The renderer cannot reach the proxy directly: it is cross-origin with a custom header,
      // so the browser would preflight it and the Worker only echoes the extension's origin.
      // installAiFetch routes it through the main process instead. A real response here proves
      // that whole path, with zero changes to lib/ai.ts.
      const res = await ai.runTask('name_spaces', {
        spaces: [{ index: 0, urls: [{ url: 'https://github.com/x', title: 'x' }] }],
      });
      checks.aiTaskSucceeded = res.ok === true ? true : JSON.stringify(res);
      checks.aiReturnedData = res.ok && res.data ? true : 'no data';

      // The privacy viewer must still see exactly what was sent.
      const last = await ai.getLastAiRequest();
      checks.aiRequestRecorded =
        last && last.request && last.request.task === 'name_spaces' ? true : JSON.stringify(last);
      checks.aiStatusRecorded = last && last.status === 200 ? true : 'status=' + (last && last.status);

      // --- standup -------------------------------------------------------------------
      const now = Date.now();
      // Time on a page is derived from tab_activated segments (see computeSegments), so the
      // seed mirrors what the collector really emits rather than navigations alone.
      await db.events.bulkAdd([
        { ts: now - 3600_000, kind: 'navigated', tabId: 11, url: 'https://github.com/acme/api/pull/7', domain: 'github.com', title: 'Fix auth' },
        { ts: now - 3600_000, kind: 'tab_activated', tabId: 11, url: 'https://github.com/acme/api/pull/7', domain: 'github.com', title: 'Fix auth' },
        { ts: now - 3300_000, kind: 'click', tabId: 11, url: 'https://github.com/acme/api/pull/7', domain: 'github.com', selector: '#merge', label: 'Merge' },
        { ts: now - 3000_000, kind: 'navigated', tabId: 12, url: 'https://docs.google.com/document/d/1', domain: 'docs.google.com', title: 'Design doc' },
        { ts: now - 3000_000, kind: 'tab_activated', tabId: 12, url: 'https://docs.google.com/document/d/1', domain: 'docs.google.com', title: 'Design doc' },
        { ts: now - 2700_000, kind: 'typing_burst', tabId: 12, url: 'https://docs.google.com/document/d/1', domain: 'docs.google.com', title: 'Design doc', keyCount: 120 },
      ]);
      // StandupRangeKind is 'yesterday' | 'last24h' | 'sinceLast' — not 'today'.
      const result = await standup.generateStandup('last24h');
      // StandupResult: { draft: { yesterday, today, blockers }, source, rangeLabel }
      checks.standupGenerated =
        result && result.draft && Array.isArray(result.draft.today)
          ? true : JSON.stringify(result).slice(0, 240);
      // With a reachable proxy this is the AI draft; the local fallback is still a pass for the
      // pipeline, so record which path ran rather than asserting one.
      checks.standupSource = result && (result.source === 'ai' || result.source === 'fallback')
        ? true : 'source=' + (result && result.source);
      // The draft must actually reflect the browsing above, not just the demo calendar.
      const all = JSON.stringify(result.draft).toLowerCase();
      checks.standupReflectsBrowsing =
        all.includes('github') || all.includes('auth') || all.includes('design doc')
          ? true : JSON.stringify(result.draft).slice(0, 300);

      // --- virtual groups <-> shelves -------------------------------------------------
      // CDP has no tabGroups domain. The shim keeps groups itself; the critical property is that
      // tabs.group RESOLVES, because lib/spaces.ts switchToSpace calls it with no try/catch.
      const gid = await chrome.tabs.group({ tabIds: [1, 2] });
      await chrome.tabGroups.update(gid, { title: 'P4 space', collapsed: false });
      const found = await chrome.tabGroups.query({ title: 'P4 space' });
      checks.virtualGroupRoundTrips = found.length === 1 && found[0].id === gid
        ? true : JSON.stringify(found);

      const missing = await chrome.tabGroups.query({ title: 'nothing here' });
      // restoreSpace and switchToSpace branch on this being empty to fall through to the shelf.
      checks.unknownGroupQueryIsEmpty = missing.length === 0 ? true : JSON.stringify(missing);
    } catch (e) {
      errors.push(String(e && e.stack ? e.stack : e));
    }
    return { checks, errors };
  })()`;

  await new Promise((r) => setTimeout(r, 6000));
  try {
    const report = await win.webContents.executeJavaScript(script, true);
    console.log(`CADENCE_P4_RESULT ${JSON.stringify(report)}`);
  } catch (err) {
    console.log(
      `CADENCE_P4_RESULT ${JSON.stringify({ checks: { evaluate: String(err) }, errors: [] })}`,
    );
  }
}

/**
 * P3 gate: press the leader key for real and check the overlay drives the real actions.
 *
 * Simulates the global shortcut (the OS hotkey itself cannot be synthesised reliably in a test),
 * then pushes keys into the overlay window exactly as a user would, and verifies that a macro
 * assigned to a letter actually runs.
 */
async function runP3Checks(win: BrowserWindow, base: string): Promise<void> {
  const checks: Record<string, unknown> = {};
  const errors: string[] = [];

  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && browser.getStatus().state !== 'connected') {
      await new Promise((r) => setTimeout(r, 300));
    }
    checks.browserConnected = browser.getStatus().state === 'connected';

    checks.shortcutsRegistered = registeredCommands.some(
      (c) => c.name === 'leader-key' && c.shortcut,
    )
      ? true
      : JSON.stringify(registeredCommands);

    // Save a macro and give it a leader letter, the way the Macros tab does.
    const setup = await win.webContents.executeJavaScript(
      `(async () => {
        const { db, leader } = window.__cadenceBoot.modules || {};
        const base = ${JSON.stringify(base)};
        const now = Date.now();
        const id = await db.macros.add({
          macroKey: 'p3', name: 'P3 macro', nameIsUserSet: true, source: 'chrome',
          detector: 'sequence',
          steps: [{ key: 'open:' + base + '/gamma', kind: 'open_url', url: base + '/gamma', title: 'Gamma', enabled: true, support: 3 }],
          removedStepKeys: [], pinnedStepKeys: [], status: 'accepted',
          occurrences: 3, typicalHour: null, createdAt: now, updatedAt: now,
        });
        const check = await leader.setMacroLetter(id, 'g');
        const menu = await leader.getMenu();
        return { id, letterOk: check.ok === true, menu: menu.map((m) => m.letter + ':' + m.kind + ':' + m.id) };
      })()`,
      true,
    );
    checks.macroLetterAssigned = setup.letterOk === true ? true : JSON.stringify(setup);
    checks.menuIncludesMacro = (setup.menu ?? []).some((m: string) => m.startsWith('g:macro:'))
      ? true
      : JSON.stringify(setup.menu);

    // Press the leader key, exactly as the global shortcut does.
    broadcast(PUSH.command, 'leader-key');
    await new Promise((r) => setTimeout(r, 1500));
    checks.overlayOpened = overlayIsOpen() ? true : 'overlay did not show';

    // What the overlay is actually displaying — the real menu built by lib/leader.ts.
    const overlayText = await overlayContentText();
    checks.overlayShowsLetters =
      overlayText.includes('press a letter') && overlayText.toLowerCase().includes('p3 macro')
        ? true
        : `overlay text: ${overlayText.slice(0, 200)}`;

    const tabsBefore = browser.registry.all().length;

    // Press "g" in the overlay, as a user would.
    await pressInOverlay('g');
    await new Promise((r) => setTimeout(r, 3000));

    checks.overlayClosedAfterLetter = !overlayIsOpen() ? true : 'overlay stayed open';
    const opened = browser.registry.all().filter((t) => t.url.includes('/gamma'));
    checks.letterRanTheMacro =
      opened.length > 0 && browser.registry.all().length > tabsBefore
        ? true
        : `tabs now: ${JSON.stringify(browser.registry.all().map((t) => t.url))}`;

    // Esc must dismiss without running anything.
    broadcast(PUSH.command, 'leader-key');
    await new Promise((r) => setTimeout(r, 1200));
    const beforeEsc = browser.registry.all().length;
    await pressInOverlay('Escape');
    await new Promise((r) => setTimeout(r, 800));
    checks.escapeDismisses =
      !overlayIsOpen() && browser.registry.all().length === beforeEsc
        ? true
        : 'escape did not dismiss cleanly';
  } catch (err) {
    errors.push(String(err));
  }

  console.log(`CADENCE_P3_RESULT ${JSON.stringify({ checks, errors })}`);
}

/** Reads the overlay's rendered text, to assert on what the user would actually see. */
async function overlayContentText(): Promise<string> {
  const win = BrowserWindow.getAllWindows().find((w) =>
    w.webContents.getURL().includes('overlay/index.html'),
  );
  if (!win) return '';
  try {
    return await win.webContents.executeJavaScript('document.body.innerText', true);
  } catch {
    return '';
  }
}

/** Sends a real key event to the overlay window. */
async function pressInOverlay(key: string): Promise<void> {
  const win = BrowserWindow.getAllWindows().find((w) =>
    w.webContents.getURL().includes('overlay/index.html'),
  );
  if (!win) return;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
  win.webContents.sendInputEvent({ type: 'char', keyCode: key });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
}

/**
 * P2 gate: save a macro, run it, and check that real tabs opened and a real button got clicked.
 *
 * Runs `runMacro` from `@/lib/macros` â€” the same entry point the Macros tab and the leader key use
 * â€” so a pass means the whole replay stack works on desktop: the executor, `macro-host-chrome.ts`,
 * the `chrome.*` shim, CDP, and the injected `clickBySelector`.
 */
async function runP2Checks(win: BrowserWindow, base: string): Promise<void> {
  const script = `(async () => {
    const checks = {};
    const errors = [];
    try {
      const mods = window.__cadenceBoot.modules || {};
      const { db, macros, types } = mods;
      if (!db || !macros) return { checks: { modules: 'not exposed' }, errors };

      const base = ${JSON.stringify(base)};
      const now = Date.now();

      // A macro of the shape detection produces: open two pages, then click a button on the first.
      const macro = {
        macroKey: 'p2-test',
        name: 'P2 test macro',
        nameIsUserSet: true,
        source: 'chrome',
        detector: 'sequence',
        steps: [
          { key: 'open:' + base + '/alpha', kind: 'open_url', url: base + '/alpha', title: 'Alpha', enabled: true, support: 3 },
          { key: 'open:' + base + '/gamma', kind: 'open_url', url: base + '/gamma', title: 'Gamma', enabled: true, support: 3 },
          { key: 'click:' + base + '/alpha|#go', kind: 'click', url: base + '/alpha', selector: '#go', label: 'Press me', enabled: true, support: 3 },
        ],
        removedStepKeys: [], pinnedStepKeys: [],
        status: 'accepted', occurrences: 3, typicalHour: null,
        createdAt: now, updatedAt: now,
      };
      const macroId = await db.macros.add(macro);
      checks.macroSaved = typeof macroId === 'number';

      const result = await macros.runMacro(macroId, { mode: 'guided', speed: 'fast' });
      checks.runReturned = !!result;

      const outcomes = (result && result.outcomes) || [];
      checks.allStepsAttempted = outcomes.length === 3 ? true : 'outcomes=' + JSON.stringify(outcomes);
      checks.opensSucceeded = outcomes.slice(0, 2).every((o) => o.status === 'ok')
        ? true : JSON.stringify(outcomes.slice(0, 2));
      // The click step is the real test of injection: it must find and press a button in the page.
      checks.clickSucceeded = outcomes[2] && outcomes[2].status === 'ok'
        ? true : JSON.stringify(outcomes[2]);

      // A run must not feed the detector its own output, or running a macro would make Cadence
      // more confident in it forever (see MACRO_REPLAY_FLAG_KEY in lib/macro-run-channel.ts).
      const after = await db.events.toArray();
      const duringReplay = after.filter((e) => e.ts >= now);
      checks.replayRecordedNoEvents = duringReplay.length === 0
        ? true : 'recorded ' + duringReplay.length + ' events during replay: ' +
                 JSON.stringify(duringReplay.map((e) => e.kind));

      const runs = await db.macroRuns.toArray();
      checks.runRecorded = runs.length > 0;
    } catch (e) {
      errors.push(String(e && e.stack ? e.stack : e));
    }
    return { checks, errors };
  })()`;

  // Let the app settle and Chrome connect first.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && browser.getStatus().state !== 'connected') {
    await new Promise((r) => setTimeout(r, 300));
  }

  try {
    const report = await win.webContents.executeJavaScript(script, true);
    report.checks = { browserConnected: browser.getStatus().state === 'connected', ...report.checks };
    // Proof the tabs really exist in Chrome, read from the main process rather than the page.
    const urls = browser.registry.all().map((t) => t.url);
    report.checks.tabsExistInChrome =
      urls.some((u) => u.includes('/alpha')) && urls.some((u) => u.includes('/gamma'))
        ? true
        : `tabs: ${JSON.stringify(urls)}`;
    // The click handler sets document.title, so reading it back proves the click truly landed in
    // the page rather than the executor merely believing it did. Read from the page itself: the
    // registry's cached title is a separate mechanism and would conflate two different failures.
    const alpha = browser.registry.all().find((t) => t.url.includes('/alpha'));
    if (alpha) {
      const [live] = await browser.executeScript({
        tabId: alpha.id,
        allFrames: false,
        source: 'document.title',
      });
      report.checks.clickHadRealEffect =
        live?.result === 'Alpha clicked' ? true : `live title: ${String(live?.result)}`;
      report.checks.registryTitleFresh =
        alpha.title === 'Alpha clicked' ? true : `registry title: ${alpha.title}`;
    }
    console.log(`CADENCE_P2_RESULT ${JSON.stringify(report)}`);
  } catch (err) {
    console.log(
      `CADENCE_P2_RESULT ${JSON.stringify({ checks: { evaluate: String(err) }, errors: [] })}`,
    );
  }
}

/**
 * P1 gate: drive the real Chrome through a scripted session, then ask Cadence what it recorded.
 *
 * Uses the app's own BrowserController, so this exercises exactly the code path a user does.
 */
async function runP1Checks(win: BrowserWindow, base: string): Promise<void> {
  const checks: Record<string, unknown> = {};
  const errors: string[] = [];
  let eventKinds: Record<string, number> = {};

  try {
    // Wait for the renderer to boot and launch Chrome.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && browser.getStatus().state !== 'connected') {
      await new Promise((r) => setTimeout(r, 300));
    }
    checks.browserConnected = browser.getStatus().state === 'connected';
    if (!checks.browserConnected) {
      checks.browserError = browser.getStatus().error ?? 'never connected';
      throw new Error('browser not connected');
    }

    // --- drive a browsing session -------------------------------------------------
    const alpha = await browser.createTab({ url: `${base}/alpha`, active: true });
    await new Promise((r) => setTimeout(r, 1500));
    checks.tabRegistered = typeof alpha.id === 'number';
    checks.titleTracked = (browser.registry.get(alpha.id)?.title ?? '') === 'Alpha';
    checks.statusComplete = browser.registry.get(alpha.id)?.status === 'complete';
    checks.activeTracked = browser.registry.get(alpha.id)?.active === true;

    // A click, which only the injected collector can see.
    await browser.executeScript({
      tabId: alpha.id,
      allFrames: false,
      source: `document.querySelector('#go').click(), true`,
    });
    await new Promise((r) => setTimeout(r, 600));

    // A second tab, then switching back: exercises activation tracking.
    const beta = await browser.createTab({ url: `${base}/beta`, active: true });
    await new Promise((r) => setTimeout(r, 1500));
    checks.secondTabActive = browser.registry.get(beta.id)?.active === true;
    checks.firstTabDeactivated = browser.registry.get(alpha.id)?.active === false;

    await browser.activateTab(alpha.id);
    await new Promise((r) => setTimeout(r, 900));
    checks.activationSwitchesBack = browser.registry.get(alpha.id)?.active === true;

    // An in-page (SPA) navigation, which must be recorded with spa=true.
    await browser.activateTab(beta.id);
    await new Promise((r) => setTimeout(r, 500));
    await browser.executeScript({
      tabId: beta.id,
      allFrames: false,
      source: `document.querySelector('#spa').click(), true`,
    });
    await new Promise((r) => setTimeout(r, 1200));
    checks.spaUrlTracked = (browser.registry.get(beta.id)?.url ?? '').includes('/beta/inner');

    // Let the collector's messages land in Dexie.
    await new Promise((r) => setTimeout(r, 1500));

    // --- ask Cadence what it recorded ----------------------------------------------
    const report = await win.webContents.executeJavaScript(
      `(async () => {
        const db = (window.__cadenceBoot.modules || {}).db;
        if (!db) return { error: 'modules not exposed' };
        const all = await db.events.toArray();
        const kinds = {};
        for (const e of all) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
        return {
          kinds,
          total: all.length,
          anySpa: all.some((e) => e.spa === true),
          clickDomains: all.filter((e) => e.kind === 'click').map((e) => e.domain),
          navUrls: all.filter((e) => e.kind === 'navigated').map((e) => e.url).slice(0, 8),
        };
      })()`,
      true,
    );

    if (report.error) {
      errors.push(String(report.error));
    } else {
      eventKinds = report.kinds ?? {};
      checks.recordedEvents = (report.total ?? 0) > 0 ? true : `total=${report.total}`;
      checks.recordedNavigations = (eventKinds.navigated ?? 0) > 0 ? true : 'no navigated events';
      checks.recordedTabOpens = (eventKinds.tab_opened ?? 0) > 0 ? true : 'no tab_opened events';
      // The click only reaches Dexie through the injected collector, so this proves injection,
      // the page-side chrome shim, the CDP binding, and handleContentMessage all work.
      checks.recordedClicksViaCollector =
        (eventKinds.click ?? 0) > 0 ? true : 'no click events â€” collector injection is not working';
      checks.recordedActivations =
        (eventKinds.tab_activated ?? 0) > 0 ? true : 'no tab_activated events';
      checks.recordedSpaNavigation = report.anySpa === true ? true : 'no event with spa=true';
    }
  } catch (err) {
    errors.push(String(err));
  }

  console.log(`CADENCE_P1_RESULT ${JSON.stringify({ checks, eventKinds, errors })}`);
}

/** Dev aid: save a PNG of the core window so the UI can be reviewed without a human at the screen. */
async function captureShot(win: BrowserWindow, outFile: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const image = await win.webContents.capturePage();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outFile, image.toPNG());
    console.log(`CADENCE_SHOT_SAVED ${outFile}`);
  } catch (err) {
    console.error('[cadence] screenshot failed', err);
    console.log('CADENCE_SHOT_SAVED failed');
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showCoreWindow);

  void app.whenReady().then(() => {
    store.initStorage();
    store.subscribe((area, changes) => broadcast(PUSH.storageChanged, { area, changes }));

    registerAppProtocol();
    registerIpc();
    watchTimerDrift();

    /**
     * The leader key, and the macro palette.
     *
     * Defaults match `wxt.config.ts` so muscle memory carries over from the extension. Unlike the
     * extension, Cadence owns these bindings outright, so `chrome.commands.getAll()` can report
     * whether they actually bound rather than linking to chrome://extensions/shortcuts.
     */
    const commands = registerShortcuts(
      [
        {
          name: 'leader-key',
          accelerator: process.platform === 'darwin' ? 'Command+Shift+Y' : 'Control+Shift+Y',
          description: 'Cadence: open the leader-key menu',
        },
        {
          name: 'open-macro-palette',
          accelerator: process.platform === 'darwin' ? 'Command+Shift+P' : 'Control+Shift+P',
          description: 'Cadence: open the macro palette',
        },
      ],
      (name) => broadcast(PUSH.command, name),
    );
    broadcast(PUSH.registeredCommands, commands);
    registeredCommands = commands;

    // Keys pressed in the overlay become runtime messages, which `background.ts` already routes
    // to runLeaderLetter / runSearchItem / confirmRepeat / cancelRepeat.
    setOverlayMessageHandler((message) => broadcast(PUSH.overlayMessage, message));

    browser.onStatus((s) => broadcast(PUSH.browserStatus, s));
    browser.onFocusChanged((focused) => broadcast(PUSH.browserFocus, focused));
    browser.onRegistryEvent((e) => broadcast(PUSH.browserEvent, e));
    browser.onCollectorMessage((m) => broadcast(PUSH.collectorMessage, m));

    /**
     * The session store is cleared when the *browser* goes away, not only on app start.
     *
     * `lib/macro-run-channel.ts` chose session storage precisely because "the browser clears it on
     * restart so a crashed run cannot haunt the next session". On desktop Cadence outlives Chrome,
     * so that guarantee has to be re-created here. The dangerous leftovers are concrete:
     * `macroReplayInProgress` makes `writeEvent` return early â€” a stuck flag silently stops all
     * event collection â€” and `activeTabsSeeded` makes `seedActiveTabs()` skip, leaving the tab the
     * user starts on invisible to Cadence.
     */
    browser.onStatus((s) => {
      if (s.state === 'launching' || s.state === 'disconnected') store.clearSession();
    });

    // Settings the injected page shim mirrors; push changes into already-open pages.
    store.subscribe((area, changes) => {
      if (area !== 'local' || !('focusFlipEnabled' in changes)) return;
      void browser.updatePageSettings(store.get('local', ['focusFlipEnabled']));
    });

    coreWindow = createCoreWindow();
    createTray();

    if (process.env.CADENCE_SMOKE) void runSmokeChecks(coreWindow);
    if (process.env.CADENCE_SHOT) void captureShot(coreWindow, process.env.CADENCE_SHOT);
    if (process.env.CADENCE_P1) void runP1Checks(coreWindow, process.env.CADENCE_P1);
    if (process.env.CADENCE_P2) void runP2Checks(coreWindow, process.env.CADENCE_P2);
    if (process.env.CADENCE_P3) void runP3Checks(coreWindow, process.env.CADENCE_P3);
    if (process.env.CADENCE_P4) void runP4Checks(coreWindow);
    if (process.env.CADENCE_P5) void runP5Checks(coreWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) coreWindow = createCoreWindow();
      else showCoreWindow();
    });
  });

  // Closing the window hides it; the app keeps collecting. Quitting is explicit.
  app.on('window-all-closed', () => {
    /* deliberately empty */
  });

  app.on('before-quit', () => {
    quitting = true;
    store.flushNow();
    unregisterShortcuts();
    void browser.shutdown();
  });
}

export { APP_ORIGIN };
