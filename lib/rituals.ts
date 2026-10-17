import { db, getEvents, getRitualBySeriesKey, putRitual } from './db';
import { markProgrammaticNav } from './programmatic';
import type { CalendarSource } from './calendar';
import type { CalendarEvent, Ritual, RitualUrl } from './types';

const BEFORE_WINDOW_MS = 15 * 60 * 1000;
const AFTER_WINDOW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const RITUAL_RECOMPUTE_ALARM = 'cadence-ritual-recompute';
export const RITUAL_TRIGGER_ALARM_PREFIX = 'cadence-ritual-trigger:';
export const RITUAL_NOTIFICATION_PREFIX = 'cadence-ritual:';

const MEETING_JOIN_DOMAINS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com'];
const CALENDAR_DOMAINS = ['calendar.google.com'];

function isExcludedFromRitual(url: string): boolean {
  let domain: string;
  try {
    domain = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  const inList = (list: string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));
  return inList(MEETING_JOIN_DOMAINS) || inList(CALENDAR_DOMAINS);
}

async function collectUrlsNearOccurrence(
  occurrenceStart: number,
): Promise<{ url: string; title?: string }[]> {
  const events = await getEvents(occurrenceStart - BEFORE_WINDOW_MS, occurrenceStart + AFTER_WINDOW_MS);
  const results: { url: string; title?: string }[] = [];
  for (const e of events) {
    if (e.kind !== 'tab_activated' && e.kind !== 'tab_opened' && e.kind !== 'navigated') continue;
    if (e.programmatic) continue; // Cadence-initiated switches are not the user's behaviour
    if (!e.url || isExcludedFromRitual(e.url)) continue;
    results.push({ url: e.url, title: e.title });
  }
  return results;
}

/** Merge freshly-detected URLs into an existing ritual without resurrecting removed URLs or touching status. */
async function mergeRitual(seriesKey: string, title: string, detectedUrls: RitualUrl[]): Promise<void> {
  const existing = await getRitualBySeriesKey(seriesKey);

  if (!existing) {
    if (detectedUrls.length === 0) return;
    await putRitual({
      seriesKey,
      title,
      urls: detectedUrls,
      removedUrls: [],
      status: 'suggested',
      updatedAt: Date.now(),
    });
    return;
  }

  const removedSet = new Set(existing.removedUrls);
  const freshUrls = detectedUrls.filter((u) => !removedSet.has(u.url));

  await putRitual({
    ...existing,
    title,
    urls: freshUrls,
    updatedAt: Date.now(),
  });
}

export interface DetectOptions {
  demoMode: boolean;
}

/** Recomputes every ritual from calendar history + collected events. Never overwrites status or removed URLs. */
export async function detectRituals(calendarSource: CalendarSource, options: DetectOptions): Promise<void> {
  const now = Date.now();
  const calEvents = await calendarSource.getEvents(now - 7 * DAY_MS, now + 2 * DAY_MS);

  const bySeries = new Map<string, CalendarEvent[]>();
  for (const e of calEvents) {
    const list = bySeries.get(e.seriesKey) ?? [];
    list.push(e);
    bySeries.set(e.seriesKey, list);
  }

  const windowSize = options.demoMode ? 2 : 3;
  const requiredHits = 2;

  for (const [seriesKey, occurrences] of bySeries) {
    const past = occurrences.filter((o) => o.start <= now).sort((a, b) => b.start - a.start);
    if (past.length < 2) continue;

    const considered = past.slice(0, windowSize);
    const urlHits = new Map<string, { count: number; pageTitle?: string }>();

    for (const occ of considered) {
      const found = await collectUrlsNearOccurrence(occ.start);
      const seenThisOccurrence = new Set<string>();
      for (const { url, title } of found) {
        if (seenThisOccurrence.has(url)) continue;
        seenThisOccurrence.add(url);
        const entry = urlHits.get(url) ?? { count: 0, pageTitle: title };
        entry.count++;
        if (!entry.pageTitle && title) entry.pageTitle = title;
        urlHits.set(url, entry);
      }
    }

    const qualifyingUrls: RitualUrl[] = [...urlHits.entries()]
      .filter(([, v]) => v.count >= requiredHits)
      .map(([url, v]) => ({ url, pageTitle: v.pageTitle, occurrences: v.count }));

    const latest = past[0];
    if (!latest) continue;
    await mergeRitual(seriesKey, latest.title, qualifyingUrls);
  }
}

/** Clears and reschedules the 5-minutes-before-meeting alarm for every non-"never" ritual. */
export async function scheduleRitualAlarms(calendarSource: CalendarSource): Promise<void> {
  const now = Date.now();
  const upcoming = await calendarSource.getEvents(now, now + 2 * DAY_MS);
  const rituals = await db.rituals.toArray();

  const allAlarms = await chrome.alarms.getAll();
  await Promise.all(
    allAlarms
      .filter((a) => a.name.startsWith(RITUAL_TRIGGER_ALARM_PREFIX))
      .map((a) => chrome.alarms.clear(a.name)),
  );

  for (const ritual of rituals) {
    if (ritual.status === 'never' || ritual.id === undefined) continue;
    const next = upcoming
      .filter((e) => e.seriesKey === ritual.seriesKey && e.start > now)
      .sort((a, b) => a.start - b.start)[0];
    if (!next) continue;

    const triggerAt = next.start - 5 * 60 * 1000;
    if (triggerAt <= now) continue;
    chrome.alarms.create(`${RITUAL_TRIGGER_ALARM_PREFIX}${ritual.id}`, { when: triggerAt });
  }
}

export async function openRitualDocs(ritual: Ritual): Promise<void> {
  if (ritual.urls.length === 0) return;
  const tabs = await Promise.all(ritual.urls.map((u) => chrome.tabs.create({ url: u.url, active: false })));
  const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
  const firstTabId = tabIds[0];
  if (firstTabId === undefined) return;

  const groupId = await chrome.tabs.group({ tabIds: [firstTabId, ...tabIds.slice(1)] });
  await chrome.tabGroups.update(groupId, { title: ritual.title, collapsed: false });
  await markProgrammaticNav(firstTabId);
  await chrome.tabs.update(firstTabId, { active: true });
  const tab = await chrome.tabs.get(firstTabId);
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function notifyRitual(ritual: Ritual): Promise<void> {
  await chrome.notifications.create(`${RITUAL_NOTIFICATION_PREFIX}${ritual.id}`, {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: `${ritual.title} in 5 min`,
    message: `Open your ${ritual.urls.length} prep doc${ritual.urls.length === 1 ? '' : 's'}?`,
    buttons: [{ title: 'Open docs' }],
  });
}

/** Called when a ritual's trigger alarm fires (or from "Test now"). */
export async function fireRitualTrigger(ritualId: number): Promise<void> {
  const ritual = await db.rituals.get(ritualId);
  if (!ritual || ritual.status === 'never' || ritual.urls.length === 0) return;

  if (ritual.status === 'auto') {
    await openRitualDocs(ritual);
  }
  await notifyRitual(ritual);
}

export async function handleRitualNotificationButtonClicked(notificationId: string): Promise<void> {
  if (!notificationId.startsWith(RITUAL_NOTIFICATION_PREFIX)) return;
  const ritualId = Number(notificationId.slice(RITUAL_NOTIFICATION_PREFIX.length));
  const ritual = await db.rituals.get(ritualId);
  if (!ritual) return;
  await openRitualDocs(ritual);
  await chrome.notifications.clear(notificationId);
}
