import { runTask } from './ai';
import {
  MAX_CONTEXT_URLS,
  computePairStats,
  edgesForUrls,
  groupByCoUsage,
  pickContextUrls,
  truncateTitle,
  typedCountsForUrls,
  type PairStat,
} from './co-usage';
import {
  addShelf,
  addSpaceUrl,
  createSpace,
  deleteShelf,
  deleteSpace,
  getEventsByKind,
  getLatestShelfForSpace,
  getSpaceById,
  getSpaceUrlByUrl,
  getSpaceUrls,
  getSpaceUrlsForSpace,
  getSpaces,
  removeSpaceUrl,
} from './db';
import { normalizeUrl } from './normalize';
import { findOpenTabIdsForUrls, focusTab, openUrlsAsGroup } from './tabs';
import { getBlocklist, isBlocklisted } from './privacy';
import { checkForSwitch, neverSwitchForSpace, recordSwitchOffer, type SwitchCandidate } from './switch-detection';
import type {
  AssignTabsInput,
  AssignTabsOutput,
  NameSpacesInput,
  NameSpacesOutput,
  Space,
  SpaceUrl,
} from './types';

export const SPACE_NOTIFICATION_PREFIX = 'cadence-space:';
export const SPACE_RECOMPUTE_ALARM = 'cadence-space-recompute';
export const SWITCH_CHECK_ALARM = 'cadence-switch-check';
const PENDING_SWITCH_KEY = 'pendingSwitchSuggestion';

const ACTIVATION_WINDOW_MS = 48 * 60 * 60 * 1000;
const RECENT_TYPING_WINDOW_MS = 2 * 60 * 1000;
const MAX_CANDIDATES = 150;

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
    if (!e.url || e.programmatic || candidates.has(e.url)) continue;
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

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** "a.com", "a.com + b.com", or "a.com + b.com +2" — most-used domains first. */
function offlineGroupName(group: Candidate[]): string {
  const counts = new Map<string, number>();
  for (const c of group) {
    const host = hostnameOf(c.url);
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  const domains = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([d]) => d);
  if (domains.length <= 2) return domains.join(' + ');
  return `${domains.slice(0, 2).join(' + ')} +${domains.length - 2}`;
}

/**
 * Groups candidates by domain into "auto (offline)" spaces when the AI call fails. Domains whose
 * tabs were strongly used together (direct switches) are merged into one space, even across domains.
 */
export async function applyDomainFallback(
  candidates: Candidate[],
  stats: Map<string, PairStat> = new Map(),
): Promise<void> {
  const now = Date.now();
  const existingSpaces = await getSpaces();
  const valid = candidates.filter((c) => hostnameOf(c.url) !== null);
  const groups = groupByCoUsage(
    valid,
    (c) => c.url,
    stats,
    undefined,
    (a, b) => hostnameOf(a.url) === hostnameOf(b.url),
  );

  for (const group of groups) {
    const name = offlineGroupName(group);
    let space = existingSpaces.find((s) => s.name === name);
    let spaceId: number | undefined;
    if (space?.id !== undefined) {
      spaceId = space.id;
    } else {
      spaceId = await createSpace({ name, status: 'auto_offline', createdAt: now, updatedAt: now });
      if (spaceId === undefined) continue;
      space = { id: spaceId, name, status: 'auto_offline', createdAt: now, updatedAt: now };
      existingSpaces.push(space);
    }
    for (const u of group) {
      if (await isAlreadyAssigned(u.url)) continue;
      await addSpaceUrl({ spaceId, url: u.url, title: u.title, source: 'ai', alwaysOpen: false });
    }
  }
}

interface UsageSignals {
  stats: Map<string, PairStat>;
  burstsByUrl: Map<string, number>;
}

/** Local-only co-usage inputs: who was switched between, and which tabs had typing (counts, never content). */
async function gatherUsageSignals(): Promise<UsageSignals> {
  const now = Date.now();
  const from = now - ACTIVATION_WINDOW_MS;
  const [activated, typing] = await Promise.all([
    getEventsByKind('tab_activated', from, now),
    getEventsByKind('typing_burst', from, now),
  ]);
  const activations = activated
    .filter((e): e is typeof e & { url: string } => !!e.url && !e.programmatic)
    .map((e) => ({ url: e.url, ts: e.ts }));
  const burstsByUrl = new Map<string, number>();
  for (const e of typing) {
    if (e.url) burstsByUrl.set(e.url, (burstsByUrl.get(e.url) ?? 0) + 1);
  }
  return { stats: computePairStats(activations), burstsByUrl };
}

function toAiUrls(list: Candidate[]): { url: string; title: string }[] {
  return list.map((c) => ({ url: c.url, title: truncateTitle(c.title) }));
}

/**
 * First run (no real spaces yet) calls name_spaces; later runs call assign_tabs for unassigned URLs only.
 * Tabs sitting in auto-offline domain spaces (never edited by the user) are re-eligible so a working
 * proxy can regroup them. Falls back to co-usage-aware domain grouping on AI failure.
 */
export async function recomputeSpaces(): Promise<void> {
  const [allSpaces, allSpaceUrls] = await Promise.all([getSpaces(), getSpaceUrls()]);
  const candidates = (await getCandidateUrls()).slice(0, MAX_CANDIDATES);
  const { stats, burstsByUrl } = await gatherUsageSignals();

  const offlineIds = new Set(allSpaces.filter((s) => s.status === 'auto_offline').map((s) => s.id));
  const reassignable = new Map<string, SpaceUrl>();
  for (const u of allSpaceUrls) {
    if (offlineIds.has(u.spaceId) && u.source === 'ai' && !u.alwaysOpen) reassignable.set(u.url, u);
  }
  const fixedUrls = new Set(allSpaceUrls.filter((u) => !reassignable.has(u.url)).map((u) => u.url));
  const pool = candidates.filter((c) => !fixedUrls.has(c.url));
  if (pool.length === 0) return;

  const poolUrls = pool.map((c) => c.url);
  const liveSpaces = allSpaces.filter((s) => s.status !== 'auto_offline');
  let coveredUrls: Set<string> | null = null;

  if (liveSpaces.length === 0) {
    const input: NameSpacesInput = {
      urls: toAiUrls(pool),
      edges: edgesForUrls(poolUrls, stats),
      typed: typedCountsForUrls(poolUrls, burstsByUrl),
    };
    const result = await runTask<NameSpacesOutput>('name_spaces', input);
    if (result.ok) {
      const poolSet = new Set(poolUrls);
      const spaces = result.data.map((sp) => ({ ...sp, urls: sp.urls.filter((u) => poolSet.has(u)) }));
      coveredUrls = new Set(spaces.flatMap((sp) => sp.urls));
      await releaseOfflineRows(coveredUrls, reassignable);
      await applyNameSpacesResult(spaces, pool);
    }
  } else {
    const spaceByUrl = new Map(allSpaceUrls.map((u) => [u.url, u.spaceId]));
    const nameById = new Map(allSpaces.map((s) => [s.id, s.name]));
    const assignedCandidates = candidates.filter((c) => fixedUrls.has(c.url) && spaceByUrl.has(c.url));
    const contextUrls = pickContextUrls(
      poolUrls,
      assignedCandidates.map((c) => c.url),
      stats,
      MAX_CONTEXT_URLS,
    );
    const contextCandidates = contextUrls.map((u) => assignedCandidates.find((c) => c.url === u)!);
    const all = [...pool, ...contextCandidates];
    const allUrls = all.map((c) => c.url);

    const input: AssignTabsInput = {
      urls: toAiUrls(pool),
      existingSpaces: liveSpaces.map((s) => s.name),
      context: contextCandidates.map((c) => ({
        url: c.url,
        title: truncateTitle(c.title),
        space: nameById.get(spaceByUrl.get(c.url)!) ?? '',
      })),
      edges: edgesForUrls(allUrls, stats),
      typed: typedCountsForUrls(allUrls, burstsByUrl),
    };
    const result = await runTask<AssignTabsOutput>('assign_tabs', input);
    if (result.ok) {
      const poolSet = new Set(poolUrls);
      const assignments = result.data.filter((a) => poolSet.has(a.url));
      coveredUrls = new Set(assignments.filter((a) => a.spaceName || a.newSpaceName).map((a) => a.url));
      await releaseOfflineRows(coveredUrls, reassignable);
      await applyAssignTabsResult(assignments, pool, liveSpaces);
    }
  }

  if (coveredUrls === null) {
    // AI unavailable: leave existing offline groupings alone, group only what's still unassigned.
    await applyDomainFallback(
      pool.filter((c) => !reassignable.has(c.url)),
      stats,
    );
    return;
  }

  await deleteEmptyOfflineSpaces(offlineIds);
}

/** Frees the AI-owned rows of auto-offline spaces whose URLs the AI is about to place elsewhere. */
async function releaseOfflineRows(urls: Set<string>, reassignable: Map<string, SpaceUrl>): Promise<void> {
  for (const url of urls) {
    const row = reassignable.get(url);
    if (row?.id !== undefined) await removeSpaceUrl(row.id);
  }
}

async function deleteEmptyOfflineSpaces(offlineIds: Set<number | undefined>): Promise<void> {
  for (const id of offlineIds) {
    if (id === undefined) continue;
    if ((await getSpaceUrlsForSpace(id)).length === 0) await deleteSpace(id);
  }
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

  // Shared helper rather than another inline copy: it reuses a tab the user already reopened
  // by hand, keeps the tabs in one window so grouping can succeed, and survives a group failure.
  await openUrlsAsGroup(
    shelf.urls.map((u) => u.url),
    space.name,
    { collapsed: false, focus: true },
  );

  if (shelf.id !== undefined) await deleteShelf(shelf.id);
}

/**
 * "Project switch" (leader key + a space's letter): bring the space back. Restores a collapsed group
 * or shelf if there is one; else focuses an open tab of the space; else reopens its saved tabs.
 */
export async function switchToSpace(spaceId: number): Promise<void> {
  const space = await getSpaceById(spaceId);
  if (!space) return;
  const spaceUrls = await getSpaceUrlsForSpace(spaceId);

  const hasGroup = (await chrome.tabGroups.query({ title: space.name })).length > 0;
  if (hasGroup || (await getLatestShelfForSpace(spaceId))) {
    await restoreSpace(spaceId);
    return;
  }

  const openIds = await findOpenTabIdsForUrls(new Set(spaceUrls.map((u) => u.url)));
  if (openIds[0] !== undefined) {
    await focusTab(await chrome.tabs.get(openIds[0]));
    return;
  }

  const toOpen = spaceUrls.slice(0, 8);
  if (toOpen.length === 0) return;
  const tabs = await Promise.all(toOpen.map((u) => chrome.tabs.create({ url: u.url, active: false })));
  const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
  if (tabIds[0] === undefined) return;
  const groupId = await chrome.tabs.group({ tabIds: [tabIds[0], ...tabIds.slice(1)] });
  await chrome.tabGroups.update(groupId, { title: space.name, collapsed: false });
  await focusTab(await chrome.tabs.get(tabIds[0]));
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
