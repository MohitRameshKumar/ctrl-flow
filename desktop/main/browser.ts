/**
 * The bridge between Chrome (over CDP) and Cadence's `chrome.*` shim.
 *
 * Owns the CDP connection, the tab registry, collector injection, and every tab operation macro
 * replay needs. Everything above this file thinks in tabs; everything below it thinks in targets.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { CdpClient, type CdpEvent } from './cdp';
import { launchBrowser, findBrowsers, type LaunchedBrowser } from './chrome-launcher';
import { TabRegistry, type RegistryEvent, type RegistryTab } from './tab-registry';
import { isBrowserInUse } from './focus-rule';

const COLLECTOR_BINDING = '__cadenceSend';

/** Settings the injected page shim needs at document start. */
const PAGE_SETTINGS_KEYS = ['focusFlipEnabled'];

export interface BrowserStatus {
  state: 'idle' | 'launching' | 'connected' | 'disconnected' | 'error';
  browserName?: string;
  error?: string;
  /** Present when no Chromium-family browser could be found at all. */
  candidates?: { path: string; name: string }[];
}

export interface CollectorMessage {
  tabId: number;
  frameId: number;
  url: string;
  message: unknown;
}

export class BrowserController {
  readonly registry = new TabRegistry();

  private cdp: CdpClient | null = null;
  private launched: LaunchedBrowser | null = null;
  private status: BrowserStatus = { state: 'idle' };

  /** targetId -> CDP session for attached page targets. */
  private readonly sessions = new Map<string, string>();
  private readonly targetBySession = new Map<string, string>();

  private collectorSource = '';
  private pageSettings: Record<string, unknown> = {};

  /**
   * Whether the browser, as opposed to Cadence itself, has OS focus.
   *
   * In the extension the side panel lives *inside* Chrome, so interacting with Cadence never blurs
   * it. On desktop clicking Cadence's own window takes focus away from the browser, and a naive
   * mapping would then fire `chrome_focus_lost` every time the user touched the UI — which calls
   * `cancelFlip()` and writes a focus-lost event. Worse, `focus-flip.ts`'s `isChromeFocused()`
   * would read false whenever Cadence is in front, so a flip could never arm.
   *
   * So "Cadence is focused" counts as "the browser is focused" for these purposes.
   */
  private browserFocused = false;
  private cadenceFocused = false;

  private readonly focusListeners = new Set<(focused: boolean) => void>();
  private readonly statusListeners = new Set<(s: BrowserStatus) => void>();
  private readonly messageListeners = new Set<(m: CollectorMessage) => void>();

  onStatus(fn: (s: BrowserStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Fires with the *effective* focus state: Chrome focused, or Cadence focused on its behalf. */
  onFocusChanged(fn: (focused: boolean) => void): () => void {
    this.focusListeners.add(fn);
    return () => this.focusListeners.delete(fn);
  }

  /** True when either the controlled browser or a Cadence window has focus. */
  isBrowserFocused(): boolean {
    return isBrowserInUse(this.browserFocused, this.cadenceFocused);
  }

  /** Called by the main process when a Cadence window gains or loses focus. */
  setCadenceFocused(focused: boolean): void {
    const before = this.isBrowserFocused();
    this.cadenceFocused = focused;
    this.emitFocusIfChanged(before);
  }

  private setBrowserFocused(focused: boolean): void {
    const before = this.isBrowserFocused();
    this.browserFocused = focused;
    this.emitFocusIfChanged(before);
  }

  private emitFocusIfChanged(before: boolean): void {
    const now = this.isBrowserFocused();
    if (now === before) return;
    for (const fn of [...this.focusListeners]) {
      try {
        fn(now);
      } catch (err) {
        console.error('[cadence] focus listener threw', err);
      }
    }
  }

  onCollectorMessage(fn: (m: CollectorMessage) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onRegistryEvent(fn: (e: RegistryEvent) => void): () => void {
    return this.registry.subscribe(fn);
  }

  getStatus(): BrowserStatus {
    return this.status;
  }

  private setStatus(next: BrowserStatus): void {
    this.status = next;
    for (const fn of [...this.statusListeners]) {
      try {
        fn(next);
      } catch (err) {
        console.error('[cadence] status listener threw', err);
      }
    }
  }

  /** Settings pushed into already-open pages, so a Focus Flip toggle takes effect without reloads. */
  async updatePageSettings(settings: Record<string, unknown>): Promise<void> {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const key of PAGE_SETTINGS_KEYS) {
      if (this.pageSettings[key] === settings[key]) continue;
      changes[key] = { oldValue: this.pageSettings[key], newValue: settings[key] };
      this.pageSettings[key] = settings[key];
    }
    if (Object.keys(changes).length === 0 || !this.cdp) return;

    const payload = JSON.stringify({ changes, area: 'local' });
    for (const sessionId of this.sessions.values()) {
      await this.cdp.trySend(
        'Runtime.evaluate',
        {
          expression: `globalThis.__cadenceStorageChanged && globalThis.__cadenceStorageChanged(${JSON.stringify(payload)})`,
        },
        sessionId,
      );
    }
  }

  private loadCollector(): string {
    if (this.collectorSource) return this.collectorSource;
    // Read from the app bundle. Electron's patched fs reads inside asar transparently.
    const candidates = [
      join(app.getAppPath(), 'out/injected/collector.js'),
      join(process.cwd(), 'out/injected/collector.js'),
    ];
    for (const path of candidates) {
      try {
        this.collectorSource = readFileSync(path, 'utf8');
        return this.collectorSource;
      } catch {
        /* try the next candidate */
      }
    }
    console.error('[cadence] collector bundle missing; run `vite build -c desktop/injected/vite.config.ts`');
    return '';
  }

  /** The collector, with this run's settings baked in so page start needs no round trip. */
  private collectorFor(): string {
    const source = this.loadCollector();
    if (!source) return '';
    return source.replace(
      /__CADENCE_INITIAL_STORAGE__/g,
      JSON.stringify(JSON.stringify(this.pageSettings)),
    );
  }

  async launch(options: { initialSettings?: Record<string, unknown>; startUrl?: string } = {}): Promise<BrowserStatus> {
    if (this.status.state === 'launching') return this.status;

    const found = findBrowsers();
    if (found.length === 0) {
      this.setStatus({ state: 'error', error: 'NO_BROWSER_FOUND', candidates: [] });
      return this.status;
    }

    this.pageSettings = { ...(options.initialSettings ?? {}) };
    this.setStatus({ state: 'launching' });

    try {
      const userDataDir = join(app.getPath('userData'), 'chrome-profile');
      this.launched = await launchBrowser({
        userDataDir,
        startUrl: options.startUrl,
      });

      this.cdp = new CdpClient();
      await this.cdp.connect(this.launched.webSocketDebuggerUrl);

      this.cdp.on('event', (event: CdpEvent) => void this.onCdpEvent(event));
      this.cdp.on('disconnected', () => this.onDisconnected());
      this.launched.process.on('exit', () => this.onDisconnected());

      // Auto-attach gives us a session for every present and future page target, and
      // `waitForDebuggerOnStart` is what lets the collector be installed before any page script
      // runs. Without it, early clicks on a fast-loading page are simply missed.
      await this.cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      await this.cdp.send('Target.setDiscoverTargets', { discover: true });

      this.setStatus({ state: 'connected', browserName: this.launched.browserName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: 'error', error: message });
    }
    return this.status;
  }

  private onDisconnected(): void {
    if (this.status.state === 'disconnected') return;
    this.setBrowserFocused(false);
    this.sessions.clear();
    this.targetBySession.clear();
    this.registry.clear();
    this.cdp?.close();
    this.cdp = null;
    this.setStatus({ state: 'disconnected' });
  }

  private async onCdpEvent(event: CdpEvent): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;

    switch (event.method) {
      case 'Target.attachedToTarget': {
        const info = event.params.targetInfo as { targetId: string; type: string; url?: string; title?: string };
        const sessionId = event.params.sessionId as string;
        if (info.type !== 'page') {
          // Not a tab (worker, OOPIF): let it run, but do not track it as one.
          await cdp.trySend('Runtime.runIfWaitingForDebugger', {}, sessionId);
          return;
        }
        await this.attachPage(info, sessionId);
        return;
      }

      case 'Target.detachedFromTarget': {
        const sessionId = event.params.sessionId as string;
        const targetId = this.targetBySession.get(sessionId);
        if (targetId) {
          this.sessions.delete(targetId);
          this.targetBySession.delete(sessionId);
        }
        return;
      }

      case 'Target.targetDestroyed': {
        this.registry.remove(event.params.targetId as string);
        return;
      }

      case 'Target.targetInfoChanged': {
        const info = event.params.targetInfo as { targetId: string; type: string; url?: string; title?: string };
        if (info.type !== 'page') return;
        // Title and URL both arrive here, even for targets we never attached to.
        this.registry.updateByTarget(info.targetId, {
          ...(info.url !== undefined ? { url: info.url } : {}),
          ...(info.title !== undefined ? { title: info.title } : {}),
        });
        return;
      }

      case 'Page.frameNavigated': {
        const frame = event.params.frame as { url: string; parentId?: string };
        // Main frame only: `parentId` is absent exactly for the top frame (verified in the spike).
        if (frame.parentId) return;
        const targetId = event.sessionId ? this.targetBySession.get(event.sessionId) : undefined;
        if (targetId) this.registry.navigated(targetId, frame.url, false);
        return;
      }

      case 'Page.navigatedWithinDocument': {
        const targetId = event.sessionId ? this.targetBySession.get(event.sessionId) : undefined;
        if (!targetId) return;
        /**
         * `navigatedWithinDocument` is the union of Chrome's `onHistoryStateUpdated` *and*
         * `onReferenceFragmentUpdated`. Recording a bare `#hash` change as a navigation would
         * inflate the event stream and feed the macro detector phantom `open_url` actions, so
         * fragment-only navigations are dropped.
         */
        const navigationType = event.params.navigationType as string | undefined;
        if (navigationType === 'fragment') return;
        const url = event.params.url as string;
        if (navigationType === undefined) {
          // Older protocol without the field: fall back to comparing with the hash stripped.
          const previous = this.registry.byTarget(targetId)?.url ?? '';
          if (stripHash(previous) === stripHash(url)) return;
        }
        this.registry.navigated(targetId, url, true);
        return;
      }

      case 'Page.frameStartedLoading': {
        const targetId = event.sessionId ? this.targetBySession.get(event.sessionId) : undefined;
        if (targetId) this.registry.updateByTarget(targetId, { status: 'loading' });
        return;
      }

      case 'Page.loadEventFired':
      case 'Page.frameStoppedLoading': {
        const targetId = event.sessionId ? this.targetBySession.get(event.sessionId) : undefined;
        if (!targetId) return;
        this.registry.updateByTarget(targetId, { status: 'complete' });
        // The document's <title> is only parsed by now. `targetInfoChanged` usually reports it, but
        // it can land while the target is still mid-attach and be dropped, so confirm on load.
        void this.refreshTargetInfo(targetId, event.sessionId);
        return;
      }

      case 'Runtime.bindingCalled': {
        if (event.params.name !== COLLECTOR_BINDING) return;
        const targetId = event.sessionId ? this.targetBySession.get(event.sessionId) : undefined;
        if (!targetId) return;
        this.handleBindingPayload(targetId, String(event.params.payload ?? ''));
        return;
      }

      case 'Runtime.executionContextCreated': {
        // Bindings are per-context. Re-registering on every new context is what keeps the collector
        // alive across navigations and into newly created frames.
        const sessionId = event.sessionId;
        if (!sessionId) return;
        await cdp.trySend('Runtime.addBinding', { name: COLLECTOR_BINDING }, sessionId);
        return;
      }

      default:
        return;
    }
  }

  /** Re-reads a target's url/title from CDP and folds it into the registry. */
  private async refreshTargetInfo(targetId: string, sessionId?: string): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    const info = await cdp.trySend<{ targetInfo?: { url?: string; title?: string } }>(
      'Target.getTargetInfo',
      { targetId },
      sessionId,
    );
    if (!info?.targetInfo) return;
    this.registry.updateByTarget(targetId, {
      ...(info.targetInfo.url ? { url: info.targetInfo.url } : {}),
      ...(info.targetInfo.title ? { title: info.targetInfo.title } : {}),
    });
  }

  private async attachPage(
    info: { targetId: string; type: string; url?: string; title?: string },
    sessionId: string,
  ): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;

    this.sessions.set(info.targetId, sessionId);
    this.targetBySession.set(sessionId, info.targetId);

    // Which window this tab belongs to; needed for tabs.query({windowId}) and focusTab.
    let windowId = 1;
    const win = await cdp.trySend<{ windowId: number }>(
      'Browser.getWindowForTarget',
      { targetId: info.targetId },
      sessionId,
    );
    if (win?.windowId !== undefined) windowId = win.windowId;

    this.registry.add({ targetId: info.targetId, type: info.type, url: info.url, title: info.title }, windowId);

    await cdp.trySend('Page.enable', {}, sessionId);
    await cdp.trySend('Runtime.enable', {}, sessionId);
    await cdp.trySend('Runtime.addBinding', { name: COLLECTOR_BINDING }, sessionId);

    // `targetInfoChanged` can fire during the awaits above, while this target is not yet in the
    // registry, and those updates are dropped. Re-read the current info so a title that settled
    // early is not lost — it ends up in `ObservedAction.title`, which is what macro naming uses.
    const current = await cdp.trySend<{ targetInfo?: { url?: string; title?: string } }>(
      'Target.getTargetInfo',
      { targetId: info.targetId },
      sessionId,
    );
    if (current?.targetInfo) {
      this.registry.updateByTarget(info.targetId, {
        ...(current.targetInfo.url ? { url: current.targetInfo.url } : {}),
        ...(current.targetInfo.title ? { title: current.targetInfo.title } : {}),
      });
    }

    const source = this.collectorFor();
    if (source) {
      await cdp.trySend(
        'Page.addScriptToEvaluateOnNewDocument',
        { source, runImmediately: true },
        sessionId,
      );
    }

    // Child targets of this page (OOPIFs) should attach too, so clicks inside cross-origin frames
    // are recorded and replayable.
    await cdp.trySend(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );

    // Released last: the page stays paused until the collector is installed.
    await cdp.trySend('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  private handleBindingPayload(targetId: string, raw: string): void {
    let payload: {
      channel?: string;
      message?: unknown;
      visible?: boolean;
      hasFocus?: boolean;
      title?: string;
    };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const tab = this.registry.byTarget(targetId);
    if (!tab) return;

    if (payload.channel === 'visibility') {
      this.registry.reportVisible(targetId, payload.visible === true);
      // A visible page reporting document.hasFocus() is the closest thing CDP offers to
      // "the browser window is frontmost".
      if (payload.visible) this.setBrowserFocused(payload.hasFocus === true);
      return;
    }

    if (payload.channel === 'title') {
      const title = typeof payload.title === 'string' ? payload.title : '';
      if (title) this.registry.updateByTarget(targetId, { title });
      return;
    }

    if (payload.channel === 'runtime') {
      for (const fn of [...this.messageListeners]) {
        try {
          fn({ tabId: tab.id, frameId: 0, url: tab.url, message: payload.message });
        } catch (err) {
          console.error('[cadence] collector listener threw', err);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Tab operations
   * ---------------------------------------------------------------- */

  private sessionFor(tabId: number): string | undefined {
    const targetId = this.registry.targetFor(tabId);
    return targetId ? this.sessions.get(targetId) : undefined;
  }

  async createTab(props: { url?: string; active?: boolean; newWindow?: boolean }): Promise<RegistryTab> {
    const cdp = this.cdp;
    if (!cdp) throw new Error('no browser attached');

    const result = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: props.url ?? 'about:blank',
      ...(props.newWindow ? { newWindow: true } : {}),
    });

    // Wait briefly for auto-attach to register the target, so the caller gets a usable tab id.
    const tab = await this.waitForTarget(result.targetId, 3000);
    if (!tab) throw new Error('tab did not register');

    if (props.active === false) {
      // `Target.createTarget({background:true})` is unreliable across platforms (notably macOS), so
      // focus is corrected afterwards instead: callers such as `openUrlsAsGroup` and
      // `switchToSpace` end by focusing the tab they actually want.
    } else {
      await cdp.trySend('Target.activateTarget', { targetId: result.targetId });
    }
    return tab;
  }

  private async waitForTarget(targetId: string, timeoutMs: number): Promise<RegistryTab | null> {
    const existing = this.registry.byTarget(targetId);
    if (existing) return existing;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(this.registry.byTarget(targetId) ?? null);
      }, timeoutMs);
      const off = this.registry.subscribe((event) => {
        if (event.kind !== 'created' || event.tab.targetId !== targetId) return;
        clearTimeout(timer);
        off();
        resolve(event.tab);
      });
    });
  }

  async activateTab(tabId: number): Promise<void> {
    const targetId = this.registry.targetFor(tabId);
    if (!targetId || !this.cdp) return;
    await this.cdp.trySend('Target.activateTarget', { targetId });
    const session = this.sessions.get(targetId);
    if (session) await this.cdp.trySend('Page.bringToFront', {}, session);

    // Record it ourselves rather than waiting for the page to report its visibility.
    //
    // The injected reporter is the only activation signal for tabs the *user* switches, but it
    // cannot run on `chrome://` pages or the new tab page — so without this, activating one of
    // those would leave the registry pointing at the previously active tab. We just performed the
    // switch, so this is the one case where we have ground truth. The page's own report, when it
    // comes, is deduped against this and is a no-op.
    this.registry.reportVisible(targetId, true);
  }

  async closeTabs(tabIds: number[]): Promise<void> {
    if (!this.cdp) return;
    for (const tabId of tabIds) {
      const targetId = this.registry.targetFor(tabId);
      if (targetId) await this.cdp.trySend('Target.closeTarget', { targetId });
    }
  }

  async reloadTab(tabId: number): Promise<void> {
    const session = this.sessionFor(tabId);
    if (session && this.cdp) await this.cdp.trySend('Page.reload', {}, session);
  }

  async focusWindow(windowId: number): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.trySend('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' },
    });
  }

  async lastFocusedWindow(): Promise<{ id?: number; focused: boolean }> {
    // The window holding the visible tab is the focused one, as far as Cadence is concerned.
    // `focused` drives focus-flip.ts's isChromeFocused(), hence the Cadence-counts-too rule above.
    const active = this.registry.all().find((t) => t.active);
    return {
      id: active?.windowId ?? 1,
      focused: this.status.state === 'connected' && this.isBrowserFocused(),
    };
  }

  /**
   * `chrome.scripting.executeScript` over CDP.
   *
   * Runs in an isolated world per frame, matching the extension API: the page's own scripts cannot
   * observe or interfere, which matters because `lib/macro-injected.ts` reaches into React's value
   * tracker when typing.
   */
  async executeScript(args: {
    tabId: number;
    allFrames: boolean;
    source: string;
    timeoutMs?: number;
  }): Promise<{ result: unknown }[]> {
    const cdp = this.cdp;
    const session = this.sessionFor(args.tabId);
    if (!cdp || !session) return [];

    const frameIds: string[] = [];
    const tree = await cdp.trySend<{ frameTree: FrameTreeNode }>('Page.getFrameTree', {}, session);
    if (tree?.frameTree) collectFrames(tree.frameTree, frameIds, args.allFrames);

    const results: { result: unknown }[] = [];
    for (const frameId of frameIds) {
      const world = await cdp.trySend<{ executionContextId: number }>(
        'Page.createIsolatedWorld',
        { frameId, worldName: 'cadence', grantUniveralAccess: false },
        session,
      );
      if (!world?.executionContextId) continue;

      const evaluated = await cdp.trySend<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        {
          expression: args.source,
          contextId: world.executionContextId,
          returnByValue: true,
          awaitPromise: true,
        },
        session,
      );
      if (evaluated?.result) results.push({ result: evaluated.result.value });
    }
    return results;
  }

  async shutdown(): Promise<void> {
    this.cdp?.close();
    this.cdp = null;
    try {
      this.launched?.process.kill();
    } catch {
      /* already gone */
    }
    this.launched = null;
  }
}

interface FrameTreeNode {
  frame: { id: string };
  childFrames?: FrameTreeNode[];
}

function collectFrames(node: FrameTreeNode, out: string[], includeChildren: boolean): void {
  out.push(node.frame.id);
  if (!includeChildren) return;
  for (const child of node.childFrames ?? []) collectFrames(child, out, true);
}

function stripHash(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}
