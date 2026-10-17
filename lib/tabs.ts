/**
 * Shared tab primitives.
 *
 * The create-tabs / group / name / focus block is currently written out three times across
 * `rituals.openRitualDocs`, `spaces.shelveSpace` and `spaces.restoreSpace`. Macro replay needs
 * the same thing, so it lives here once. Those three are not repointed at it yet — that is a
 * follow-up, not something to do to working code on deadline day.
 */

import { normalizeUrl } from './normalize';

export async function findOpenTabIdsForUrls(urls: Set<string>): Promise<number[]> {
  const tabs = await chrome.tabs.query({});
  const ids: number[] = [];
  for (const tab of tabs) {
    if (!tab.url || tab.id === undefined) continue;
    const normalized = normalizeUrl(tab.url);
    if (normalized && urls.has(normalized.url)) ids.push(tab.id);
  }
  return ids;
}

export async function findOpenTabIdForUrl(url: string): Promise<number | undefined> {
  const [id] = await findOpenTabIdsForUrls(new Set([url]));
  return id;
}

export async function focusTab(tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (!tab?.id) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

/**
 * Waits for a tab to finish loading.
 *
 * Reports which happened. The earlier version resolved identically on success and on timeout, so
 * a caller had no way to tell "loaded" from "gave up" and would go on to inject into a page that
 * was never ready, reporting a confusing "element not found" instead of the real cause.
 */
export function waitForTabComplete(
  tabId: number,
  timeoutMs: number,
): Promise<'complete' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'complete' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(result);
    };

    const onUpdated = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish('complete');
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish('complete');
      })
      // The tab is gone; treat that as a timeout rather than hanging until the timer fires.
      .catch(() => finish('timeout'));
  });
}

export interface OpenedTab {
  url: string;
  tabId?: number;
  /** False when an already-open tab was reused rather than a new one created. */
  created: boolean;
  error?: string;
}

export interface OpenUrlsResult {
  tabs: OpenedTab[];
  groupId?: number;
}

export interface OpenUrlsOptions {
  collapsed?: boolean;
  focus?: boolean;
  /** Reuse a tab already showing the URL instead of opening a duplicate. Default true. */
  reuseExisting?: boolean;
}

/**
 * Opens (or reuses) one tab per URL and collects them into a single named tab group.
 *
 * All tabs are created in the same window because `chrome.tabs.group` requires it — a constraint
 * `openRitualDocs` currently relies on implicitly.
 */
export async function openUrlsAsGroup(
  urls: string[],
  title: string,
  options: OpenUrlsOptions = {},
): Promise<OpenUrlsResult> {
  const { collapsed = false, focus = true, reuseExisting = true } = options;
  if (urls.length === 0) return { tabs: [] };

  const existing = reuseExisting ? await findExistingTabIds(urls) : new Map<string, number>();

  let windowId: number | undefined;
  try {
    windowId = (await chrome.windows.getLastFocused()).id;
  } catch {
    windowId = undefined;
  }

  const opened: OpenedTab[] = [];
  for (const url of urls) {
    const reused = existing.get(url);
    if (reused !== undefined) {
      opened.push({ url, tabId: reused, created: false });
      continue;
    }
    try {
      const tab = await chrome.tabs.create({ url, active: false, windowId });
      opened.push({ url, tabId: tab.id, created: true });
    } catch (err) {
      opened.push({ url, created: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const tabIds = opened.map((t) => t.tabId).filter((id): id is number => id !== undefined);
  const firstTabId = tabIds[0];
  if (firstTabId === undefined) return { tabs: opened };

  let groupId: number | undefined;
  try {
    groupId = await chrome.tabs.group({ tabIds: [firstTabId, ...tabIds.slice(1)] });
    await chrome.tabGroups.update(groupId, { title, collapsed });
  } catch (err) {
    console.error('[cadence] grouping tabs failed', err);
  }

  if (focus) {
    try {
      await focusTab(await chrome.tabs.get(firstTabId));
    } catch (err) {
      console.error('[cadence] focusing first tab failed', err);
    }
  }

  return { tabs: opened, groupId };
}

async function findExistingTabIds(urls: string[]): Promise<Map<string, number>> {
  const wanted = new Set(urls);
  const found = new Map<string, number>();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || tab.id === undefined) continue;
    const normalized = normalizeUrl(tab.url);
    if (!normalized || !wanted.has(normalized.url) || found.has(normalized.url)) continue;
    found.set(normalized.url, tab.id);
  }
  return found;
}
