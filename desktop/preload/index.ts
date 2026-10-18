/**
 * The only bridge between the renderers and the main process.
 *
 * Deliberately thin: it forwards typed calls and nothing else. All the interesting work — turning
 * these primitives back into a `chrome.*` surface — happens in `desktop/renderer/chrome-shim/`,
 * where it can be unit-tested without Electron.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  INVOKE,
  PUSH,
  type AiFetchRequest,
  type AiFetchResponse,
  type BadgeState,
  type StorageArea,
  type StorageChangedPayload,
  type ToastButtonClicked,
  type ToastOptions,
} from '../shared/ipc';

export interface CadenceNative {
  storage: {
    get(area: StorageArea, keys: string | string[] | null): Promise<Record<string, unknown>>;
    set(area: StorageArea, items: Record<string, unknown>): Promise<void>;
    remove(area: StorageArea, keys: string | string[]): Promise<void>;
    clear(area: StorageArea): Promise<void>;
    onChanged(cb: (payload: StorageChangedPayload) => void): () => void;
  };
  window: {
    show(): Promise<void>;
    isVisible(): Promise<boolean>;
  };
  badge: {
    set(state: BadgeState): Promise<void>;
  };
  toast: {
    create(id: string, options: ToastOptions): Promise<void>;
    clear(id: string): Promise<void>;
    onButtonClicked(cb: (payload: ToastButtonClicked) => void): () => void;
    onClicked(cb: (notificationId: string) => void): () => void;
  };
  ai: {
    fetch(req: AiFetchRequest): Promise<AiFetchResponse>;
  };
  browser: {
    launch(settings: Record<string, unknown>): Promise<BrowserStatusPayload>;
    status(): Promise<BrowserStatusPayload>;
    shutdown(): Promise<void>;
    onStatus(cb: (status: BrowserStatusPayload) => void): () => void;
    onEvent(cb: (event: BrowserEventPayload) => void): () => void;
    onFocusChanged(cb: (focused: boolean) => void): () => void;
    onCollectorMessage(cb: (msg: CollectorMessagePayload) => void): () => void;
  };
  tabs: {
    query(info: Record<string, unknown>): Promise<unknown[]>;
    get(tabId: number): Promise<unknown>;
    create(props: Record<string, unknown>): Promise<unknown>;
    update(tabId: number, props: Record<string, unknown>): Promise<unknown>;
    remove(tabIds: number[]): Promise<void>;
    reload(tabId: number): Promise<void>;
    executeScript(args: { tabId: number; allFrames: boolean; source: string }): Promise<{ result: unknown }[]>;
  };
  windows: {
    focus(windowId: number): Promise<void>;
    lastFocused(): Promise<{ id?: number; focused: boolean }>;
  };
  overlay: {
    show(payload: unknown): Promise<void>;
    preview(payload: { text: string; runnable: boolean }): Promise<void>;
    notice(text: string): Promise<void>;
    hide(): Promise<void>;
    onMessage(cb: (message: unknown) => void): () => void;
  };
  commands: {
    getAll(): Promise<{ name: string; shortcut: string; description: string }[]>;
    onRegistered(cb: (commands: { name: string; shortcut: string; description: string }[]) => void): () => void;
  };
  onCommand(cb: (command: string) => void): () => void;
  platformInfo(): Promise<{ os: string; arch: string }>;
  appPaths(): Promise<{ userData: string; appPath: string }>;
}

export interface BrowserStatusPayload {
  state: 'idle' | 'launching' | 'connected' | 'disconnected' | 'error';
  browserName?: string;
  error?: string;
}

export type BrowserEventPayload =
  | { kind: 'created'; tab: Record<string, unknown> }
  | { kind: 'removed'; tabId: number; windowId: number }
  | { kind: 'updated'; tabId: number; changes: Record<string, unknown>; tab: Record<string, unknown> }
  | { kind: 'activated'; tabId: number; windowId: number }
  | { kind: 'navigated'; tabId: number; url: string; spa: boolean };

export interface CollectorMessagePayload {
  tabId: number;
  frameId: number;
  url: string;
  message: unknown;
}

/** Subscribes and returns an unsubscribe, so shim listeners can be removed properly. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const native: CadenceNative = {
  storage: {
    get: (area, keys) => ipcRenderer.invoke(INVOKE.storageGet, area, keys),
    set: (area, items) => ipcRenderer.invoke(INVOKE.storageSet, area, items),
    remove: (area, keys) => ipcRenderer.invoke(INVOKE.storageRemove, area, keys),
    clear: (area) => ipcRenderer.invoke(INVOKE.storageClear, area),
    onChanged: (cb) => on<StorageChangedPayload>(PUSH.storageChanged, cb),
  },
  window: {
    show: () => ipcRenderer.invoke(INVOKE.windowShow),
    isVisible: () => ipcRenderer.invoke(INVOKE.windowIsVisible),
  },
  badge: {
    set: (state) => ipcRenderer.invoke(INVOKE.badgeSet, state),
  },
  toast: {
    create: (id, options) => ipcRenderer.invoke(INVOKE.toastCreate, id, options),
    clear: (id) => ipcRenderer.invoke(INVOKE.toastClear, id),
    onButtonClicked: (cb) => on<ToastButtonClicked>(PUSH.toastButtonClicked, cb),
    onClicked: (cb) => on<string>(PUSH.toastClicked, cb),
  },
  ai: {
    fetch: (req) => ipcRenderer.invoke(INVOKE.aiFetch, req),
  },
  browser: {
    launch: (settings) => ipcRenderer.invoke(INVOKE.browserLaunch, settings),
    status: () => ipcRenderer.invoke(INVOKE.browserStatus),
    shutdown: () => ipcRenderer.invoke(INVOKE.browserShutdown),
    onStatus: (cb) => on<BrowserStatusPayload>(PUSH.browserStatus, cb),
    onEvent: (cb) => on<BrowserEventPayload>(PUSH.browserEvent, cb),
    onFocusChanged: (cb) => on<boolean>(PUSH.browserFocus, cb),
    onCollectorMessage: (cb) => on<CollectorMessagePayload>(PUSH.collectorMessage, cb),
  },
  tabs: {
    query: (info) => ipcRenderer.invoke(INVOKE.tabsQuery, info),
    get: (tabId) => ipcRenderer.invoke(INVOKE.tabsGet, tabId),
    create: (props) => ipcRenderer.invoke(INVOKE.tabsCreate, props),
    update: (tabId, props) => ipcRenderer.invoke(INVOKE.tabsUpdate, tabId, props),
    remove: (tabIds) => ipcRenderer.invoke(INVOKE.tabsRemove, tabIds),
    reload: (tabId) => ipcRenderer.invoke(INVOKE.tabsReload, tabId),
    executeScript: (args) => ipcRenderer.invoke(INVOKE.tabsExecuteScript, args),
  },
  windows: {
    focus: (windowId) => ipcRenderer.invoke(INVOKE.windowsFocus, windowId),
    lastFocused: () => ipcRenderer.invoke(INVOKE.windowsLastFocused),
  },
  overlay: {
    show: (payload) => ipcRenderer.invoke(INVOKE.overlayShow, payload),
    preview: (payload) => ipcRenderer.invoke(INVOKE.overlayPreview, payload),
    notice: (text) => ipcRenderer.invoke(INVOKE.overlayNotice, text),
    hide: () => ipcRenderer.invoke(INVOKE.overlayHide),
    onMessage: (cb) => on<unknown>(PUSH.overlayMessage, cb),
  },
  commands: {
    getAll: () => ipcRenderer.invoke(INVOKE.commandsGetAll),
    onRegistered: (cb) => on<{ name: string; shortcut: string; description: string }[]>(PUSH.registeredCommands, cb),
  },
  onCommand: (cb) => on<string>(PUSH.command, cb),
  platformInfo: () => ipcRenderer.invoke(INVOKE.platformInfo),
  appPaths: () => ipcRenderer.invoke(INVOKE.appPaths),
};

contextBridge.exposeInMainWorld('cadenceNative', native);
