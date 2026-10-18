// Which macro suggestions to show: pure ranking, snoozing and overlap merging.
import { MACRO_DISMISS_STOP } from './constants';
import { openUrlSet } from './macro-detection';
import type { Macro } from './types';

/** At most this many suggestions are visible at once. */
export const MAX_SUGGESTIONS = 2;
/** A suggestion whose pages are at least this contained in a longer one is the same routine. */
const CONTAINMENT = 0.8;

function containment(small: Set<string>, big: Set<string>): number {
  if (small.size === 0) return 0;
  let hit = 0;
  for (const u of small) if (big.has(u)) hit++;
  return hit / small.size;
}

/**
 * Merges overlapping suggestions, keeping the longest. Input order is irrelevant; the survivor of
 * two overlapping routines is the one with more steps (ties: seen more often, then newer).
 */
export function dedupeSuggestions<M extends Macro>(suggestions: M[]): M[] {
  const ranked = [...suggestions].sort(
    (a, b) =>
      openUrlSet(b.steps).size - openUrlSet(a.steps).size || b.occurrences - a.occurrences || b.updatedAt - a.updatedAt,
  );
  const kept: M[] = [];
  for (const candidate of ranked) {
    const urls = openUrlSet(candidate.steps);
    if (!kept.some((k) => containment(urls, openUrlSet(k.steps)) >= CONTAINMENT)) kept.push(candidate);
  }
  return kept;
}

/** Suggestions currently worth showing: not snoozed, not dismissed to death, merged, best first, capped. */
export function visibleSuggestions<M extends Macro>(macros: M[], now: number): M[] {
  const live = macros.filter(
    (m) =>
      m.status === 'suggested' &&
      (m.snoozedUntil ?? 0) <= now &&
      (m.stats?.offersDismissed ?? 0) < MACRO_DISMISS_STOP,
  );
  // A command (Find PDF) has no steps to weigh, and one sighting of it is meant to be enough: it ranks first.
  const score = (m: Macro) => (m.command ? Number.MAX_SAFE_INTEGER : m.occurrences * openUrlSet(m.steps).size);
  return dedupeSuggestions(live)
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_SUGGESTIONS);
}

/** Saved (accepted / auto) macros, listed above suggestions. */
export function savedMacros<M extends Macro>(macros: M[]): M[] {
  return macros.filter((m) => m.status === 'accepted' || m.status === 'auto');
}

/** Stored suggestions that a longer one makes redundant: safe to delete (saved macros are never in this list). */
export function dominatedSuggestions<M extends Macro>(macros: M[]): M[] {
  const suggested = macros.filter((m) => m.status === 'suggested');
  const keep = new Set(dedupeSuggestions(suggested));
  return suggested.filter((m) => !keep.has(m));
}
