import { vi } from 'vitest';

/**
 * A hand-rolled `chrome` stub. Small enough to read in one sitting and with no version coupling
 * to a mocking library, which matters more than completeness: the replay engine only touches a
 * dozen APIs.
 */
export interface StubTab {
  id: number;
  url: string;
  windowId?: number;
  status?: string;
}

export interface ChromeStubOptions {
  /** Tabs that are already open before the macro runs. */
  openTabs?: StubTab[];
  /** Per-selector click outcome. Anything unlisted succeeds. */
  clickResults?: Record<string, boolean>;
  /** Make executeScript reject instead of resolving. */
  executeScriptThrows?: boolean;
  /** Make tabs.create reject. */
  createThrows?: boolean;
}

export function installChromeStub(options: ChromeStubOptions = {}) {
  const { openTabs = [], clickResults = {}, executeScriptThrows = false, createThrows = false } = options;

  let nextTabId = 1000;
  const tabs = new Map<number, StubTab>();
  for (const tab of openTabs) {
    tabs.set(tab.id, { status: 'complete', windowId: 1, ...tab });
    nextTabId = Math.max(nextTabId, tab.id + 1);
  }

  const created: string[] = [];
  const grouped: number[][] = [];
  const groupTitles: string[] = [];
  const executed: { tabId: number; selector: string }[] = [];

  const stub = {
    tabs: {
      query: vi.fn(async () => [...tabs.values()]),
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`no tab ${id}`);
        return tab;
      }),
      create: vi.fn(async ({ url }: { url: string }) => {
        if (createThrows) throw new Error('tabs.create failed');
        const tab: StubTab = { id: nextTabId++, url, windowId: 1, status: 'complete' };
        tabs.set(tab.id, tab);
        created.push(url);
        return tab;
      }),
      group: vi.fn(async ({ tabIds }: { tabIds: number[] }) => {
        grouped.push(tabIds);
        return 77;
      }),
      update: vi.fn(async () => undefined),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabGroups: {
      update: vi.fn(async (_id: number, { title }: { title?: string }) => {
        if (title) groupTitles.push(title);
      }),
    },
    windows: {
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => undefined),
    },
    scripting: {
      executeScript: vi.fn(async ({ target, args }: { target: { tabId: number }; args: unknown[] }) => {
        if (executeScriptThrows) throw new Error('cannot access page');
        const selector = String(args[0]);
        executed.push({ tabId: target.tabId, selector });
        return [{ result: { clicked: clickResults[selector] !== false } }];
      }),
    },
    storage: {
      session: { set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = stub;
  return { stub, created, grouped, groupTitles, executed, tabs };
}

export function uninstallChromeStub(): void {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}
