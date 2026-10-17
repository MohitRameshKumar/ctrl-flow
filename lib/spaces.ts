import { runTask } from './ai';
import {
  addShelf,
  addSpaceUrl,
  createSpace,
  deleteShelf,
  getEventsByKind,
  getLatestShelfForSpace,
  getSpaceById,
  getSpaceUrlByUrl,
  getSpaceUrls,
  getSpaceUrlsForSpace,
  getSpaces,
} from './db';
import { normalizeUrl } from './normalize';
import { getBlocklist, isBlocklisted } from './privacy';
import { checkForSwitch, neverSwitchForSpace, recordSwitchOffer, type SwitchCandidate } from './switch-detection';
import type { AssignTabsInput, AssignTabsOutput, NameSpacesInput, NameSpacesOutput, Space } from './types';

export const SPACE_NOTIFICATION_PREFIX = 'cadence-space:';
export const SPACE_RECOMPUTE_ALARM = 'cadence-space-recompute';
export const SWITCH_CHECK_ALARM = 'cadence-switch-check';
const PENDING_SWITCH_KEY = 'pendingSwitchSuggestion';

const ACTIVATION_WINDOW_MS = 48 * 60 * 60 * 1000;
const RECENT_TYPING_WINDOW_MS = 2 * 60 * 1000;

export interface Candidate {
  url: string;
  title?: string;
}

async function getCandidateUrls(): Promise<Candidate[]> {
  const blocklist = await getBlocklist();
  const candidates = new Map<string, Candidate>();

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url) continue;
    const normalized = normalizeUrl(tab.url);
    if (!normalized || isBlocklisted(normalized.domain, blocklist)) continue;
    candidates.set(normalized.url, { url: normalized.url, title: tab.title });
  }

  const now = Date.now();
  const events = await getEventsByKind('tab_activated', now - ACTIVATION_WINDOW_MS, now);
  for (const e of events) {
    if (!e.url || candidates.has(e.url)) continue;
    candidates.set(e.url, { url: e.url, title: e.title });
  }

  return [...candidates.values()];
}

/** Currently open tabs with no spaceUrls entry yet — for the Spaces tab's "Unassigned" section. */
export async function getUnassignedOpenTabs(): Promise<Candidate[]> {
  const blocklist = await getBlocklist();
  const tabs = await chrome.tabs.query({});
  const seen = new Set<string>();
  const result: Candidate[] = [];

  for (const tab of tabs) {
    if (!tab.url) continue;
    const normalized = normalizeUrl(tab.url);
    if (!normalized || isBlocklisted(normalized.domain, blocklist)) continue;
    if (seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    if (await isAlreadyAssigned(normalized.url)) continue;
    result.push({ url: normalized.url, title: tab.title });
  }

  return result;
}

/** Defensive guard: never let a recompute touch a URL that's already tracked (AI- or user-sourced). */
async function isAlreadyAssigned(url: string): Promise<boolean> {
  return (await getSpaceUrlByUrl(url)) !== undefined;
}

async function applyNameSpacesResult(aiSpaces: NameSpacesOutput, candidates: Candidate[]): Promise<void> {
  const titleByUrl = new Map(candidates.map((c) => [c.url, c.title]));
  const now = Date.now();

  for (const aiSpace of aiSpaces) {
    const spaceId = await createSpace({ name: aiSpace.name, status: 'ai', createdAt: now, updatedAt: now });
    if (spaceId === undefined) continue;
    for (const url of aiSpace.urls) {
      if (await isAlreadyAssigned(url)) continue;
      await addSpaceUrl({ spaceId, url, title: titleByUrl.get(url), source: 'ai', alwaysOpen: false });
    }
  }
}

async function applyAssignTabsResult(
  assignments: AssignTabsOutput,
  candidates: Candidate[],
  existingSpaces: Space[],
): Promise<void> {
  const titleByUrl = new Map(candidates.map((c) => [c.url, c.title]));
  const now = Date.now();
  const spaceByName = new Map(existingSpaces.map((s) => [s.name, s]));

  for (const a of assignments) {
    if (await isAlreadyAssigned(a.url)) continue;

    let targetSpaceId: number | undefined;
    if (a.spaceName) {
      targetSpaceId = spaceByName.get(a.spaceName)?.id;
    } else if (a.newSpaceName) {
      let space = spaceByName.get(a.newSpaceName);
      if (!space) {
        const id = await createSpace({ name: a.newSpaceName, status: 'ai', createdAt: now, updatedAt: now });
        space = { id, name: a.newSpaceName, status: 'ai', createdAt: now, updatedAt: now };
        spaceByName.set(a.newSpaceName, space);
      }
      targetSpaceId = space.id;
    }
    if (targetSpaceId === undefined) continue;

    await addSpaceUrl({ spaceId: targetSpaceId, url: a.url, title: titleByUrl.get(a.url), source: 'ai', alwaysOpen: false });
  }
}

/** Groups candidates by domain into "auto (offline)" spaces when the AI call fails. */
export async function applyDomainFallback(candidates: Candidate[]): Promise<void> {
  const now = Date.now();
  const existingSpaces = await getSpaces();
  const byDomain = new Map<string, Candidate[]>();

  for (const c of candidates) {
    let domain: string;
    try {
      domain = new URL(c.url).hostname;
    } catch {
      continue;
    }
    const list = byDomain.get(domain) ?? [];
    list.push(c);
    byDomain.set(domain, list);
  }

  for (const [domain, urls] of byDomain) {
    let space = existingSpaces.find((s) => s.name === domain);
    let spaceId: number | undefined;
    if (space?.id !== undefined) {
      spaceId = space.id;
    } else {
      spaceId = await createSpace({ name: domain, status: 'auto_offline', createdAt: now, updatedAt: now });
      if (spaceId === undefined) continue;
      space = { id: spaceId, name: domain, status: 'auto_offline', createdAt: now, updatedAt: now };
      existingSpaces.push(space);
    }
    for (const u of urls) {
      if (await isAlreadyAssigned(u.url)) continue;
      await addSpaceUrl({ spaceId, url: u.url, title: u.title, source: 'ai', alwaysOpen: false });
    }
  }
}

/** First run calls name_spaces; later runs call assign_tabs for unassigned URLs only. Falls back to domain grouping on AI failure. */
export async function recomputeSpaces(): Promise<void> {
  const existingSpaces = await getSpaces();
  const candidates = await getCandidateUrls();

  if (existingSpaces.length === 0) {
    if (candidates.length === 0) return;
    const input: NameSpacesInput = { urls: candidates.map((c) => ({ url: c.url, title: c.title ?? '' })) };
    const result = await runTask<NameSpacesOutput>('name_spaces', input);
    if (result.ok) {
      await applyNameSpacesResult(result.data, candidates);
    } else {
      await applyDomainFallback(candidates);
    }
    return;
  }

  const unassigned: Candidate[] = [];
  for (const c of candidates) {
    if (!(await isAlreadyAssigned(c.url))) unassigned.push(c);
  }
  if (unassigned.length === 0) return;

  const input: AssignTabsInput = {
    urls: unassigned.map((c) => ({ url: c.url, title: c.title ?? '' })),
    existingSpaces: existingSpaces.map((s) => s.name),
  };
  const result = await runTask<AssignTabsOutput>('assign_tabs', input);
  if (result.ok) {
    await applyAssignTabsResult(result.data, unassigned, existingSpaces);
  } else {
    await applyDomainFallback(unassigned);
  }
}

async function findOpenTabIdsForUrls(urls: Set<string>): Promise<number[]> {
  const tabs = await chrome.tabs.query({});
  const ids: number[] = [];
  for (const tab of tabs) {
    if (!tab.url || tab.id === undefined) continue;
    const normalized = normalizeUrl(tab.url);
    if (normalized && urls.has(normalized.url)) ids.push(tab.id);
  }
  return ids;
}

async function countOpenTabsForUrls(urls: string[]): Promise<number> {
  return (await findOpenTabIdsForUrls(new Set(urls))).length;
}

/** Default shelve: collapse the space's open tabs into a named tab group. Tabs stay open. */
export async function shelveSpace(spaceId: number): Promise<void> {
  const space = await getSpaceById(spaceId);
  if (!space) return;
  const spaceUrls = await getSpaceUrlsForSpace(spaceId);
  const tabIds = await findOpenTabIdsForUrls(new Set(spaceUrls.map((u) => u.url)));
  if (tabIds.length === 0) return;

  const groupId = await chrome.tabs.group({ tabIds: [tabIds[0]!, ...tabIds.slice(1)] });
  await chrome.tabGroups.update(groupId, { title: space.name, collapsed: true });
}

async function getTabIdsWithRecentTyping(fromTs: number, toTs: number): Promise<Set<number>> {
  const events = await getEventsByKind('typing_burst', fromTs, toTs);
  return new Set(events.map((e) => e.tabId).filter((id): id is number => id !== undefined));
}

/** "Close and save": closes the space's tabs (skipping pinned, always-open, and recently-typed-in ones) and records a shelf for Restore. */
export async function closeAndSaveSpace(spaceId: number): Promise<void> {
  const space = await getSpaceById(spaceId);
  if (!space) return;

  const spaceUrls = await getSpaceUrlsForSpace(spaceId);
  const urlSet = new Set(spaceUrls.map((u) => u.url));
  const alwaysOpenUrls = new Set(spaceUrls.filter((u) => u.alwaysOpen).map((u) => u.url));

  const now = Date.now();
  const recentTypingTabIds = await getTabIdsWithRecentTyping(now - RECENT_TYPING_WINDOW_MS, now);

  const tabs = await chrome.tabs.query({});
  const toClose: { tabId: number; url: string; title?: string }[] = [];

  for (const tab of tabs) {
    if (!tab.url || tab.id === undefined || tab.pinned) continue;
    const normalized = normalizeUrl(tab.url);
    if (!normalized || !urlSet.has(normalized.url)) continue;
    if (alwaysOpenUrls.has(normalized.url)) continue;
    if (recentTypingTabIds.has(tab.id)) continue;
    toClose.push({ tabId: tab.id, url: normalized.url, title: tab.title });
  }

  if (toClose.length === 0) return;

  await addShelf({ spaceId, urls: toClose.map((t) => ({ url: t.url, title: t.title })), createdAt: now });
  await chrome.tabs.remove(toClose.map((t) => t.tabId));
}

/** Expands an existing collapsed group for this space, or reopens its last shelf into a new named group. */
export async function restoreSpace(spaceId: number): Promise<void> {
  const space = await getSpaceById(spaceId);
  if (!space) return;

  const groups = await chrome.tabGroups.query({ title: space.name });
  const existingGroup = groups[0];
  if (existingGroup?.id !== undefined) {
    await chrome.tabGroups.update(existingGroup.id, { collapsed: false });
    const [firstTab] = await chrome.tabs.query({ groupId: existingGroup.id });
    await focusTab(firstTab);
    return;
  }

  const shelf = await getLatestShelfForSpace(spaceId);
  if (!shelf || shelf.urls.length === 0) return;

  const tabs = await Promise.all(shelf.urls.map((u) => chrome.tabs.create({ url: u.url, active: false })));
  const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
  const firstTabId = tabIds[0];
  if (firstTabId === undefined) return;

  const groupId = await chrome.tabs.group({ tabIds: [firstTabId, ...tabIds.slice(1)] });
  await chrome.tabGroups.update(groupId, { title: space.name, collapsed: false });
  const createdFirstTab = await chrome.tabs.get(firstTabId);
  await focusTab(createdFirstTab);

  if (shelf.id !== undefined) await deleteShelf(shelf.id);
}

async function focusTab(tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (!tab?.id) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

async function isSidePanelOpen(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

export interface PendingSwitchSuggestion {
  fromSpaceId: number;
  fromName: string;
  fromTabCount: number;
  toSpaceId: number;
  toName: string;
}

export async function getPendingSwitchSuggestion(): Promise<PendingSwitchSuggestion | null> {
  const { [PENDING_SWITCH_KEY]: pending } =
    await chrome.storage.session.get<Record<string, PendingSwitchSuggestion | undefined>>(PENDING_SWITCH_KEY);
  return pending ?? null;
}

export async function clearPendingSwitchSuggestion(): Promise<void> {
  await chrome.storage.session.remove(PENDING_SWITCH_KEY);
}

/** Runs the switch-detection check and, if a candidate is found, shows a SuggestionCard (panel open) or a notification (panel closed). */
export async function checkAndOfferSwitch(demoMode: boolean): Promise<void> {
  const candidate = await checkForSwitch(demoMode);
  if (!candidate) return;
  await offerSwitch(candidate);
}

async function offerSwitch(candidate: SwitchCandidate): Promise<void> {
  const [fromSpace, toSpace, fromUrls] = await Promise.all([
    getSpaceById(candidate.fromSpaceId),
    getSpaceById(candidate.toSpaceId),
    getSpaceUrlsForSpace(candidate.fromSpaceId),
  ]);
  if (!fromSpace?.id || !toSpace?.id) return;

  const fromTabCount = await countOpenTabsForUrls(fromUrls.map((u) => u.url));
  await recordSwitchOffer(candidate);

  if (await isSidePanelOpen()) {
    await chrome.storage.session.set({
      [PENDING_SWITCH_KEY]: {
        fromSpaceId: fromSpace.id,
        fromName: fromSpace.name,
        fromTabCount,
        toSpaceId: toSpace.id,
        toName: toSpace.name,
      } satisfies PendingSwitchSuggestion,
    });
    return;
  }

  await chrome.notifications.create(`${SPACE_NOTIFICATION_PREFIX}${toSpace.id}:${fromSpace.id}`, {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: `Switch to ${toSpace.name}?`,
    message: `Shelve ${fromSpace.name} (${fromTabCount} tab${fromTabCount === 1 ? '' : 's'})?`,
    buttons: [{ title: 'Shelve' }, { title: 'Not now' }],
  });
}

export async function handleSpaceNotificationButtonClicked(notificationId: string, buttonIndex: number): Promise<void> {
  const rest = notificationId.slice(SPACE_NOTIFICATION_PREFIX.length);
  const [, fromIdStr] = rest.split(':');
  const fromSpaceId = Number(fromIdStr);

  if (buttonIndex === 0 && !Number.isNaN(fromSpaceId)) {
    await shelveSpace(fromSpaceId);
  }
  await chrome.notifications.clear(notificationId);
}

export { neverSwitchForSpace };
