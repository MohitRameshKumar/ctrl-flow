import { createCalendarSource } from '@/lib/calendar';
import { db, pruneMacroData } from '@/lib/db';
import { normalizeUrl } from '@/lib/normalize';
import { routeNotificationButtonClicked } from '@/lib/notifications';
import { DEFAULT_BLOCKLIST, getBlocklist, isBlocklisted, isPaused, isSensitiveField } from '@/lib/privacy';
import { isReplayInProgress } from '@/lib/macro-run-channel';
import { reconcileAbandonedRun } from '@/lib/macro-replay';
import {
  RITUAL_RECOMPUTE_ALARM,
  RITUAL_TRIGGER_ALARM_PREFIX,
  detectRituals,
  fireRitualTrigger,
  scheduleRitualAlarms,
} from '@/lib/rituals';
import {
  MACRO_PALETTE_COMMAND,
  MACRO_PALETTE_REQUEST_KEY,
  MACRO_RECOMPUTE_ALARM,
  checkForInProgressMacro,
  checkTimeOfDayTriggers,
  offerTopSuggestedMacro,
  recomputeMacros,
} from '@/lib/macros';
import { SPACE_RECOMPUTE_ALARM, SWITCH_CHECK_ALARM, checkAndOfferSwitch, recomputeSpaces } from '@/lib/spaces';
import type { BlocklistConfig, CadenceEvent, ContentMessage, EventKind } from '@/lib/types';

const CLEANUP_ALARM = 'cadence-cleanup';
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

interface WriteEventInput {
  kind: EventKind;
  tabId?: number;
  windowId?: number;
  rawUrl?: string;
  /**
   * Origin of the frame the event came from, when it is not the top frame.
   *
   * A content script runs in all frames but `sender.tab.url` is always the *top-level* URL, so
   * without this a click inside an embedded blocklisted page (a Gmail iframe on some other host)
   * would be recorded as if it happened on the host page.
   */
  frameUrl?: string;
  title?: string;
  selector?: string;
  label?: string;
  fieldName?: string;
  keyCount?: number;
}

/**
 * Cached so the hot path does not do two `chrome.storage.local` reads per event.
 *
 * Invalidated by the `onChanged` listener registered in the background entry point, so a pause
 * or blocklist edit still takes effect immediately.
 */
let settingsCache: { paused: boolean; blocklist: BlocklistConfig } | null = null;

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

async function readSettings(): Promise<{ paused: boolean; blocklist: BlocklistConfig }> {
  if (settingsCache) return settingsCache;
  const [paused, blocklist] = await Promise.all([isPaused(), getBlocklist()]);
  settingsCache = { paused, blocklist };
  return settingsCache;
}

/**
 * Suppresses the near-duplicate burst a single page load produces.
 *
 * One foreground link-open fires `tab_opened`, `navigated` and `tab_activated` within
 * milliseconds, all with the same URL. Downstream `eventToAction` collapses them anyway, so the
 * extra rows only inflate the database and the "events today" count.
 */
const DEDUPE_WINDOW_MS = 1500;
const recentWrites = new Map<string, number>();

/**
 * Kinds that describe a page, and are therefore meaningless without one.
 *
 * The window-level focus events are deliberately absent: they say something about Chrome rather
 * than about a page, and carrying no URL is correct for them.
 */
const KINDS_REQUIRING_URL = new Set<EventKind>([
  'tab_opened',
  'tab_activated',
  'navigated',
  'click',
  'field_changed',
]);

function isDuplicate(kind: EventKind, url: string | undefined, tabId: number | undefined): boolean {
  if (!url) return false;
  if (kind !== 'tab_opened' && kind !== 'navigated' && kind !== 'tab_activated') return false;

  const key = `nav|${tabId ?? '?'}|${url}`;
  const now = Date.now();
  const last = recentWrites.get(key);

  // Opportunistic sweep: this map is only ever as big as recent navigation activity.
  if (recentWrites.size > 200) {
    for (const [k, ts] of recentWrites) {
      if (now - ts > DEDUPE_WINDOW_MS) recentWrites.delete(k);
    }
  }

  recentWrites.set(key, now);
  return last !== undefined && now - last < DEDUPE_WINDOW_MS;
}

/** The only path that reaches db.events.add. Applies pause/blocklist/normalization uniformly for every event source. */
async function writeEvent(input: WriteEventInput): Promise<void> {
  const { paused, blocklist } = await readSettings();
  if (paused) return;

  // A macro replay drives the browser itself. Recording that traffic would feed the next scan
  // its own output, so running a macro would make Cadence more confident in that macro — a loop
  // with nothing to stop it.
  if (await isReplayInProgress()) return;

  let url: string | undefined;
  let domain: string | undefined;

  if (input.rawUrl) {
    const normalized = normalizeUrl(input.rawUrl);
    // A URL that does not normalize is a chrome://, file:// or about: page. Previously such
    // rows were still written — with no url and no domain, which also meant they skipped the
    // blocklist check entirely — and then ignored by every consumer.
    if (!normalized) return;

    domain = normalized.domain;
    if (isBlocklisted(domain, blocklist)) return;
    url = normalized.url;
  } else if (KINDS_REQUIRING_URL.has(input.kind)) {
    // The guard above only fires when a URL was supplied at all. A tab activated while still
    // loading reports `url: ''`, which skipped the block entirely and wrote a row carrying
    // nothing but a tabId — invisible to every consumer, but inflating the table and the
    // "events today" count.
    return;
  }

  // Check the originating frame too, not just the top-level page.
  if (input.frameUrl) {
    const frame = normalizeUrl(input.frameUrl);
    if (frame && isBlocklisted(frame.domain, blocklist)) return;
  }

  if (isDuplicate(input.kind, url, input.tabId)) return;

  const event: CadenceEvent = {
    ts: Date.now(),
    kind: input.kind,
    tabId: input.tabId,
    windowId: input.windowId,
    url,
    domain,
    title: input.title,
    selector: input.selector,
    label: input.label,
    fieldName: input.fieldName,
    keyCount: input.keyCount,
  };

  await db.events.add(event);
}

/**
 * Last URL seen on each tab, so `tab_closed` can say what was closed.
 *
 * In-memory and therefore lost when the worker is recycled; a close after that simply records
 * no URL, exactly as it did before. Worth it for the common case, not worth persisting.
 */
const lastKnownTabUrl = new Map<number, { url: string; title?: string }>();

function rememberTabUrl(tabId: number, url?: string, title?: string): void {
  if (!url) return;
  lastKnownTabUrl.set(tabId, { url, title });
  if (lastKnownTabUrl.size > 300) {
    const oldest = lastKnownTabUrl.keys().next().value;
    if (oldest !== undefined) lastKnownTabUrl.delete(oldest);
  }
}

/**
 * Debounced so a burst of navigation does not run the matcher once per redirect.
 *
 * The matcher is cheap, but it reads every macro and queries all tabs, and a page load can emit
 * several navigation events in a row.
 */
const IN_PROGRESS_DEBOUNCE_MS = 1200;
let inProgressTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleInProgressCheck(): void {
  if (inProgressTimer) clearTimeout(inProgressTimer);
  inProgressTimer = setTimeout(() => {
    inProgressTimer = undefined;
    getDemoMode()
      .then((demoMode) => checkForInProgressMacro(demoMode))
      .catch((err) => console.error('[cadence] in-progress check failed', err));
  }, IN_PROGRESS_DEBOUNCE_MS);
}

/** Shared by the committed-navigation and SPA-navigation listeners. */
function recordNavigation(tabId: number, url: string): void {
  chrome.tabs
    .get(tabId)
    .then((tab) => {
      rememberTabUrl(tabId, url, tab.title);
      return writeEvent({ kind: 'navigated', tabId, windowId: tab.windowId, rawUrl: url, title: tab.title });
    })
    .catch(() => writeEvent({ kind: 'navigated', tabId, rawUrl: url }))
    .then(scheduleInProgressCheck)
    .catch((err) => console.error('[cadence] navigated failed', err));
}

/**
 * Records the tab that is already in front.
 *
 * `chrome.tabs.onActivated` only fires on a *change*, so the tab you are sitting on when Chrome
 * starts — or when the service worker wakes — was invisible until you switched away from it and
 * back. Guarded by a session flag so repeated worker wakes do not re-seed.
 */
async function seedActiveTabs(): Promise<void> {
  const SEED_KEY = 'activeTabsSeeded';
  const existing = await chrome.storage.session.get<{ activeTabsSeeded?: boolean }>(SEED_KEY);
  if (existing.activeTabsSeeded) return;
  await chrome.storage.session.set({ [SEED_KEY]: true });

  const tabs = await chrome.tabs.query({ active: true });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    await writeEvent({
      kind: 'tab_activated',
      tabId: tab.id,
      windowId: tab.windowId,
      rawUrl: tab.url,
      title: tab.title,
    });
  }
}

async function initDefaults(): Promise<void> {
  const existing = await chrome.storage.local.get(['paused', 'blocklist', 'calendarSource', 'demoMode']);
  const updates: Record<string, unknown> = {};
  if (existing.paused === undefined) updates.paused = false;
  if (existing.blocklist === undefined) updates.blocklist = DEFAULT_BLOCKLIST;
  if (existing.calendarSource === undefined) updates.calendarSource = 'demo';
  if (existing.demoMode === undefined) updates.demoMode = true;
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function getDemoMode(): Promise<boolean> {
  const { demoMode = true } = await chrome.storage.local.get<{ demoMode?: boolean }>('demoMode');
  return demoMode;
}

async function runMacroRecompute(): Promise<void> {
  const demoMode = await getDemoMode();
  await recomputeMacros(demoMode);
  await offerTopSuggestedMacro();
  await checkTimeOfDayTriggers();
}

async function runRitualRecompute(): Promise<void> {
  const { calendarSource = 'demo', demoMode = true } = await chrome.storage.local.get<{
    calendarSource?: 'demo' | 'google';
    demoMode?: boolean;
  }>(['calendarSource', 'demoMode']);
  const source = createCalendarSource(calendarSource);
  await detectRituals(source, { demoMode });
  await scheduleRitualAlarms(source);
}

async function handleContentMessage(
  message: ContentMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tab = sender.tab;

  switch (message.type) {
    case 'click':
      await writeEvent({
        kind: 'click',
        tabId: tab?.id,
        windowId: tab?.windowId,
        rawUrl: tab?.url,
        title: tab?.title,
        frameUrl: message.frameUrl,
        selector: message.selector,
        label: message.label,
      });
      return;
    case 'field_changed':
      if (isSensitiveField(message.fieldType, message.autocomplete, message.fieldName)) return;
      await writeEvent({
        kind: 'field_changed',
        tabId: tab?.id,
        windowId: tab?.windowId,
        rawUrl: tab?.url,
        title: tab?.title,
        frameUrl: message.frameUrl,
        fieldName: message.fieldName,
      });
      return;
    case 'typing_burst':
      await writeEvent({
        kind: 'typing_burst',
        tabId: tab?.id,
        windowId: tab?.windowId,
        rawUrl: tab?.url,
        title: tab?.title,
        keyCount: message.keyCount,
      });
      return;
  }
}

/** Alarms are idempotent by name, so re-arming on every wake is safe and costs nothing. */
function armAlarms(): void {
  chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
  chrome.alarms.create(RITUAL_RECOMPUTE_ALARM, { periodInMinutes: 15 });
  chrome.alarms.create(SPACE_RECOMPUTE_ALARM, { periodInMinutes: 30 });
  chrome.alarms.create(SWITCH_CHECK_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(MACRO_RECOMPUTE_ALARM, { periodInMinutes: 20 });
}

export default defineBackground(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) =>
    console.error('[cadence] setPanelBehavior failed', err),
  );

  // Runs on every service worker wake, which is the only hook that covers all three of install,
  // browser start, and a wake after idle termination — neither onInstalled nor onStartup fires
  // on the last of those.
  seedActiveTabs().catch((err) => console.error('[cadence] seeding active tabs failed', err));
  reconcileAbandonedRun().catch((err) => console.error('[cadence] run reconcile failed', err));

  // Pause and blocklist are cached on the event hot path; keep the cache honest.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('paused' in changes || 'blocklist' in changes)) {
      invalidateSettingsCache();
    }
  });

  chrome.runtime.onStartup.addListener(() => {
    // Alarms do persist across restarts, but one lost to a profile problem is otherwise never
    // recreated — the previous code only ever armed them at install.
    armAlarms();
    seedActiveTabs().catch((err) => console.error('[cadence] seeding active tabs failed', err));
  });

  chrome.runtime.onInstalled.addListener(() => {
    initDefaults().catch((err) => console.error('[cadence] initDefaults failed', err));
    armAlarms();
    runRitualRecompute().catch((err) => console.error('[cadence] initial ritual recompute failed', err));
    recomputeSpaces().catch((err) => console.error('[cadence] initial space recompute failed', err));
    runMacroRecompute().catch((err) => console.error('[cadence] initial macro recompute failed', err));
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CLEANUP_ALARM) {
      const cutoff = Date.now() - RETENTION_MS;
      db.events
        .where('ts')
        .below(cutoff)
        .delete()
        .then(() => pruneMacroData(cutoff))
        .catch((err) => console.error('[cadence] cleanup failed', err));
      return;
    }

    if (alarm.name === RITUAL_RECOMPUTE_ALARM) {
      runRitualRecompute().catch((err) => console.error('[cadence] ritual recompute failed', err));
      return;
    }

    if (alarm.name.startsWith(RITUAL_TRIGGER_ALARM_PREFIX)) {
      const ritualId = Number(alarm.name.slice(RITUAL_TRIGGER_ALARM_PREFIX.length));
      fireRitualTrigger(ritualId).catch((err) => console.error('[cadence] ritual trigger failed', err));
      return;
    }

    if (alarm.name === SPACE_RECOMPUTE_ALARM) {
      recomputeSpaces().catch((err) => console.error('[cadence] space recompute failed', err));
      return;
    }

    if (alarm.name === MACRO_RECOMPUTE_ALARM) {
      runMacroRecompute().catch((err) => console.error('[cadence] macro recompute failed', err));
      return;
    }

    if (alarm.name === SWITCH_CHECK_ALARM) {
      getDemoMode()
        .then((demoMode) => checkAndOfferSwitch(demoMode))
        .catch((err) => console.error('[cadence] switch check failed', err));
    }
  });

  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== MACRO_PALETTE_COMMAND) return;
    const windowId = tab?.windowId;
    if (windowId === undefined) {
      console.warn('[cadence] macro palette shortcut fired with no active window');
      return;
    }

    // sidePanel.open() must be reached before anything is awaited: an await here would spend the
    // user gesture that the command supplies, and the call would throw.
    const opening = chrome.sidePanel.open({ windowId });
    chrome.storage.session
      .set({ [MACRO_PALETTE_REQUEST_KEY]: { ts: Date.now() } })
      .catch((err) => console.error('[cadence] palette request failed', err));
    opening.catch((err) => console.error('[cadence] sidePanel.open failed', err));
  });

  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    routeNotificationButtonClicked(notificationId, buttonIndex ?? 0).catch((err) =>
      console.error('[cadence] notification button handler failed', err),
    );
  });

  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        rememberTabUrl(tabId, tab.url, tab.title);
        return writeEvent({ kind: 'tab_activated', tabId, windowId, rawUrl: tab.url, title: tab.title });
      })
      .then(() => getDemoMode())
      .then((demoMode) => checkAndOfferSwitch(demoMode))
      .then(scheduleInProgressCheck)
      .catch((err) => console.error('[cadence] tab_activated failed', err));
  });

  chrome.tabs.onCreated.addListener((tab) => {
    writeEvent({
      kind: 'tab_opened',
      tabId: tab.id,
      windowId: tab.windowId,
      rawUrl: tab.url || tab.pendingUrl,
      title: tab.title,
    }).catch((err) => console.error('[cadence] tab_opened failed', err));
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    // The tab is already gone by the time this fires, so its URL comes from what we last saw on
    // it. Without that a close records only a tabId — and Chrome reuses tab ids, so there was no
    // reliable way to tell what had closed.
    const last = lastKnownTabUrl.get(tabId);
    lastKnownTabUrl.delete(tabId);
    writeEvent({
      kind: 'tab_closed',
      tabId,
      windowId: removeInfo.windowId,
      rawUrl: last?.url,
      title: last?.title,
    }).catch((err) => console.error('[cadence] tab_closed failed', err));
  });

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    recordNavigation(details.tabId, details.url);
  });

  // Single-page apps change the URL without committing a navigation, so `onCommitted` alone sees
  // the first document load and nothing after. Without this, moving between Linear issues, Gmail
  // threads, GitHub PR tabs or Notion pages produces no events at all — which is most of the
  // repetitive work worth learning.
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    recordNavigation(details.tabId, details.url);
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      writeEvent({ kind: 'chrome_focus_lost' }).catch((err) =>
        console.error('[cadence] focus event failed', err),
      );
      return;
    }

    // Carry the tab that is now in front. Previously this event held only a windowId, so
    // switching windows recorded that *something* happened without recording what — and no
    // consumer could use it.
    chrome.tabs
      .query({ active: true, windowId })
      .then(([tab]) =>
        writeEvent({
          kind: 'chrome_focus_gained',
          windowId,
          tabId: tab?.id,
          rawUrl: tab?.url,
          title: tab?.title,
        }),
      )
      .catch((err) => console.error('[cadence] focus event failed', err));
  });

  chrome.runtime.onMessage.addListener((message: ContentMessage, sender) => {
    handleContentMessage(message, sender).catch((err) =>
      console.error('[cadence] handleContentMessage failed', err),
    );
  });
});
