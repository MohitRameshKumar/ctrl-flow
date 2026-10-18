/**
 * Installs `globalThis.chrome`.
 *
 * This is the whole bet of the desktop port: rather than rewriting the 41 modules in `lib/` against
 * a new browser abstraction, provide exactly the `chrome.*` surface they already use. Every module
 * in `lib/` and all 16 components in `entrypoints/sidepanel/` then run unchanged, and Dexie keeps
 * working because an Electron renderer *is* Chromium.
 *
 * `installChromeShim()` must be awaited before anything from `@/lib` is imported, because the
 * storage mirror has to be primed first. `desktop/renderer/main.tsx` does that with a dynamic
 * import.
 *
 * A few members are deliberately *values* rather than functions, because the codebase compares
 * against them directly: `windows.WINDOW_ID_NONE` (`background.ts` tests focus changes against it)
 * and `runtime.ContextType.SIDE_PANEL` (`macros.ts` and `spaces.ts` pass it to `getContexts`).
 */

import type { CadenceNative } from '../../preload';
import { ShimEvent } from './events';
import { createStorage } from './storage';
import { createAlarmsShim } from './alarms';
import {
  createTabsShim,
  navigationEvents,
  tabEvents,
  windowEvents,
  getTabBackend,
} from './tabs';

declare global {
  interface Window {
    cadenceNative: CadenceNative;
  }
}

const RUNTIME_ID = 'cadence-desktop';
const WINDOW_ID_NONE = -1;

/** Mirrors `chrome.runtime.MessageSender` for the fields the collector path reads. */
export interface ShimSender {
  tab?: { id?: number; url?: string; windowId?: number; title?: string };
  frameId?: number;
  url?: string;
  id?: string;
}

export type MessageListener = (
  message: unknown,
  sender: ShimSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

const onMessage = new ShimEvent<MessageListener>();

/**
 * Delivers a message to `runtime.onMessage` listeners.
 *
 * Used both by in-renderer `sendMessage` calls and, from P1, by the CDP collector relaying messages
 * that originated in a real page.
 */
export function deliverMessage(message: unknown, sender: ShimSender): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const respond = (response?: unknown) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    onMessage.emit(message, sender, respond);
    // Listeners that do not return true have no async response; don't leave the caller hanging.
    if (!settled) setTimeout(() => respond(undefined), 0);
  });
}

const notificationEvents = {
  onButtonClicked: new ShimEvent<(notificationId: string, buttonIndex: number) => void>(),
  onClicked: new ShimEvent<(notificationId: string) => void>(),
  onClosed: new ShimEvent<(notificationId: string, byUser: boolean) => void>(),
};

const commandEvents = {
  onCommand: new ShimEvent<(command: string, tab?: unknown) => void>(),
};

const lifecycleEvents = {
  onInstalled: new ShimEvent<(details: { reason: string }) => void>(),
  onStartup: new ShimEvent<() => void>(),
};

/** Registered shortcuts, so `commands.getAll()` can report the truth. */
const registeredCommands: { name: string; shortcut: string; description: string }[] = [];

export function setRegisteredCommands(
  next: { name: string; shortcut: string; description: string }[],
): void {
  registeredCommands.length = 0;
  registeredCommands.push(...next);
}

export interface InstalledShim {
  /** Fired after `lib/` has had a chance to register listeners. */
  fireLifecycle(firstRun: boolean): void;
  events: {
    tabs: typeof tabEvents;
    windows: typeof windowEvents;
    navigation: typeof navigationEvents;
    notifications: typeof notificationEvents;
    commands: typeof commandEvents;
  };
}

export async function installChromeShim(native: CadenceNative): Promise<InstalledShim> {
  const storage = await createStorage(native);
  const alarms = createAlarmsShim();
  const { tabs, tabGroups } = createTabsShim();

  const platform = await native.platformInfo();

  native.toast.onButtonClicked(({ notificationId, buttonIndex }) =>
    notificationEvents.onButtonClicked.emit(notificationId, buttonIndex),
  );
  native.toast.onClicked((id) => notificationEvents.onClicked.emit(id));
  // `commands.onCommand` is deliberately NOT wired here: `leader-bridge.ts` subscribes instead, so
  // it can attach the active tab that `handleLeaderCommand` needs.

  const runtime = {
    id: RUNTIME_ID,

    /** Cadence's own pages are served from the renderer origin, so this is just a resolve. */
    getURL: (path: string) => new URL(path.startsWith('/') ? path : `/${path}`, location.origin).toString(),

    /**
     * Only `oauth2.client_id` is read, by `lib/calendar.ts`, which short-circuits to the bundled
     * demo calendar when the id still contains `TODO`. Reporting the placeholder keeps the Google
     * Calendar path disabled exactly as it is in the extension today.
     */
    getManifest: () => ({
      name: 'Cadence',
      version: '0.1.0',
      oauth2: { client_id: 'TODO-paste-oauth-client-id.apps.googleusercontent.com' },
    }),

    getPlatformInfo: () => Promise.resolve({ os: platform.os, arch: platform.arch }),

    /**
     * Answers "is the panel open?".
     *
     * `lib/macros.ts` and `lib/spaces.ts` use this to choose between an in-panel banner and a
     * notification. The honest desktop equivalent is whether the Cadence window is actually on
     * screen. Both call sites wrap it in try/catch and treat failure as "not open".
     */
    getContexts: async (filter: { contextTypes?: string[] } = {}) => {
      const wantsPanel =
        !filter.contextTypes || filter.contextTypes.includes('SIDE_PANEL');
      if (!wantsPanel) return [];
      const visible = await native.window.isVisible();
      return visible ? [{ contextType: 'SIDE_PANEL', documentUrl: location.href }] : [];
    },

    ContextType: {
      TAB: 'TAB',
      POPUP: 'POPUP',
      BACKGROUND: 'BACKGROUND',
      OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT',
      SIDE_PANEL: 'SIDE_PANEL',
    },

    sendMessage: (message: unknown) =>
      deliverMessage(message, { id: RUNTIME_ID, url: location.href }),

    onMessage,
    ...lifecycleEvents,
    lastError: undefined as { message: string } | undefined,
  };

  const notifications = {
    create: async (idOrOptions: string | Record<string, unknown>, maybeOptions?: Record<string, unknown>) => {
      const id = typeof idOrOptions === 'string' ? idOrOptions : `cadence-${Date.now()}`;
      const options = (typeof idOrOptions === 'string' ? maybeOptions : idOrOptions) ?? {};
      await native.toast.create(id, {
        title: String(options.title ?? 'Cadence'),
        message: String(options.message ?? ''),
        buttons: (options.buttons as { title: string }[] | undefined) ?? undefined,
        requireInteraction: Boolean(options.requireInteraction),
      });
      return id;
    },
    clear: async (id: string) => {
      await native.toast.clear(id);
      return true;
    },
    ...notificationEvents,
  };

  const action = {
    setBadgeText: (details: { text?: string }) => native.badge.set({ text: details.text }),
    setBadgeBackgroundColor: (details: { color?: string }) =>
      native.badge.set({ color: typeof details.color === 'string' ? details.color : undefined }),
    setTitle: (details: { title?: string }) => native.badge.set({ title: details.title }),
  };

  const windows = {
    WINDOW_ID_NONE,
    WINDOW_ID_CURRENT: -2,
    getLastFocused: () => getTabBackend().lastFocusedWindow(),
    update: async (windowId: number, props: { focused?: boolean }) => {
      if (props.focused) await getTabBackend().focusWindow(windowId);
      return { id: windowId };
    },
    ...windowEvents,
  };

  const sidePanel = {
    /** No gesture constraint here, unlike the extension — this is just "show the app". */
    open: () => native.window.show(),
    setPanelBehavior: () => Promise.resolve(),
  };

  const commands = {
    getAll: () => Promise.resolve([...registeredCommands]),
    ...commandEvents,
  };

  const scripting = {
    /**
     * `chrome.scripting.executeScript({target:{tabId,allFrames}, func, args})`.
     *
     * The function is serialized with `Function.prototype.toString()` and evaluated in the page,
     * which is exactly what the extension API does. `lib/macro-injected.ts` is written for this —
     * its header notes that every helper is duplicated inside each injected function "because the
     * API forces it" — so the functions are already self-contained. The desktop renderer build
     * therefore must not minify or mangle them; see `electron.vite.config.ts`.
     */
    executeScript: async (injection: {
      target: { tabId: number; allFrames?: boolean };
      func?: (...args: never[]) => unknown;
      args?: unknown[];
      files?: string[];
    }) => {
      if (!injection.func) {
        // The only `files` caller was the leader overlay's re-injection fallback, which the
        // native overlay window replaces outright.
        return [];
      }
      const source = `(${injection.func.toString()}).apply(null, ${JSON.stringify(injection.args ?? [])})`;
      return getTabBackend().executeScript({
        tabId: injection.target.tabId,
        allFrames: injection.target.allFrames ?? false,
        source,
      });
    },
  };

  const webNavigation = { ...navigationEvents };

  const identity = {
    /** Not implemented; `lib/calendar.ts` never reaches it while the client id is a placeholder. */
    getAuthToken: () => Promise.reject(new Error('OAuth is not configured on desktop')),
  };

  const shim = {
    storage,
    alarms,
    tabs,
    tabGroups,
    windows,
    webNavigation,
    scripting,
    notifications,
    action,
    sidePanel,
    commands,
    runtime,
    identity,
  };

  (globalThis as unknown as { chrome: unknown }).chrome = shim;

  return {
    fireLifecycle(firstRun: boolean) {
      if (firstRun) lifecycleEvents.onInstalled.emit({ reason: 'install' });
      lifecycleEvents.onStartup.emit();
    },
    events: {
      tabs: tabEvents,
      windows: windowEvents,
      navigation: navigationEvents,
      notifications: notificationEvents,
      commands: commandEvents,
    },
  };
}
