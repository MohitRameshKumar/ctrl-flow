/**
 * `chrome.tabs`, `chrome.tabGroups`, `chrome.windows`, `chrome.webNavigation`, `chrome.scripting`.
 *
 * Everything real here is backed by the Chrome DevTools Protocol in the main process, reached
 * through an injectable `TabBackend`. P0 ships the null backend so the entire UI is usable with no
 * browser attached at all; P1/P2 swap in the CDP backend without touching this file's surface.
 *
 * ## Virtual tab groups
 *
 * CDP has no tabGroups domain, and there is no way to move an existing tab into another window. So
 * grouping is tracked here instead of in Chrome. The critical requirement is that `tabs.group`
 * **resolves rather than rejects**: `lib/spaces.ts`'s `switchToSpace` calls it without a try/catch,
 * so a rejection there would throw before `focusTab(firstTab)` and break the whole "switch to
 * space" leader action. (`macro-host-chrome.ts` and `lib/tabs.ts` do catch it, and both comment that
 * an ungrouped run is still perfectly usable.)
 *
 * `tabGroups.query({title})` answering from this map is what makes `restoreSpace` and
 * `switchToSpace` take their already-correct fallback paths with no changes to `lib/`.
 */

import { ShimEvent } from './events';

export interface ShimTab {
  id?: number;
  index: number;
  windowId: number;
  url?: string;
  title?: string;
  active: boolean;
  status?: 'loading' | 'complete';
  pinned: boolean;
  incognito: boolean;
  groupId: number;
  discarded?: boolean;
  frozen?: boolean;
}

export interface ShimTabGroup {
  id: number;
  title?: string;
  collapsed: boolean;
  windowId: number;
  color?: string;
}

/** Everything the tab shim needs from whatever is actually driving a browser. */
export interface TabBackend {
  query(info: Record<string, unknown>): Promise<ShimTab[]>;
  get(tabId: number): Promise<ShimTab>;
  create(props: { url?: string; active?: boolean; windowId?: number }): Promise<ShimTab>;
  update(tabId: number, props: Record<string, unknown>): Promise<ShimTab | undefined>;
  remove(tabIds: number | number[]): Promise<void>;
  reload(tabId: number): Promise<void>;
  /** Returns one result object per frame, matching `chrome.scripting.executeScript`. */
  executeScript(args: {
    tabId: number;
    allFrames: boolean;
    source: string;
  }): Promise<{ result: unknown }[]>;
  focusWindow(windowId: number): Promise<void>;
  lastFocusedWindow(): Promise<{ id?: number; focused: boolean }>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

const NULL_BACKEND: TabBackend = {
  query: async () => [],
  get: async () => {
    throw new Error('no browser attached');
  },
  create: async () => {
    throw new Error('no browser attached');
  },
  update: async () => undefined,
  remove: async () => {},
  reload: async () => {},
  executeScript: async () => [],
  focusWindow: async () => {},
  lastFocusedWindow: async () => ({ id: undefined, focused: false }),
  sendMessage: async () => {
    throw new Error('no receiving end');
  },
};

let backend: TabBackend = NULL_BACKEND;

export function setTabBackend(next: TabBackend): void {
  backend = next;
}

export function getTabBackend(): TabBackend {
  return backend;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export const tabEvents = {
  onCreated: new ShimEvent<(tab: ShimTab) => void>(),
  onRemoved: new ShimEvent<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void>(),
  onUpdated: new ShimEvent<
    (tabId: number, changeInfo: Record<string, unknown>, tab: ShimTab) => void
  >(),
  onActivated: new ShimEvent<(info: { tabId: number; windowId: number }) => void>(),
};

export const windowEvents = {
  onFocusChanged: new ShimEvent<(windowId: number) => void>(),
};

export const navigationEvents = {
  onCommitted: new ShimEvent<(details: { tabId: number; url: string; frameId: number }) => void>(),
  onHistoryStateUpdated: new ShimEvent<
    (details: { tabId: number; url: string; frameId: number }) => void
  >(),
};

/* ------------------------------------------------------------------ *
 * Virtual tab groups
 * ------------------------------------------------------------------ */

let nextGroupId = 1;
const groups = new Map<number, ShimTabGroup & { tabIds: number[] }>();

/** Hook P4 uses to turn "collapse a group" into "shelve these tabs". */
export type GroupCollapseHandler = (
  group: ShimTabGroup & { tabIds: number[] },
  collapsed: boolean,
) => void;

let onCollapse: GroupCollapseHandler | null = null;

export function setGroupCollapseHandler(fn: GroupCollapseHandler | null): void {
  onCollapse = fn;
}

export function createTabsShim() {
  const tabs = {
    async query(info: Record<string, unknown> = {}): Promise<ShimTab[]> {
      const all = await backend.query(info);
      if (info.groupId === undefined) return all;
      const group = groups.get(info.groupId as number);
      if (!group) return [];
      return all.filter((t) => t.id !== undefined && group.tabIds.includes(t.id));
    },

    get: (tabId: number) => backend.get(tabId),
    create: (props: { url?: string; active?: boolean; windowId?: number }) => backend.create(props),
    update: (tabId: number, props: Record<string, unknown>) => backend.update(tabId, props),
    remove: (tabIds: number | number[]) => backend.remove(tabIds),
    reload: (tabId: number) => backend.reload(tabId),
    sendMessage: (tabId: number, message: unknown, _options?: unknown) =>
      backend.sendMessage(tabId, message),

    /** Always resolves — see the note at the top of this file. */
    async group(options: { tabIds: number | number[]; groupId?: number }): Promise<number> {
      const ids = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
      if (options.groupId !== undefined && groups.has(options.groupId)) {
        const existing = groups.get(options.groupId)!;
        for (const id of ids) if (!existing.tabIds.includes(id)) existing.tabIds.push(id);
        return options.groupId;
      }
      const id = nextGroupId++;
      let windowId = -1;
      try {
        if (ids[0] !== undefined) windowId = (await backend.get(ids[0])).windowId;
      } catch {
        /* the tab may already be gone; the group is bookkeeping either way */
      }
      groups.set(id, { id, collapsed: false, windowId, tabIds: [...ids] });
      return id;
    },

    async ungroup(tabIds: number | number[]): Promise<void> {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const group of groups.values()) {
        group.tabIds = group.tabIds.filter((id) => !ids.includes(id));
      }
    },

    ...tabEvents,
  };

  const tabGroups = {
    async update(groupId: number, props: { title?: string; collapsed?: boolean; color?: string }) {
      const group = groups.get(groupId);
      if (!group) return undefined;
      if (props.title !== undefined) group.title = props.title;
      if (props.color !== undefined) group.color = props.color;
      if (props.collapsed !== undefined && props.collapsed !== group.collapsed) {
        group.collapsed = props.collapsed;
        onCollapse?.(group, props.collapsed);
      }
      return { ...group };
    },

    async query(info: { title?: string; collapsed?: boolean } = {}): Promise<ShimTabGroup[]> {
      return [...groups.values()]
        .filter((g) => info.title === undefined || g.title === info.title)
        .filter((g) => info.collapsed === undefined || g.collapsed === info.collapsed)
        .map((g) => ({ id: g.id, title: g.title, collapsed: g.collapsed, windowId: g.windowId }));
    },

    TAB_GROUP_ID_NONE: -1,
  };

  return { tabs, tabGroups };
}

/** Test seam. */
export const __test = { groups, reset: () => { groups.clear(); nextGroupId = 1; } };
