import Dexie, { type EntityTable } from 'dexie';
import type { CadenceEvent, EventKind, FlipPair, Ritual, Shelf, Space, SpaceUrl } from './types';

const db = new Dexie('cadence') as Dexie & {
  events: EntityTable<CadenceEvent, 'id'>;
  rituals: EntityTable<Ritual, 'id'>;
  spaces: EntityTable<Space, 'id'>;
  spaceUrls: EntityTable<SpaceUrl, 'id'>;
  shelves: EntityTable<Shelf, 'id'>;
  flipPairs: EntityTable<FlipPair, 'id'>;
};

db.version(1).stores({
  events: '++id, ts, kind, domain, tabId, [kind+ts]',
});

// v2 only adds the `rituals` table; `events` carries forward unchanged.
db.version(2).stores({
  rituals: '++id, seriesKey, status, updatedAt',
});

// v3 only adds spaces/spaceUrls/shelves; `events` and `rituals` carry forward unchanged.
db.version(3).stores({
  spaces: '++id, name, status, createdAt, updatedAt',
  spaceUrls: '++id, spaceId, url, source, [spaceId+url]',
  shelves: '++id, spaceId, createdAt',
});

// v4 only adds flipPairs (Focus Flip); every earlier table carries forward unchanged.
db.version(4).stores({
  flipPairs: '++id, [writingUrl+referenceUrl], active, updatedAt',
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

export function getSpaces(): Promise<Space[]> {
  return db.spaces.toArray();
}

export function getSpaceById(id: number): Promise<Space | undefined> {
  return db.spaces.get(id);
}

export function getSpaceUrls(): Promise<SpaceUrl[]> {
  return db.spaceUrls.toArray();
}

export function getSpaceUrlsForSpace(spaceId: number): Promise<SpaceUrl[]> {
  return db.spaceUrls.where('spaceId').equals(spaceId).toArray();
}

export function getSpaceUrlByUrl(url: string): Promise<SpaceUrl | undefined> {
  return db.spaceUrls.where('url').equals(url).first();
}

export function createSpace(space: Omit<Space, 'id'>): Promise<number | undefined> {
  return db.spaces.add(space);
}

/** A rename is a user edit: it flips the space to 'user' so a later recompute never regroups or relabels it. */
export async function renameSpace(id: number, name: string): Promise<void> {
  await db.spaces.update(id, { name, status: 'user', updatedAt: Date.now() });
}

export async function deleteSpace(id: number): Promise<void> {
  await db.spaces.delete(id);
}

export function addSpaceUrl(spaceUrl: Omit<SpaceUrl, 'id'>): Promise<number | undefined> {
  return db.spaceUrls.add(spaceUrl);
}

export async function moveSpaceUrl(spaceUrlId: number, toSpaceId: number): Promise<void> {
  await db.spaceUrls.update(spaceUrlId, { spaceId: toSpaceId, source: 'user' });
}

export async function setSpaceUrlAlwaysOpen(spaceUrlId: number, alwaysOpen: boolean): Promise<void> {
  await db.spaceUrls.update(spaceUrlId, { alwaysOpen, source: 'user' });
}

/** Most recent event of `kind` strictly before `ts` — the activation that started a stay already in progress. */
export function getLastEventOfKindBefore(kind: EventKind, ts: number): Promise<CadenceEvent | undefined> {
  return db.events.where('[kind+ts]').between([kind, 0], [kind, ts], true, false).last();
}

export async function removeSpaceUrl(spaceUrlId: number): Promise<void> {
  await db.spaceUrls.delete(spaceUrlId);
}

export function addShelf(shelf: Omit<Shelf, 'id'>): Promise<number | undefined> {
  return db.shelves.add(shelf);
}

export async function getLatestShelfForSpace(spaceId: number): Promise<Shelf | undefined> {
  const shelves = await db.shelves.where('spaceId').equals(spaceId).toArray();
  return shelves.sort((a, b) => b.createdAt - a.createdAt)[0];
}

export async function deleteShelf(id: number): Promise<void> {
  await db.shelves.delete(id);
}

export function getFlipPairs(): Promise<FlipPair[]> {
  return db.flipPairs.toArray();
}

export function getFlipPair(writingUrl: string, referenceUrl: string): Promise<FlipPair | undefined> {
  return db.flipPairs.where('[writingUrl+referenceUrl]').equals([writingUrl, referenceUrl]).first();
}

export function putFlipPair(pair: FlipPair): Promise<number | undefined> {
  return db.flipPairs.put(pair);
}

export async function deleteFlipPair(id: number): Promise<void> {
  await db.flipPairs.delete(id);
}
