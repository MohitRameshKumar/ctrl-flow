// Privacy-safe co-usage signals computed locally from tab_activated / typing_burst events.
// Pure functions only (no chrome.* / Dexie) so they're directly unit-testable. What leaves the
// device is counts between tab indices — never page content or typed text.
import type { CoUsageEdge, TypedCount } from './types';

export const NEAR_WINDOW_MS = 90 * 1000;
/** A direct switch only counts as co-usage if the next tab was activated this soon after. */
export const MAX_SWITCH_GAP_MS = 10 * 60 * 1000;
export const MAX_EDGES = 60;
export const MAX_CONTEXT_URLS = 30;
export const MAX_TITLE_CHARS = 120;
/** Minimum direct switches for two tabs to count as "used together" in the offline fallback. */
export const OFFLINE_MERGE_MIN_SWITCHES = 3;

export interface Activation {
  url: string;
  ts: number;
}

export interface PairStat {
  switches: number;
  near: number;
}

export function pairStatKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

/** Switch and time-adjacency counts for every URL pair, from activations in any order. */
export function computePairStats(activations: Activation[], nearWindowMs = NEAR_WINDOW_MS): Map<string, PairStat> {
  const sorted = [...activations].sort((x, y) => x.ts - y.ts);
  const stats = new Map<string, PairStat>();
  const bump = (a: string, b: string, field: keyof PairStat) => {
    const key = pairStatKey(a, b);
    const stat = stats.get(key) ?? { switches: 0, near: 0 };
    stat[field]++;
    stats.set(key, stat);
  };

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1];
    if (next && next.url !== cur.url && next.ts - cur.ts <= MAX_SWITCH_GAP_MS) bump(cur.url, next.url, 'switches');

    const seen = new Set<string>();
    for (let j = i + 1; j < sorted.length; j++) {
      const other = sorted[j]!;
      if (other.ts - cur.ts > nearWindowMs) break;
      if (other.url === cur.url || seen.has(other.url)) continue;
      seen.add(other.url);
      bump(cur.url, other.url, 'near');
    }
  }
  return stats;
}

function edgeWeight(e: { switches: number; near: number }): number {
  return e.switches * 2 + e.near;
}

/** Edges among `urls` (indices refer to that array), strongest first, capped at `maxEdges`. */
export function edgesForUrls(
  urls: string[],
  stats: Map<string, PairStat>,
  maxEdges = MAX_EDGES,
): CoUsageEdge[] {
  const edges: CoUsageEdge[] = [];
  for (let a = 0; a < urls.length; a++) {
    for (let b = a + 1; b < urls.length; b++) {
      const stat = stats.get(pairStatKey(urls[a]!, urls[b]!));
      if (!stat || (stat.switches < 1 && stat.near < 2)) continue;
      edges.push({ a, b, switches: stat.switches, near: stat.near });
    }
  }
  edges.sort((x, y) => edgeWeight(y) - edgeWeight(x) || x.a - y.a || x.b - y.b);
  return edges.slice(0, maxEdges);
}

/** Typing-burst counts per URL index. Tabs with no bursts are omitted. */
export function typedCountsForUrls(urls: string[], burstsByUrl: Map<string, number>): TypedCount[] {
  const typed: TypedCount[] = [];
  urls.forEach((url, i) => {
    const bursts = burstsByUrl.get(url);
    if (bursts) typed.push({ i, bursts });
  });
  return typed;
}

export function truncateTitle(title: string | undefined): string {
  return (title ?? '').slice(0, MAX_TITLE_CHARS);
}

/** For assign_tabs: the already-assigned URLs most strongly co-used with any of the new ones. */
export function pickContextUrls(
  newUrls: string[],
  assignedUrls: string[],
  stats: Map<string, PairStat>,
  maxContext = MAX_CONTEXT_URLS,
): string[] {
  const scored: { url: string; weight: number }[] = [];
  for (const assigned of assignedUrls) {
    let best = 0;
    for (const u of newUrls) {
      const stat = stats.get(pairStatKey(assigned, u));
      if (stat) best = Math.max(best, edgeWeight(stat));
    }
    if (best > 0) scored.push({ url: assigned, weight: best });
  }
  scored.sort((x, y) => y.weight - x.weight || (x.url < y.url ? -1 : 1));
  return scored.slice(0, maxContext).map((s) => s.url);
}

/** Union-find helper for the offline fallback: groups items joined by strongly co-used pairs. */
export function groupByCoUsage<T>(
  items: T[],
  keyOf: (item: T) => string,
  stats: Map<string, PairStat>,
  minSwitches = OFFLINE_MERGE_MIN_SWITCHES,
  alwaysTogether: (a: T, b: T) => boolean = () => false,
): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const stat = stats.get(pairStatKey(keyOf(items[a]!), keyOf(items[b]!)));
      if ((stat && stat.switches >= minSwitches) || alwaysTogether(items[a]!, items[b]!)) parent[find(a)] = find(b);
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(item);
    groups.set(root, list);
  });
  return [...groups.values()];
}
