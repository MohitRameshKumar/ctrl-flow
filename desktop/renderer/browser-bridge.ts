/**
 * Connects the native browser bridge to the `chrome.*` shim.
 *
 * Two directions:
 *  - **Calls out**: installs a `TabBackend` so `chrome.tabs` / `chrome.scripting` reach CDP.
 *  - **Events in**: replays tab, navigation and collector events into the shim's emitters, so
 *    `entrypoints/background.ts`'s listeners fire exactly as they do in the extension.
 */

import type { CadenceNative } from '../preload';
import type { InstalledShim } from './chrome-shim';
import { deliverMessage } from './chrome-shim';
import { setTabBackend, type ShimTab, type TabBackend } from './chrome-shim/tabs';

/** The registry's tab shape, as it arrives over IPC. */
interface WireTab {
  id: number;
  index: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  status: 'loading' | 'complete';
  pinned: boolean;
  incognito: boolean;
  groupId: number;
}

function toShimTab(raw: unknown): ShimTab {
  const t = raw as WireTab;
  return {
    id: t.id,
    index: t.index ?? 0,
    windowId: t.windowId ?? 1,
    url: t.url,
    title: t.title,
    active: t.active,
    status: t.status,
    pinned: t.pinned ?? false,
    incognito: t.incognito ?? false,
    groupId: t.groupId ?? -1,
  };
}

/**
 * The last tab known to be active.
 *
 * Cached because `chrome.commands.onCommand` hands `background.ts` a `tab` argument synchronously,
 * and the leader key's whole flow (`handleLeaderCommand` -> `showOverlay`) depends on having it.
 */
let lastActiveTab: ShimTab | null = null;

export function getActiveTabSync(): ShimTab | null {
  return lastActiveTab;
}

export function installBrowserBridge(native: CadenceNative, shim: InstalledShim): void {
  const backend: TabBackend = {
    query: async (info) => (await native.tabs.query(info)).map(toShimTab),
    get: async (tabId) => {
      const raw = await native.tabs.get(tabId);
      if (!raw) throw new Error(`no tab ${tabId}`);
      return toShimTab(raw);
    },
    create: async (props) => toShimTab(await native.tabs.create(props as Record<string, unknown>)),
    update: async (tabId, props) => {
      const raw = await native.tabs.update(tabId, props);
      return raw ? toShimTab(raw) : undefined;
    },
    remove: async (tabIds) => {
      await native.tabs.remove(Array.isArray(tabIds) ? tabIds : [tabIds]);
    },
    reload: (tabId) => native.tabs.reload(tabId),
    executeScript: (args) => native.tabs.executeScript(args),
    focusWindow: (windowId) => native.windows.focus(windowId),
    lastFocusedWindow: () => native.windows.lastFocused(),
    sendMessage: async () => {
      // The leader overlay is a native window on desktop, so nothing needs to message a page.
      throw new Error('no receiving end');
    },
  };

  setTabBackend(backend);

  native.browser.onEvent((event) => {
    switch (event.kind) {
      case 'created': {
        const tab = toShimTab(event.tab);
        if (tab.active) lastActiveTab = tab;
        shim.events.tabs.onCreated.emit(tab);
        return;
      }

      case 'removed':
        if (lastActiveTab?.id === event.tabId) lastActiveTab = null;
        shim.events.tabs.onRemoved.emit(event.tabId, {
          windowId: event.windowId,
          isWindowClosing: false,
        });
        return;

      case 'updated': {
        const tab = toShimTab(event.tab);
        if (tab.active) lastActiveTab = tab;
        else if (lastActiveTab?.id === tab.id) lastActiveTab = null;
        // Chrome reports only the changed fields; several listeners branch on `changeInfo.status`.
        shim.events.tabs.onUpdated.emit(event.tabId, event.changes, tab);
        return;
      }

      case 'activated': {
        const known = lastActiveTab;
        if (known?.id !== event.tabId) {
          // Refresh the cache; `query` is async but the common case is served by the `updated`
          // event below, which carries the full tab.
          void backend.get(event.tabId).then((t) => (lastActiveTab = t)).catch(() => undefined);
        }
        shim.events.tabs.onActivated.emit({ tabId: event.tabId, windowId: event.windowId });
        return;
      }

      case 'navigated': {
        const details = { tabId: event.tabId, url: event.url, frameId: 0 };
        /**
         * The two listeners `entrypoints/background.ts` registers, kept strictly apart.
         *
         * `onCommitted` records a real navigation and `onHistoryStateUpdated` an in-page one.
         * Commit 32e5be4 fixed these being inverted, and `tests/spa-flag.test.ts` guards it,
         * because Leader R's segment refinement depends on the distinction.
         */
        if (event.spa) shim.events.navigation.onHistoryStateUpdated.emit(details);
        else shim.events.navigation.onCommitted.emit(details);
        return;
      }

      default:
        return;
    }
  });

  /**
   * `chrome.windows.onFocusChanged`.
   *
   * `background.ts` compares the id against `WINDOW_ID_NONE` to decide between
   * `chrome_focus_lost` and `chrome_focus_gained`, so blur must report exactly that value.
   */
  native.browser.onFocusChanged((focused) => {
    const active = getActiveTabSync();
    shim.events.windows.onFocusChanged.emit(focused ? (active?.windowId ?? 1) : -1);
  });

  // Collector messages arrive as `chrome.runtime.onMessage` with a populated sender, which is what
  // `handleContentMessage` reads to attribute an event to a tab.
  native.browser.onCollectorMessage(({ tabId, frameId, url, message }) => {
    void deliverMessage(message, {
      tab: { id: tabId, url },
      frameId,
      url,
      id: 'cadence-desktop',
    });
  });
}
