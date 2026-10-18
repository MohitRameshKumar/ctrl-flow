/**
 * The IPC contract between the Electron main process and the renderers.
 *
 * One file so the channel names and payload shapes cannot drift between the two sides. Everything
 * the `chrome.*` shim needs from the native side goes through here.
 */

export type StorageArea = 'local' | 'session';

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

/** Mirrors `chrome.storage.onChanged`'s two arguments. */
export interface StorageChangedPayload {
  area: StorageArea;
  changes: Record<string, StorageChange>;
}

export interface BadgeState {
  text?: string;
  color?: string;
  title?: string;
}

/** Mirrors the subset of `chrome.notifications.NotificationOptions` the codebase actually passes. */
export interface ToastOptions {
  title: string;
  message: string;
  buttons?: { title: string }[];
  /** Cadence's own notification ids are prefix-routed by `lib/notifications.ts`. */
  requireInteraction?: boolean;
}

export interface ToastButtonClicked {
  notificationId: string;
  buttonIndex: number;
}

export interface AiFetchRequest {
  url: string;
  token: string;
  body: string;
  timeoutMs: number;
}

export interface AiFetchResponse {
  status: number | null;
  body: unknown;
  error?: string;
}

/** Invoke channels: renderer -> main, with a reply. */
export const INVOKE = {
  storageGet: 'cadence:storage:get',
  storageSet: 'cadence:storage:set',
  storageRemove: 'cadence:storage:remove',
  storageClear: 'cadence:storage:clear',

  windowShow: 'cadence:window:show',
  windowIsVisible: 'cadence:window:isVisible',

  badgeSet: 'cadence:badge:set',

  toastCreate: 'cadence:toast:create',
  toastClear: 'cadence:toast:clear',

  aiFetch: 'cadence:ai:fetch',

  platformInfo: 'cadence:platform:info',
  appPaths: 'cadence:app:paths',

  browserLaunch: 'cadence:browser:launch',
  browserStatus: 'cadence:browser:status',
  browserShutdown: 'cadence:browser:shutdown',

  tabsQuery: 'cadence:tabs:query',
  tabsGet: 'cadence:tabs:get',
  tabsCreate: 'cadence:tabs:create',
  tabsUpdate: 'cadence:tabs:update',
  tabsRemove: 'cadence:tabs:remove',
  tabsReload: 'cadence:tabs:reload',
  tabsExecuteScript: 'cadence:tabs:executeScript',
  windowsFocus: 'cadence:windows:focus',
  windowsLastFocused: 'cadence:windows:lastFocused',

  overlayShow: 'cadence:overlay:showMenu',
  overlayPreview: 'cadence:overlay:showPreview',
  overlayNotice: 'cadence:overlay:showNotice',
  overlayHide: 'cadence:overlay:hideMenu',

  commandsGetAll: 'cadence:commands:getAll',
} as const;

/** Channels used only between the main process and the leader overlay window. */
export const OVERLAY = {
  show: 'cadence:overlay:show',
  preview: 'cadence:overlay:preview',
  notice: 'cadence:overlay:notice',
  message: 'cadence:overlay:message',
  close: 'cadence:overlay:close',
  resize: 'cadence:overlay:resize',
} as const;

/** Push channels: main -> renderer, fire and forget. */
export const PUSH = {
  storageChanged: 'cadence:storage:changed',
  toastButtonClicked: 'cadence:toast:buttonClicked',
  toastClicked: 'cadence:toast:clicked',
  command: 'cadence:command',
  /** A key press from the leader overlay window, routed to runtime.onMessage. */
  overlayMessage: 'cadence:overlay:fromWindow',
  /** The shortcuts that actually bound, for chrome.commands.getAll(). */
  registeredCommands: 'cadence:commands:registered',
  browserStatus: 'cadence:browser:statusChanged',
  /** Effective browser focus, for chrome.windows.onFocusChanged. */
  browserFocus: 'cadence:browser:focus',
  /** Tab/navigation events, replayed into the shim's chrome.tabs + chrome.webNavigation emitters. */
  browserEvent: 'cadence:browser:event',
  /** A message from the injected collector, delivered to chrome.runtime.onMessage. */
  collectorMessage: 'cadence:browser:collectorMessage',
} as const;

/**
 * Keys in the session store that must not survive a Chrome restart.
 *
 * `lib/macro-run-channel.ts` explains the contract it relies on: "the browser clears it on restart
 * so a crashed run cannot haunt the next session." On desktop the Cadence app outlives the browser
 * it drives, so the main process has to honor that explicitly.
 *
 * Two of these are actively dangerous if they leak across a Chrome restart:
 * `macroReplayInProgress` makes `writeEvent` return early, silently killing all event collection;
 * `activeTabsSeeded` makes `seedActiveTabs()` skip, so the tab the user starts on stays invisible.
 */
export const SESSION_IS_CLEARED_ON_BROWSER_RESTART = true;
