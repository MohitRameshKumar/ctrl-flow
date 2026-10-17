// Focus Flip's pair learning. Pure functions only (no chrome.* / Dexie) so every rule is directly
// unit-testable. Inputs are tab ids, normalized URLs and timestamps — never key values, scroll
// positions, or page content. Nothing is learned unless `enabled` is true.
import type { FlipPair } from './types';

export const ROUND_TRIP_WINDOW_MS = 15 * 60 * 1000;
export const ROUND_TRIPS_REQUIRED = 3;
export const ROUND_TRIPS_REQUIRED_DEMO = 2;
export const DWELL_MIN_MS = 3000;
export const DWELL_MAX_MS = 60000;
export const PAUSE_MIN_MS = 2000;
export const PAUSE_MAX_MS = 10000;
export const PAUSE_DEFAULT_MS = 4000;
export const SAMPLE_COUNT = 5;
/** Reference visits shorter than this are tab-flicking, not reading. */
export const MIN_VISIT_MS = 1000;
const MAX_ROUND_TRIP_TS = 10;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median of the last SAMPLE_COUNT reference visits, clamped to 3–60 s. */
export function learnedDwellMs(pair: Pick<FlipPair, 'dwellSamples'>): number {
  const m = median(pair.dwellSamples.slice(-SAMPLE_COUNT));
  return Number.isNaN(m) ? DWELL_MIN_MS : clamp(Math.round(m), DWELL_MIN_MS, DWELL_MAX_MS);
}

/** Median of the user's typical pause before switching away, clamped to 2–10 s (default 4 s). */
export function learnedPauseMs(pair: Pick<FlipPair, 'pauseSamples'>): number {
  const m = median(pair.pauseSamples.slice(-SAMPLE_COUNT));
  return Number.isNaN(m) ? PAUSE_DEFAULT_MS : clamp(Math.round(m), PAUSE_MIN_MS, PAUSE_MAX_MS);
}

export interface RoundTrip {
  writingUrl: string;
  referenceUrl: string;
  /** When the user came back to the writing tab. */
  ts: number;
  dwellMs: number;
  pauseMs: number;
}

/** A user-initiated tab activation, plus what the user did on the tab they just left. */
export interface TrailEntry {
  tabId: number;
  url: string;
  ts: number;
  /** The previous tab had keystrokes during its visit. */
  leftTypedPrev: boolean;
  /** ms between the previous tab's last keystroke and this switch (null if it had none). */
  pauseMs: number | null;
}

export interface TrackerState {
  trail: TrailEntry[];
  /** Last keystroke timestamp per tab. */
  lastKey: Record<number, number>;
}

export const EMPTY_TRACKER: TrackerState = { trail: [], lastKey: {} };

export function onKey(state: TrackerState, tabId: number, ts: number, enabled: boolean): TrackerState {
  if (!enabled) return state;
  return { ...state, lastKey: { ...state.lastKey, [tabId]: ts } };
}

/** Records a USER-initiated activation (callers must not pass Cadence-initiated ones) and detects a finished round trip. */
export function onUserActivation(
  state: TrackerState,
  activation: { tabId: number; url: string; ts: number },
  enabled: boolean,
): { state: TrackerState; roundTrip: RoundTrip | null } {
  if (!enabled) return { state, roundTrip: null };

  const prev = state.trail[state.trail.length - 1];
  const lastKeyPrev = prev ? state.lastKey[prev.tabId] : undefined;
  const typed = prev !== undefined && lastKeyPrev !== undefined && lastKeyPrev >= prev.ts;
  const entry: TrailEntry = {
    ...activation,
    leftTypedPrev: typed,
    pauseMs: typed && lastKeyPrev !== undefined ? Math.max(0, activation.ts - lastKeyPrev) : null,
  };
  const trail = [...state.trail, entry].slice(-3);
  return { state: { ...state, trail }, roundTrip: detectRoundTrip(trail) };
}

/** [writing, reference, writing] where the user typed in the writing tab before leaving it. */
export function detectRoundTrip(trail: TrailEntry[]): RoundTrip | null {
  if (trail.length < 3) return null;
  const [w1, r, w2] = trail.slice(-3) as [TrailEntry, TrailEntry, TrailEntry];
  if (w1.tabId !== w2.tabId || w1.url !== w2.url || r.tabId === w1.tabId || r.url === w1.url) return null;
  if (!r.leftTypedPrev || r.pauseMs === null) return null;
  const dwellMs = w2.ts - r.ts;
  if (dwellMs < MIN_VISIT_MS) return null;
  return { writingUrl: w1.url, referenceUrl: r.url, ts: w2.ts, dwellMs, pauseMs: r.pauseMs };
}

export function emptyPair(writingUrl: string, referenceUrl: string): FlipPair {
  return { writingUrl, referenceUrl, roundTripTs: [], dwellSamples: [], pauseSamples: [], active: false, updatedAt: 0 };
}

/**
 * Folds one round trip into a pair. A pair becomes active once enough round trips fall inside the
 * 15-minute window (3 normally, 2 in demo mode) and stays active until the user removes it.
 */
export function applyRoundTrip(pair: FlipPair, trip: RoundTrip, demoMode: boolean): FlipPair {
  const roundTripTs = [...pair.roundTripTs, trip.ts].slice(-MAX_ROUND_TRIP_TS);
  const required = demoMode ? ROUND_TRIPS_REQUIRED_DEMO : ROUND_TRIPS_REQUIRED;
  const recent = roundTripTs.filter((t) => trip.ts - t <= ROUND_TRIP_WINDOW_MS).length;
  return {
    ...pair,
    roundTripTs,
    dwellSamples: [...pair.dwellSamples, trip.dwellMs].slice(-SAMPLE_COUNT),
    pauseSamples: [...pair.pauseSamples, trip.pauseMs].slice(-SAMPLE_COUNT),
    active: pair.active || recent >= required,
    updatedAt: trip.ts,
  };
}
