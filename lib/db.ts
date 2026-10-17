import Dexie, { type EntityTable } from 'dexie';
import type { CadenceEvent, EventKind, Ritual } from './types';

const db = new Dexie('cadence') as Dexie & {
  events: EntityTable<CadenceEvent, 'id'>;
  rituals: EntityTable<Ritual, 'id'>;
};

db.version(1).stores({
  events: '++id, ts, kind, domain, tabId, [kind+ts]',
});

// v2 only adds the `rituals` table; `events` carries forward unchanged.
db.version(2).stores({
  rituals: '++id, seriesKey, status, updatedAt',
});

export { db };

export function getEvents(fromTs: number, toTs: number): Promise<CadenceEvent[]> {
  return db.events.where('ts').between(fromTs, toTs, true, true).toArray();
}

export function getEventsByKind(
  kind: EventKind,
  fromTs: number,
  toTs: number,
): Promise<CadenceEvent[]> {
  return db.events
    .where('[kind+ts]')
    .between([kind, fromTs], [kind, toTs], true, true)
    .toArray();
}

export async function getEventsForDomain(
  domain: string,
  fromTs: number,
  toTs: number,
): Promise<CadenceEvent[]> {
  return db.events
    .where('domain')
    .equals(domain)
    .and((e) => e.ts >= fromTs && e.ts <= toTs)
    .toArray();
}

export async function countByKind(
  fromTs: number,
  toTs: number,
): Promise<Record<EventKind, number>> {
  const events = await getEvents(fromTs, toTs);
  const counts: Partial<Record<EventKind, number>> = {};
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  return counts as Record<EventKind, number>;
}

export function exportAll(): Promise<CadenceEvent[]> {
  return db.events.toArray();
}

export function clearAll(): Promise<void> {
  return db.events.clear();
}

export function getRituals(): Promise<Ritual[]> {
  return db.rituals.toArray();
}

export function getRitualBySeriesKey(seriesKey: string): Promise<Ritual | undefined> {
  return db.rituals.where('seriesKey').equals(seriesKey).first();
}

export function putRitual(ritual: Ritual): Promise<number | undefined> {
  return db.rituals.put(ritual);
}

export async function updateRitualStatus(id: number, status: Ritual['status']): Promise<void> {
  await db.rituals.update(id, { status, updatedAt: Date.now() });
}

export async function removeRitualUrl(id: number, url: string): Promise<void> {
  const ritual = await db.rituals.get(id);
  if (!ritual) return;
  await db.rituals.update(id, {
    urls: ritual.urls.filter((u) => u.url !== url),
    removedUrls: ritual.removedUrls.includes(url) ? ritual.removedUrls : [...ritual.removedUrls, url],
    updatedAt: Date.now(),
  });
}
