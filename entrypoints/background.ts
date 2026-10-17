import { createCalendarSource } from '@/lib/calendar';
import { db } from '@/lib/db';
import { normalizeUrl } from '@/lib/normalize';
import { routeNotificationButtonClicked } from '@/lib/notifications';
import { DEFAULT_BLOCKLIST, getBlocklist, isBlocklisted, isPaused, isSensitiveField } from '@/lib/privacy';
import {
  RITUAL_RECOMPUTE_ALARM,
  RITUAL_TRIGGER_ALARM_PREFIX,
  detectRituals,
  fireRitualTrigger,
  scheduleRitualAlarms,
} from '@/lib/rituals';
import { SPACE_RECOMPUTE_ALARM, SWITCH_CHECK_ALARM, checkAndOfferSwitch, recomputeSpaces } from '@/lib/spaces';
import type { CadenceEvent, ContentMessage, EventKind } from '@/lib/types';

const CLEANUP_ALARM = 'cadence-cleanup';
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

interface WriteEventInput {
  kind: EventKind;
  tabId?: number;
  windowId?: number;
  rawUrl?: string;
  title?: string;
  selector?: string;
  label?: string;
  fieldName?: string;
  keyCount?: number;
}

/** The only path that reaches db.events.add. Applies pause/blocklist/normalization uniformly for every event source. */
async function writeEvent(input: WriteEventInput): Promise<void> {
  if (await isPaused()) return;

  let url: string | undefined;
  let domain: string | undefined;

  if (input.rawUrl) {
    const normalized = normalizeUrl(input.rawUrl);
    if (normalized) {
      domain = normalized.domain;
      const blocklist = await getBlocklist();
      if (isBlocklisted(domain, blocklist)) return;
      url = normalized.url;
    }
  }

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

export default defineBackground(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) =>
    console.error('[cadence] setPanelBehavior failed', err),
  );

  chrome.runtime.onInstalled.addListener(() => {
    initDefaults().catch((err) => console.error('[cadence] initDefaults failed', err));
    chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
    chrome.alarms.create(RITUAL_RECOMPUTE_ALARM, { periodInMinutes: 15 });
    chrome.alarms.create(SPACE_RECOMPUTE_ALARM, { periodInMinutes: 30 });
    chrome.alarms.create(SWITCH_CHECK_ALARM, { periodInMinutes: 1 });
    runRitualRecompute().catch((err) => console.error('[cadence] initial ritual recompute failed', err));
    recomputeSpaces().catch((err) => console.error('[cadence] initial space recompute failed', err));
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CLEANUP_ALARM) {
      const cutoff = Date.now() - RETENTION_MS;
      db.events
        .where('ts')
        .below(cutoff)
        .delete()
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

    if (alarm.name === SWITCH_CHECK_ALARM) {
      getDemoMode()
        .then((demoMode) => checkAndOfferSwitch(demoMode))
        .catch((err) => console.error('[cadence] switch check failed', err));
    }
  });

  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    routeNotificationButtonClicked(notificationId, buttonIndex ?? 0).catch((err) =>
      console.error('[cadence] notification button handler failed', err),
    );
  });

  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    chrome.tabs
      .get(tabId)
      .then((tab) => writeEvent({ kind: 'tab_activated', tabId, windowId, rawUrl: tab.url, title: tab.title }))
      .then(() => getDemoMode())
      .then((demoMode) => checkAndOfferSwitch(demoMode))
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
    writeEvent({ kind: 'tab_closed', tabId, windowId: removeInfo.windowId }).catch((err) =>
      console.error('[cadence] tab_closed failed', err),
    );
  });

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    chrome.tabs
      .get(details.tabId)
      .then((tab) =>
        writeEvent({ kind: 'navigated', tabId: details.tabId, rawUrl: details.url, title: tab.title }),
      )
      .catch(() => writeEvent({ kind: 'navigated', tabId: details.tabId, rawUrl: details.url }))
      .catch((err) => console.error('[cadence] navigated failed', err));
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    const lost = windowId === chrome.windows.WINDOW_ID_NONE;
    writeEvent({
      kind: lost ? 'chrome_focus_lost' : 'chrome_focus_gained',
      windowId: lost ? undefined : windowId,
    }).catch((err) => console.error('[cadence] focus event failed', err));
  });

  chrome.runtime.onMessage.addListener((message: ContentMessage, sender) => {
    handleContentMessage(message, sender).catch((err) =>
      console.error('[cadence] handleContentMessage failed', err),
    );
  });
});
