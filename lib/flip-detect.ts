// Focus Flip pair detection from the event log. Pure (no chrome.* / Dexie).
//
// The live tracker in focus-flip.ts learns from keystroke pings the page sends. That depends on the
// page reporting typing, which a rich editor can make unreliable: Google Docs takes keys in a hidden
// iframe. This second path needs only two things the collector already stores for any frame: which tab
// was in front (tab_activated) and that typing happened in a tab (typing_burst, whose url is the TOP
// page's, wherever the key landed). Counts and URLs only: no key values, positions or content.
import { MIN_VISIT_MS, ROUND_TRIP_WINDOW_MS, ROUND_TRIPS_REQUIRED, ROUND_TRIPS_REQUIRED_DEMO } from './flip-learning';
import type { CadenceEvent } from './types';

/** A typing burst is reported up to ~5 s after the last key (the content script's debounce). */
export const BURST_FLUSH_SLACK_MS = 6000;

export interface DetectedPair {
  writingUrl: string;
  referenceUrl: string;
  /** Completed writing -> reference -> writing trips inside the window. */
  trips: number;
  /** When the most recent one finished. */
  lastTs: number;
}

interface Visit {
  tabId: number;
  url: string;
  start: number;
  end: number;
}

export function detectPairsFromEvents(
  events: CadenceEvent[],
  opts: { now: number; demoMode: boolean; windowMs?: number },
): DetectedPair[] {
  const windowMs = opts.windowMs ?? ROUND_TRIP_WINDOW_MS;
  const from = opts.now - windowMs;
  const recent = events.filter((e) => e.ts >= from && e.ts <= opts.now && !e.synthetic);

  const activations = recent
    .filter((e) => e.kind === 'tab_activated' && !e.programmatic && e.url && e.tabId !== undefined)
    .sort((a, b) => a.ts - b.ts);
  const bursts = recent.filter((e) => e.kind === 'typing_burst' && e.tabId !== undefined && e.url);

  // One visit per change of tab; a repeat activation of the tab already in front is not a new visit.
  const visits: Visit[] = [];
  for (const a of activations) {
    const prev = visits[visits.length - 1];
    if (prev && prev.tabId === a.tabId && prev.url === a.url) continue;
    if (prev) prev.end = a.ts;
    visits.push({ tabId: a.tabId!, url: a.url!, start: a.ts, end: opts.now });
  }

  const typedIn = (v: Visit): boolean =>
    bursts.some((b) => b.tabId === v.tabId && b.url === v.url && b.ts >= v.start && b.ts <= v.end + BURST_FLUSH_SLACK_MS);

  const required = opts.demoMode ? ROUND_TRIPS_REQUIRED_DEMO : ROUND_TRIPS_REQUIRED;
  const found = new Map<string, DetectedPair>();
  for (let i = 0; i + 2 < visits.length; i++) {
    const w1 = visits[i]!;
    const r = visits[i + 1]!;
    const w2 = visits[i + 2]!;
    if (w1.url !== w2.url || r.url === w1.url) continue;
    if (!typedIn(w1)) continue; // the writing side is where you typed before leaving
    if (r.end - r.start < MIN_VISIT_MS) continue; // tab-flicking, not reading
    const key = `${w1.url}\n${r.url}`;
    const cur = found.get(key) ?? { writingUrl: w1.url, referenceUrl: r.url, trips: 0, lastTs: 0 };
    cur.trips++;
    cur.lastTs = Math.max(cur.lastTs, w2.start);
    found.set(key, cur);
  }
  return [...found.values()].filter((p) => p.trips >= required);
}
