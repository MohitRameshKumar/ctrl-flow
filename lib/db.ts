import Dexie, { type EntityTable } from 'dexie';
import { recordRun, runWasClean } from './macro-learning';
import { checkTypedStep, sanitizeParams } from './macro-privacy';
import { getBlocklist } from './privacy';
import type {
  CadenceEvent,
  EventKind,
  FlipPair,
  Macro,
  MacroRunResult,
  MacroStats,
  MacroStep,
  MacroRunRecord,
  NormalizedMacro,
  Ritual,
  RunMode,
  Shelf,
  Space,
  SpaceUrl,
} from './types';

const db = new Dexie('cadence') as Dexie & {
  events: EntityTable<CadenceEvent, 'id'>;
  rituals: EntityTable<Ritual, 'id'>;
  spaces: EntityTable<Space, 'id'>;
  spaceUrls: EntityTable<SpaceUrl, 'id'>;
  shelves: EntityTable<Shelf, 'id'>;
  flipPairs: EntityTable<FlipPair, 'id'>;
  macros: EntityTable<Macro, 'id'>;
  macroRuns: EntityTable<MacroRunRecord, 'id'>;
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

// v4 only adds flipPairs (Focus Flip); every earlier table carries forward unchanged. This version
// shipped first on this branch, so it keeps its number: installs already at v4 must not be re-keyed.
db.version(4).stores({
  flipPairs: '++id, [writingUrl+referenceUrl], active, updatedAt',
});

// v5 adds `macros` (Repeat-to-Macro). It was v4 on the macro branch; renumbered here because v4 was
// already taken. The full store set is redeclared so the chain reads unambiguously; every earlier
// table is identical, so this upgrade changes no stored row.
db.version(5).stores({
  events: '++id, ts, kind, domain, tabId, [kind+ts]',
  rituals: '++id, seriesKey, status, updatedAt',
  spaces: '++id, name, status, createdAt, updatedAt',
  spaceUrls: '++id, spaceId, url, source, [spaceId+url]',
  shelves: '++id, spaceId, createdAt',
  flipPairs: '++id, [writingUrl+referenceUrl], active, updatedAt',
  macros: '++id, macroKey, status, updatedAt',
});

// v6 adds `macroRuns` (was v5 on the macro branch); every earlier table carries forward unchanged.
// Macro rows gained optional fields instead of being migrated — see `withMacroDefaults`.
db.version(6).stores({
  events: '++id, ts, kind, domain, tabId, [kind+ts]',
  rituals: '++id, seriesKey, status, updatedAt',
  spaces: '++id, name, status, createdAt, updatedAt',
  spaceUrls: '++id, spaceId, url, source, [spaceId+url]',
  shelves: '++id, spaceId, createdAt',
  flipPairs: '++id, [writingUrl+referenceUrl], active, updatedAt',
  macros: '++id, macroKey, status, updatedAt',
  macroRuns: '++id, macroId, startedAt',
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

export const EMPTY_MACRO_STATS: MacroStats = {
  runs: 0,
  successes: 0,
  failures: 0,
  undos: 0,
  offersShown: 0,
  offersDismissed: 0,
  cleanStreak: 0,
};

/**
 * Fills in fields that rows written by an earlier version do not have.
 *
 * Normalizing on read rather than migrating keeps the Dexie rule intact — no stored row is ever
 * rewritten — and means a half-upgraded database is never in an invalid state.
 */
export function withMacroDefaults(macro: Macro): NormalizedMacro {
  return {
    ...macro,
    params: sanitizeParams(macro.params), // redacted on read too, so rows stored before the rule are cleaned
    stats: { ...EMPTY_MACRO_STATS, ...(macro.stats ?? {}) },
  };
}

export async function getMacros(): Promise<NormalizedMacro[]> {
  return (await db.macros.toArray()).map(withMacroDefaults);
}

export async function getMacroById(id: number): Promise<NormalizedMacro | undefined> {
  const macro = await db.macros.get(id);
  return macro ? withMacroDefaults(macro) : undefined;
}

export async function getMacroByKey(macroKey: string): Promise<NormalizedMacro | undefined> {
  const macro = await db.macros.where('macroKey').equals(macroKey).first();
  return macro ? withMacroDefaults(macro) : undefined;
}

export function putMacro(macro: Macro): Promise<number | undefined> {
  return db.macros.put(macro.params ? { ...macro, params: sanitizeParams(macro.params) } : macro);
}

export async function updateMacroStatus(id: number, status: Macro['status']): Promise<void> {
  await db.macros.update(id, { status, updatedAt: Date.now() });
}

export async function setMacroReuseOpenTabs(id: number, reuseOpenTabs: boolean): Promise<void> {
  await db.macros.update(id, { reuseOpenTabs, updatedAt: Date.now() });
}

export async function renameMacro(id: number, name: string): Promise<void> {
  await db.macros.update(id, { name, nameIsUserSet: true, updatedAt: Date.now() });
}

/**
 * Records that the user set this step's `enabled` by hand. Pinning the key is what stops the
 * next recompute from flipping it back.
 */
export async function setMacroStepEnabled(id: number, stepKey: string, enabled: boolean): Promise<void> {
  const macro = await db.macros.get(id);
  if (!macro) return;
  await db.macros.update(id, {
    steps: macro.steps.map((s) => (s.key === stepKey ? { ...s, enabled } : s)),
    pinnedStepKeys: macro.pinnedStepKeys.includes(stepKey)
      ? macro.pinnedStepKeys
      : [...macro.pinnedStepKeys, stepKey],
    updatedAt: Date.now(),
  });
}

/** Mirrors removeRitualUrl: drops the step and remembers it so recompute never re-adds it. */
export async function removeMacroStep(id: number, stepKey: string): Promise<void> {
  const macro = await db.macros.get(id);
  if (!macro) return;
  await db.macros.update(id, {
    steps: macro.steps.filter((s) => s.key !== stepKey),
    removedStepKeys: macro.removedStepKeys.includes(stepKey)
      ? macro.removedStepKeys
      : [...macro.removedStepKeys, stepKey],
    updatedAt: Date.now(),
  });
}

export async function moveMacroStep(id: number, stepKey: string, delta: number): Promise<void> {
  const macro = await db.macros.get(id);
  if (!macro) return;
  const from = macro.steps.findIndex((s) => s.key === stepKey);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= macro.steps.length) return;
  const steps = [...macro.steps];
  const [moved] = steps.splice(from, 1);
  if (!moved) return;
  steps.splice(to, 0, moved);
  await db.macros.update(id, { steps, updatedAt: Date.now() });
}

/**
 * Appends a step the user built by hand.
 *
 * Pinned immediately: a hand-made step has no support in the observed data, so without pinning
 * the next recompute would treat it as noise and drop it.
 */
export async function addMacroStep(id: number, step: MacroStep): Promise<void> {
  // The single gate for typed values (lib/macro-privacy.ts). The caller surfaces the message.
  if (step.kind === 'type' && step.text) {
    const check = checkTypedStep({ text: step.text, url: step.url, selector: step.selector }, await getBlocklist());
    if (!check.ok) throw new Error(`${check.reason} Not saved.`);
  }
  const macro = await db.macros.get(id);
  if (!macro) return;
  await db.macros.update(id, {
    steps: [...macro.steps, step],
    pinnedStepKeys: [...macro.pinnedStepKeys, step.key],
    updatedAt: Date.now(),
  });
}

/**
 * Stores the run and folds it into the macro's counters.
 *
 * v1 wrote `lastRunResult` and nothing read it. The durable per-run rows go to `macroRuns`, and
 * the rollup on the macro is what promotion and ranking actually consult.
 */
export async function recordMacroRun(
  id: number,
  result: MacroRunResult,
  mode: RunMode = 'guided',
): Promise<void> {
  const macro = await db.macros.get(id);
  if (!macro) return;

  const stats = recordRun({ ...EMPTY_MACRO_STATS, ...(macro.stats ?? {}) }, result);

  await db.macroRuns.add({
    macroId: id,
    mode,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    outcomes: result.outcomes,
    clean: runWasClean(result),
  });

  await db.macros.update(id, {
    lastRunAt: result.finishedAt,
    lastRunResult: result,
    stats,
    updatedAt: Date.now(),
  });
}

export async function updateMacroStats(
  id: number,
  update: (stats: MacroStats) => MacroStats,
): Promise<void> {
  const macro = await db.macros.get(id);
  if (!macro) return;
  const stats = update({ ...EMPTY_MACRO_STATS, ...(macro.stats ?? {}) });
  await db.macros.update(id, { stats, updatedAt: Date.now() });
}

export async function setMacroTrigger(id: number, trigger: Macro['trigger']): Promise<void> {
  await db.macros.update(id, { trigger, updatedAt: Date.now() });
}

export function getMacroRuns(macroId: number): Promise<MacroRunRecord[]> {
  return db.macroRuns.where('macroId').equals(macroId).toArray();
}

/**
 * Trims macro bookkeeping: run history and long-rejected ("never") suggestions. Saved macros are
 * never removed. Called from the cleanup alarm with a fixed horizon, independent of the events
 * retention setting.
 */
export async function pruneMacroData(cutoff: number): Promise<void> {
  await db.macroRuns.where('startedAt').below(cutoff).delete();

  // A macro the user rejected is kept briefly so a rescan cannot resurrect it, then dropped.
  const stale = await db.macros
    .where('status')
    .equals('never')
    .and((m) => m.updatedAt < cutoff)
    .primaryKeys();
  if (stale.length > 0) await db.macros.bulkDelete(stale as number[]);

  // Shelves are deliberately NOT pruned here (the macro branch did): a shelved space is a saved item
  // the user expects to restore, and retention in this app deletes events only.
}

export async function deleteMacro(id: number): Promise<void> {
  await db.macros.delete(id);
}
