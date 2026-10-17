import type { CalendarEvent } from './types';

export interface CalendarSource {
  getEvents(fromTs: number, toTs: number): Promise<CalendarEvent[]>;
}

const DEMO_EVENTS_KEY = 'demoCalendarEvents';
const CALENDAR_FALLBACK_NOTICE_KEY = 'calendarFallbackNotice';
const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

interface DemoSeriesTemplate {
  title: string;
  durationMinutes: number;
  intervalHours: number;
  days: number;
}

interface DemoCalendarTemplate {
  series: DemoSeriesTemplate[];
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function setCalendarFallbackNotice(message: string | null): Promise<void> {
  await chrome.storage.local.set({ [CALENDAR_FALLBACK_NOTICE_KEY]: message });
}

export async function getCalendarFallbackNotice(): Promise<string | null> {
  const { [CALENDAR_FALLBACK_NOTICE_KEY]: notice } =
    await chrome.storage.local.get<Record<string, string | null>>(CALENDAR_FALLBACK_NOTICE_KEY);
  return notice ?? null;
}

/** Test-only seeding hook: overwrites the demo calendar with exact synthetic data. */
export async function setDemoCalendarEvents(events: CalendarEvent[]): Promise<void> {
  await chrome.storage.local.set({ [DEMO_EVENTS_KEY]: events });
}

/** Demo events for a hackathon-friendly offline calendar. Seeded once from public/demo-calendar.json, then cached in storage. */
export class DemoCalendarSource implements CalendarSource {
  async getEvents(fromTs: number, toTs: number): Promise<CalendarEvent[]> {
    const events = await this.ensureSeeded();
    return events.filter((e) => e.start < toTs && e.end > fromTs);
  }

  private async ensureSeeded(): Promise<CalendarEvent[]> {
    const { [DEMO_EVENTS_KEY]: existing } =
      await chrome.storage.local.get<Record<string, CalendarEvent[] | undefined>>(DEMO_EVENTS_KEY);
    if (existing && existing.length > 0) return existing;

    const seeded = await this.seedFromTemplate();
    await chrome.storage.local.set({ [DEMO_EVENTS_KEY]: seeded });
    return seeded;
  }

  private async seedFromTemplate(): Promise<CalendarEvent[]> {
    const template: DemoCalendarTemplate = await fetch(chrome.runtime.getURL('/demo-calendar.json')).then(
      (res) => res.json(),
    );

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    const events: CalendarEvent[] = [];
    for (const series of template.series) {
      const seriesKey = normalizeTitle(series.title);
      const totalHours = series.days * 24;
      for (let h = 0; h < totalHours; h += series.intervalHours) {
        const start = dayStart.getTime() + h * 60 * 60 * 1000;
        const end = start + series.durationMinutes * 60 * 1000;
        events.push({ id: `${seriesKey}-${start}`, seriesKey, title: series.title, start, end });
      }
    }
    return events;
  }
}

interface GoogleAuthToken {
  token?: string;
}

/** Reads the real Google Calendar via chrome.identity. Falls back to the demo source on any failure, never throws. */
export class GoogleCalendarSource implements CalendarSource {
  async getEvents(fromTs: number, toTs: number): Promise<CalendarEvent[]> {
    const clientId = chrome.runtime.getManifest().oauth2?.client_id;
    if (!clientId || clientId.includes('TODO')) {
      await setCalendarFallbackNotice(
        'No Google OAuth client ID configured in wxt.config.ts — using the demo calendar.',
      );
      return new DemoCalendarSource().getEvents(fromTs, toTs);
    }

    try {
      const result = (await chrome.identity.getAuthToken({
        interactive: true,
        scopes: [CALENDAR_READONLY_SCOPE],
      })) as GoogleAuthToken | string | undefined;
      const accessToken = typeof result === 'string' ? result : result?.token;
      if (!accessToken) throw new Error('No access token returned');

      const events = await this.fetchEvents(accessToken, fromTs, toTs);
      await setCalendarFallbackNotice(null);
      return events;
    } catch (err) {
      await setCalendarFallbackNotice(
        `Google Calendar sign-in failed (${String(err)}) — using the demo calendar instead.`,
      );
      return new DemoCalendarSource().getEvents(fromTs, toTs);
    }
  }

  private async fetchEvents(accessToken: string, fromTs: number, toTs: number): Promise<CalendarEvent[]> {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', new Date(fromTs).toISOString());
    url.searchParams.set('timeMax', new Date(toTs).toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Calendar API error: ${res.status}`);
    const data: { items?: GoogleCalendarApiEvent[] } = await res.json();

    return (data.items ?? [])
      .filter((item) => item.start && item.end)
      .map((item) => ({
        id: item.id,
        seriesKey: item.recurringEventId ?? item.id,
        title: item.summary ?? '(untitled)',
        start: new Date(item.start!.dateTime ?? item.start!.date!).getTime(),
        end: new Date(item.end!.dateTime ?? item.end!.date!).getTime(),
      }));
  }
}

interface GoogleCalendarApiEvent {
  id: string;
  summary?: string;
  recurringEventId?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export function createCalendarSource(kind: 'demo' | 'google'): CalendarSource {
  return kind === 'google' ? new GoogleCalendarSource() : new DemoCalendarSource();
}
