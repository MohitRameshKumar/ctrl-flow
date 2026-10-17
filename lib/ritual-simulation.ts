// Debug-page-only helpers that make Pre-Meeting Rituals testable on demand. The demo calendar's
// "Team sync" sits on a 3-hour grid and real detection needs the same docs open around BOTH of the
// last two occurrences, so a ritual essentially never appears organically. Everything written here
// is marked `synthetic` (events) / `synthetic-` (calendar ids) and removed by wipeSyntheticRitualData.
// Real detection thresholds are untouched: this only feeds detectRituals() the data it would need.
import { DemoCalendarSource, setDemoCalendarEvents } from './calendar';
import { db } from './db';
import { normalizeUrl } from './normalize';
import { getBlocklist, isBlocklisted } from './privacy';
import { detectRituals, scheduleRitualAlarms } from './rituals';
import type { CadenceEvent, CalendarEvent } from './types';

const SERIES_KEY = 'team sync';
const SYNTHETIC_ID_PREFIX = 'synthetic-';
const MIN = 60 * 1000;
const FAR_PAST = 30 * 24 * 60 * MIN;
const FAR_FUTURE = 30 * 24 * 60 * MIN;

export interface SimulationResult {
  occurrences: number;
  tabs: number;
  rituals: number;
}

async function allCalendarEvents(): Promise<CalendarEvent[]> {
  const now = Date.now();
  return new DemoCalendarSource().getEvents(now - FAR_PAST, now + FAR_FUTURE);
}

async function recompute(): Promise<void> {
  const source = new DemoCalendarSource();
  await detectRituals(source, { demoMode: true });
  await scheduleRitualAlarms(source);
}

/** Adds two past "Team sync" occurrences plus a tab_opened event for each currently open tab near
 * each of the last two occurrences, then runs detection. */
export async function simulateTwoPastTeamSyncs(): Promise<SimulationResult> {
  const now = Date.now();
  const existing = await allCalendarEvents();

  const synthetic: CalendarEvent[] = [31 * MIN, 1 * MIN].map((ago) => ({
    id: `${SYNTHETIC_ID_PREFIX}${SERIES_KEY}-${now - ago}`,
    seriesKey: SERIES_KEY,
    title: 'Team sync',
    start: now - ago,
    end: now - ago + 30 * MIN,
  }));
  await setDemoCalendarEvents([...existing.filter((e) => !e.id.startsWith(SYNTHETIC_ID_PREFIX)), ...synthetic]);

  const calendar = await allCalendarEvents();
  const lastTwoPast = calendar
    .filter((e) => e.seriesKey === SERIES_KEY && e.start <= now)
    .sort((a, b) => b.start - a.start)
    .slice(0, 2);

  const blocklist = await getBlocklist();
  const tabs = await chrome.tabs.query({});
  const openTabs: { tabId?: number; windowId?: number; url: string; domain: string; title?: string }[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    const normalized = tab.url ? normalizeUrl(tab.url) : null;
    if (!normalized || isBlocklisted(normalized.domain, blocklist) || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    openTabs.push({
      tabId: tab.id,
      windowId: tab.windowId,
      url: normalized.url,
      domain: normalized.domain,
      title: tab.title,
    });
  }

  const events: CadenceEvent[] = [];
  for (const occ of lastTwoPast) {
    for (const t of openTabs) {
      events.push({
        ts: occ.start - 5 * MIN,
        kind: 'tab_opened',
        tabId: t.tabId,
        windowId: t.windowId,
        url: t.url,
        domain: t.domain,
        title: t.title,
        synthetic: true,
      });
    }
  }
  if (events.length > 0) await db.events.bulkAdd(events);

  await recompute();
  return { occurrences: lastTwoPast.length, tabs: openTabs.length, rituals: await db.rituals.count() };
}

/** Removes everything simulateTwoPastTeamSyncs wrote, including the ritual it produced, then re-detects from real data. */
export async function wipeSyntheticRitualData(): Promise<void> {
  await db.events.filter((e) => e.synthetic === true).delete();
  const remaining = (await allCalendarEvents()).filter((e) => !e.id.startsWith(SYNTHETIC_ID_PREFIX));
  await setDemoCalendarEvents(remaining);
  await db.rituals.where('seriesKey').equals(SERIES_KEY).delete();
  await recompute();
}
