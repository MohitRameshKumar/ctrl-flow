import { expect, test } from '@playwright/test';
import {
  DWELL_MAX_MS,
  DWELL_MIN_MS,
  EMPTY_TRACKER,
  PAUSE_DEFAULT_MS,
  PAUSE_MAX_MS,
  PAUSE_MIN_MS,
  applyRoundTrip,
  clamp,
  emptyPair,
  learnedDwellMs,
  learnedPauseMs,
  median,
  onKey,
  onUserActivation,
  type RoundTrip,
  type TrackerState,
} from '../../lib/flip-learning';

const W = { tabId: 1, url: 'https://docs.test/doc' };
const R = { tabId: 2, url: 'https://news.test/article' };

/** Plays one writing -> reference -> writing trip: types in W, leaves after `pauseMs`, reads R for `dwellMs`. */
function playTrip(
  start: TrackerState,
  t0: number,
  { pauseMs = 4000, dwellMs = 10000, typed = true, enabled = true } = {},
): { state: TrackerState; trip: RoundTrip | null; end: number } {
  let state = start;
  let trip: RoundTrip | null = null;
  const step = (a: { tabId: number; url: string; ts: number }) => {
    const r = onUserActivation(state, a, enabled);
    state = r.state;
    if (r.roundTrip) trip = r.roundTrip;
  };
  step({ ...W, ts: t0 });
  if (typed) state = onKey(state, W.tabId, t0 + 2000, enabled);
  const leave = t0 + 2000 + pauseMs;
  step({ ...R, ts: leave });
  step({ ...W, ts: leave + dwellMs });
  return { state, trip, end: leave + dwellMs };
}

test('detects a round trip and measures dwell and the pause before leaving', () => {
  const { trip } = playTrip(EMPTY_TRACKER, 0, { pauseMs: 5000, dwellMs: 12000 });
  expect(trip).toMatchObject({ writingUrl: W.url, referenceUrl: R.url, dwellMs: 12000, pauseMs: 5000 });
});

test('no round trip unless the user typed in the writing tab before leaving it', () => {
  expect(playTrip(EMPTY_TRACKER, 0, { typed: false }).trip).toBeNull();
});

test('no round trip for A -> B -> C, or when the reference visit was just a flick', () => {
  let s = EMPTY_TRACKER;
  s = onUserActivation(s, { ...W, ts: 0 }, true).state;
  s = onKey(s, W.tabId, 1000, true);
  s = onUserActivation(s, { ...R, ts: 5000 }, true).state;
  const third = onUserActivation(s, { tabId: 3, url: 'https://other.test/', ts: 9000 }, true);
  expect(third.roundTrip).toBeNull();
  expect(playTrip(EMPTY_TRACKER, 0, { dwellMs: 400 }).trip).toBeNull();
});

test('toggle off: nothing is learned and no state is recorded', () => {
  const r = playTrip(EMPTY_TRACKER, 0, { enabled: false });
  expect(r.trip).toBeNull();
  expect(r.state).toEqual(EMPTY_TRACKER);
});

test('a pair activates after 3 round trips within 15 minutes (2 in demo mode)', () => {
  const trips: RoundTrip[] = [];
  let state = EMPTY_TRACKER;
  let t = 0;
  for (let i = 0; i < 3; i++) {
    const r = playTrip(state, t);
    state = r.state;
    trips.push(r.trip!);
    t = r.end + 1000;
  }
  const afterTwo = trips.slice(0, 2).reduce((p, trip) => applyRoundTrip(p, trip, false), emptyPair(W.url, R.url));
  expect(afterTwo.active).toBe(false);
  expect(applyRoundTrip(afterTwo, trips[2]!, false).active).toBe(true);

  const demoTwo = trips.slice(0, 2).reduce((p, trip) => applyRoundTrip(p, trip, true), emptyPair(W.url, R.url));
  expect(demoTwo.active).toBe(true);
  const demoOne = applyRoundTrip(emptyPair(W.url, R.url), trips[0]!, true);
  expect(demoOne.active).toBe(false);
});

test('round trips more than 15 minutes apart do not add up', () => {
  const mk = (ts: number): RoundTrip => ({ writingUrl: W.url, referenceUrl: R.url, ts, dwellMs: 8000, pauseMs: 4000 });
  let pair = emptyPair(W.url, R.url);
  pair = applyRoundTrip(pair, mk(0), false);
  pair = applyRoundTrip(pair, mk(10 * 60000), false);
  pair = applyRoundTrip(pair, mk(20 * 60000), false); // first one has aged out: only 2 within 15 min
  expect(pair.active).toBe(false);
});

test('an active pair stays active', () => {
  const mk = (ts: number): RoundTrip => ({ writingUrl: W.url, referenceUrl: R.url, ts, dwellMs: 8000, pauseMs: 4000 });
  let pair = emptyPair(W.url, R.url);
  for (const ts of [0, 1000, 2000]) pair = applyRoundTrip(pair, mk(ts), false);
  expect(pair.active).toBe(true);
  expect(applyRoundTrip(pair, mk(60 * 60000), false).active).toBe(true);
});

test('dwell is the median of the last 5 visits, clamped to 3–60 s', () => {
  expect(median([5, 1, 3])).toBe(3);
  expect(median([1, 2, 3, 4])).toBe(2.5);
  const pair = (samples: number[]) => ({ dwellSamples: samples });
  // Only the last 5 count: the leading 60000 is ignored.
  expect(learnedDwellMs(pair([60000, 8000, 9000, 10000, 11000, 12000]))).toBe(10000);
  expect(learnedDwellMs(pair([200, 300, 400]))).toBe(DWELL_MIN_MS);
  expect(learnedDwellMs(pair([120000, 150000, 90000]))).toBe(DWELL_MAX_MS);
  expect(learnedDwellMs(pair([]))).toBe(DWELL_MIN_MS);
  // Median, not mean: one long outlier doesn't drag it.
  expect(learnedDwellMs(pair([8000, 8000, 8000, 8000, 59000]))).toBe(8000);
});

test('pause is the median typical pause, clamped to 2–10 s, defaulting to 4 s', () => {
  const pair = (samples: number[]) => ({ pauseSamples: samples });
  expect(learnedPauseMs(pair([]))).toBe(PAUSE_DEFAULT_MS);
  expect(learnedPauseMs(pair([300, 500]))).toBe(PAUSE_MIN_MS);
  expect(learnedPauseMs(pair([30000, 45000]))).toBe(PAUSE_MAX_MS);
  expect(learnedPauseMs(pair([3000, 6000, 5000]))).toBe(5000);
});

test('stored samples are capped to the last 5 and contain only numbers and urls', () => {
  let pair = emptyPair(W.url, R.url);
  for (let i = 0; i < 8; i++) {
    pair = applyRoundTrip(pair, { writingUrl: W.url, referenceUrl: R.url, ts: i * 1000, dwellMs: 5000 + i, pauseMs: 3000 }, true);
  }
  expect(pair.dwellSamples).toHaveLength(5);
  expect(pair.dwellSamples).toEqual([5003, 5004, 5005, 5006, 5007]);
  for (const v of Object.values(pair)) expect(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v)).toBe(true);
  expect(clamp(5, 1, 3)).toBe(3);
});
