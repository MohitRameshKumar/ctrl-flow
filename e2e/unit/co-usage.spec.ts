import { expect, test } from '@playwright/test';
import {
  MAX_EDGES,
  computePairStats,
  edgesForUrls,
  groupByCoUsage,
  pairStatKey,
  pickContextUrls,
  typedCountsForUrls,
} from '../../lib/co-usage';

const A = 'https://a.test/';
const B = 'https://b.test/';
const D = 'https://doc.test/';
const X = 'https://x.test/';

function act(url: string, tsSec: number) {
  return { url, ts: tsSec * 1000 };
}

test('counts direct switches in both directions as one pair, and ignores same-tab repeats', () => {
  const stats = computePairStats([act(A, 0), act(D, 10), act(A, 20), act(A, 21), act(D, 30)]);
  // A->D, D->A, A->A (not a switch), A->D = 3 switches between A and D.
  expect(stats.get(pairStatKey(A, D))?.switches).toBe(3);
  expect(pairStatKey(A, D)).toBe(pairStatKey(D, A));
});

test('time adjacency: tabs activated within the near window count, far ones do not', () => {
  const stats = computePairStats([act(A, 0), act(B, 30), act(X, 5000)]);
  expect(stats.get(pairStatKey(A, B))?.near).toBe(1);
  expect(stats.get(pairStatKey(A, X))).toBeUndefined();
  // B -> X is consecutive but ~83 minutes apart: neither a counted switch nor "near".
  expect(stats.get(pairStatKey(B, X))).toBeUndefined();
});

test('input order does not matter', () => {
  const ordered = computePairStats([act(A, 0), act(D, 10), act(B, 20)]);
  const shuffled = computePairStats([act(B, 20), act(A, 0), act(D, 10)]);
  expect([...shuffled.entries()].sort()).toEqual([...ordered.entries()].sort());
});

test('edges use indices into the given list, strongest first, and drop weak noise', () => {
  const acts = [act(A, 0), act(D, 5), act(A, 10), act(D, 15), act(B, 20), act(D, 25), act(X, 5000)];
  const stats = computePairStats(acts);
  const edges = edgesForUrls([A, B, D, X], stats);
  // A(0)-D(2) has the most switches; X(3) has no edges at all.
  expect(edges[0]).toMatchObject({ a: 0, b: 2 });
  expect(edges.every((e) => e.a < e.b)).toBe(true);
  expect(edges.some((e) => e.a === 3 || e.b === 3)).toBe(false);
});

test('edge list is capped at MAX_EDGES, keeping the strongest', () => {
  // 40 URLs, all pairwise adjacent once (780 pairs); give pair (0,1) extra switches.
  const urls = Array.from({ length: 40 }, (_, i) => `https://t${i}.test/`);
  const acts = urls.map((u, i) => act(u, i));
  for (let k = 0; k < 5; k++) acts.push(act(urls[0]!, 100 + k * 2), act(urls[1]!, 101 + k * 2));
  const stats = computePairStats(acts);
  const edges = edgesForUrls(urls, stats);
  expect(edges.length).toBe(MAX_EDGES);
  expect(edges[0]).toMatchObject({ a: 0, b: 1 });
  expect(edgesForUrls(urls, stats, 5).length).toBe(5);
});

test('typing counts are per URL index and omit tabs with none', () => {
  const typed = typedCountsForUrls([A, D, B], new Map([[D, 8]]));
  expect(typed).toEqual([{ i: 1, bursts: 8 }]);
});

test('context picks the assigned URLs most co-used with new ones, capped', () => {
  const stats = computePairStats([act(A, 0), act(D, 5), act(A, 10), act(D, 15), act(B, 20)]);
  expect(pickContextUrls([D], [A, B, X], stats)).toEqual([A, B]);
  expect(pickContextUrls([D], [A, B, X], stats, 1)).toEqual([A]);
});

test('offline grouping merges strongly co-used tabs across domains and keeps weak ones apart', () => {
  const stats = computePairStats([
    ...[0, 1, 2, 3].flatMap((k) => [act(A, k * 40), act(D, k * 40 + 10), act(B, k * 40 + 20), act(D, k * 40 + 30)]),
    act(X, 5000),
  ]);
  const items = [{ url: A }, { url: B }, { url: D }, { url: X }];
  const groups = groupByCoUsage(items, (i) => i.url, stats);
  const sizes = groups.map((g) => g.map((i) => i.url).sort()).sort((p, q) => q.length - p.length);
  expect(sizes[0]).toEqual([A, B, D].sort());
  expect(sizes[1]).toEqual([X]);
});

test('a switch after a long gap is not co-usage', () => {
  const stats = computePairStats([act(A, 0), act(B, 60 * 60)]);
  expect(stats.get(pairStatKey(A, B))).toBeUndefined();
});
