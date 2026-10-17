import { updateBadge } from '@/lib/badge';
import { createCalendarSource } from '@/lib/calendar';
import { db } from '@/lib/db';
import { normalizeUrl } from '@/lib/normalize';
import { routeNotificationButtonClicked } from '@/lib/notifications';
import {
  DEFAULT_BLOCKLIST,
  getBlocklist,
  isBlocklisted,
  isPaused,
  isSensitiveField,
  mergeDefaultDomains,
} from '@/lib/privacy';
import { DEFAULT_RETENTION, RETENTION_KEY, isRetentionSetting, retentionCutoff } from '@/lib/retention';
import {
  RITUAL_RECOMPUTE_ALARM,
  RITUAL_TRIGGER_ALARM_PREFIX,
  detectRituals,
  fireRitualTrigger,
  scheduleRitualAlarms,
} from '@/lib/rituals';
import { SPACE_RECOMPUTE_ALARM, SWITCH_CHECK_ALARM, checkAndOfferSwitch, recomputeSpaces } from '@/lib/spaces';
import {
  FLIP_RETURN_ALARM,
  FOCUS_FLIP_KEY,
  cancelFlip,
  disableFocusFlip,
  handleActivity,
  handleSensitiveFocus,
  handleTabRemoved,
  handleUserActivation,
  resumeFlipIfDue,
} from '@/lib/focus-flip';
import { openLeader, registerBuiltinLeaders, runLeaderLetter, runSearchItem } from '@/lib/leader';
import { isProgrammaticNav } from '@/lib/programmatic';
import { installTestHooks } from '@/lib/test-hooks';
import type { BlocklistConfig, CadenceEvent, ContentMessage, EventKind } from '@/lib/types';

const CLEANUP_ALARM = 'cadence-cleanup';
/** Checked every minute so short retention settings (10 min) are honoured promptly. */
const CLEANUP_PERIOD_MINUTES = 1;

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
  programmatic?: boolean;
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
    programmatic: input.programmatic ? true : undefined,
  };

  await db.events.add(event);
}

async function initDefaults(): Promise<void> {
  const existing = await chrome.storage.local.get(['paused', 'blocklist', 'calendarSource', 'demoMode', FOCUS_FLIP_KEY, RETENTION_KEY, 'blocklistDefaultsV2']);
  const updates: Record<string, unknown> = {};
  if (existing.paused === undefined) updates.paused = false;
  if (existing.blocklist === undefined) updates.blocklist = DEFAULT_BLOCKLIST;
  if (existing.calendarSource === undefined) updates.calendarSource = 'demo';
  if (existing.demoMode === undefined) updates.demoMode = true;
  if (existing[FOCUS_FLIP_KEY] === undefined) updates[FOCUS_FLIP_KEY] = false;
  if (existing[RETENTION_KEY] === undefined) updates[RETENTION_KEY] = DEFAULT_RETENTION;
  // One-time: add the password-manager defaults to blocklists saved before they existed (user entries untouched).
  if (existing.blocklist !== undefined && existing.blocklistDefaultsV2 !== true) {
    updates.blocklist = mergeDefaultDomains(existing.blocklist as BlocklistConfig);
  }
  if (existing.blocklistDefaultsV2 !== true) updates.blocklistDefaultsV2 = true;
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
    case 'activity':
      if (tab?.id !== undefined) await handleActivity(tab.id, message.what);
      return;
    case 'sensitive_focus':
      if (tab?.id !== undefined) await handleSensitiveFocus(tab.id, message.value);
      return;
    // Leader-key requests are commands, never activity: nothing here writes an event.
    case 'leader_run':
      await runLeaderLetter(message.letter, { tabId: tab?.id, windowId: tab?.windowId });
      return;
    case 'leader_run_item':
      await runSearchItem(message.kind, message.id);
      return;
  }
}

/** PRIV-5: deletes events older than the retention setting. Events only — rituals, spaces, shelves and flip pairs are saved items. */
async function purgeExpiredEvents(): Promise<void> {
  const { [RETENTION_KEY]: setting } = await chrome.storage.local.get<Record<string, unknown>>(RETENTION_KEY);
  await db.events.where('ts').below(retentionCutoff(isRetentionSetting(setting) ? setting : DEFAULT_RETENTION, Date.now())).delete();
}

/** Dispatches an alarm by name. Shared by the real chrome.alarms.onAlarm listener and, in
 * test builds only, the __cadenceTest.fireAlarm hook — so a test can trigger exactly the same
 * code path a real alarm would, without waiting on chrome.alarms' real scheduling. */
async function handleAlarm(name: string): Promise<void> {
  if (name === CLEANUP_ALARM) {
    await purgeExpiredEvents();
    return;
  }

  if (name === RITUAL_RECOMPUTE_ALARM) {
    await runRitualRecompute();
    return;
  }

  if (name.startsWith(RITUAL_TRIGGER_ALARM_PREFIX)) {
    const ritualId = Number(name.slice(RITUAL_TRIGGER_ALARM_PREFIX.length));
    await fireRitualTrigger(ritualId);
    return;
  }

  if (name === SPACE_RECOMPUTE_ALARM) {
    await recomputeSpaces();
    return;
  }

  if (name === FLIP_RETURN_ALARM) {
    await resumeFlipIfDue();
    return;
  }

  if (name === SWITCH_CHECK_ALARM) {
    await checkAndOfferSwitch(await getDemoMode());
  }
}

export default defineBackground(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) =>
    console.error('[cadence] setPanelBehavior failed', err),
  );

  registerBuiltinLeaders();
  updateBadge().catch((err) => console.error('[cadence] badge failed', err));
  // Installs from before the 1-minute cleanup cadence still have the old daily alarm: replace it.
  chrome.alarms.get(CLEANUP_ALARM).then((alarm) => {
    if (!alarm || alarm.periodInMinutes !== CLEANUP_PERIOD_MINUTES) {
      chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: CLEANUP_PERIOD_MINUTES });
    }
  });

  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'leader-key') {
      openLeader(tab).catch((err) => console.error('[cadence] leader key failed', err));
    }
  });

  chrome.runtime.onInstalled.addListener(() => {
    initDefaults()
      .then(() => updateBadge())
      .catch((err) => console.error('[cadence] initDefaults failed', err));
    chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: CLEANUP_PERIOD_MINUTES });
    chrome.alarms.create(RITUAL_RECOMPUTE_ALARM, { periodInMinutes: 15 });
    chrome.alarms.create(SPACE_RECOMPUTE_ALARM, { periodInMinutes: 30 });
    chrome.alarms.create(SWITCH_CHECK_ALARM, { periodInMinutes: 1 });
    runRitualRecompute().catch((err) => console.error('[cadence] initial ritual recompute failed', err));
    recomputeSpaces().catch((err) => console.error('[cadence] initial space recompute failed', err));
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    handleAlarm(alarm.name).catch((err) => console.error('[cadence] alarm handler failed', alarm.name, err));
  });

  if (import.meta.env.WXT_TEST === '1') {
    installTestHooks(handleAlarm);
  }

  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    routeNotificationButtonClicked(notificationId, buttonIndex ?? 0).catch((err) =>
      console.error('[cadence] notification button handler failed', err),
    );
  });

  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    Promise.all([chrome.tabs.get(tabId), isProgrammaticNav(tabId)])
      .then(async ([tab, programmatic]) => {
        await writeEvent({ kind: 'tab_activated', tabId, windowId, rawUrl: tab.url, title: tab.title, programmatic });
        // Cadence-initiated switches (Focus Flip, restore, ritual docs) are not the user's behaviour:
        // no learning, and never a "Switch to …?" offer.
        if (programmatic) return;
        await handleUserActivation(tabId, tab.url);
        await checkAndOfferSwitch(await getDemoMode());
      })
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
    handleTabRemoved(tabId).catch((err) => console.error('[cadence] flip tab-removed failed', err));
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[FOCUS_FLIP_KEY] && changes[FOCUS_FLIP_KEY].newValue !== true) {
      disableFocusFlip().catch((err) => console.error('[cadence] disabling focus flip failed', err));
    }
    if (area === 'local' && changes.paused?.newValue === true) {
      cancelFlip().catch((err) => console.error('[cadence] cancel flip on pause failed', err));
    }
    if (area === 'local' && changes.paused) {
      updateBadge().catch((err) => console.error('[cadence] badge failed', err));
    }
    if (area === 'local' && changes[RETENTION_KEY]) {
      purgeExpiredEvents().catch((err) => console.error('[cadence] retention purge failed', err));
    }
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    const lost = windowId === chrome.windows.WINDOW_ID_NONE;
    if (lost) cancelFlip().catch((err) => console.error('[cadence] cancel flip on blur failed', err));
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
