import { getEventsByKind, getLastEventOfKindBefore, getSpaceUrls } from './db';
import { normalizeUrl } from './normalize';

const SWITCH_THROTTLE_KEY = 'switchThrottle';
const SWITCH_NEVER_KEY = 'switchNeverSpaceIds';

export const SWITCH_WINDOW_MS = 5 * 60 * 1000;
export const SWITCH_THROTTLE_MS = 10 * 60 * 1000;
export const SWITCH_THRESHOLD_MS = 3 * 60 * 1000;
export const SWITCH_THRESHOLD_MS_DEMO = 30 * 1000;

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export interface Activation {
  url: string;
  ts: number;
}

/**
 * Moments Chrome lost focus entirely, which end whatever segment was running.
 *
 * Without these, alt-tabbing to Slack for an hour kept crediting that whole hour to the last tab
 * you happened to be looking at — the events were already being recorded, nothing read them.
 */
export interface FocusBreak {
  ts: number;
}

/** ms spent on each space within the trailing window, from consecutive activation gaps. Pure — no chrome.* calls. */
export function computeDwellBySpace(
  activations: Activation[],
  urlToSpace: Map<string, number>,
  now: number,
  windowMs: number,
  focusBreaks: FocusBreak[] = [],
): Map<number, number> {
  const dwell = new Map<number, number>();
  const windowStart = now - windowMs;
  const breaks = focusBreaks.map((b) => b.ts).sort((a, b) => a - b);

  for (let i = 0; i < activations.length; i++) {
    const cur = activations[i];
    if (!cur) continue;
    const spaceId = urlToSpace.get(cur.url);
    if (spaceId === undefined) continue;

    const next = activations[i + 1];
    // A segment ends at whichever comes first: the next activation, Chrome losing focus, or now.
    const nextBreak = breaks.find((ts) => ts > cur.ts);
    const boundaries = [next ? next.ts : now, nextBreak ?? now, now];
    const segEnd = Math.min(...boundaries);
    const segStart = Math.max(cur.ts, windowStart);
    if (segEnd <= segStart) continue;

    dwell.set(spaceId, (dwell.get(spaceId) ?? 0) + (segEnd - segStart));
  }

  return dwell;
}

export interface SwitchDetectionInput {
  dwellBySpace: Map<number, number>;
  /** Space of the currently active tab, or null if it isn't tracked in any space. */
  currentSpaceId: number | null;
  /** Spaces that currently have at least one open tab. */
  openTabSpaceIds: Set<number>;
  thresholdMs: number;
  lastOfferAt: Map<string, number>;
  neverSpaceIds: Set<number>;
  throttleMs: number;
  now: number;
}

export interface SwitchCandidate {
  fromSpaceId: number;
  toSpaceId: number;
}

/** Pure decision function — no chrome.* or Dexie calls, directly unit-testable. */
export function detectSwitchCandidate(input: SwitchDetectionInput): SwitchCandidate | null {
  const { dwellBySpace, currentSpaceId, openTabSpaceIds, thresholdMs, lastOfferAt, neverSpaceIds, throttleMs, now } =
    input;

  if (currentSpaceId === null || neverSpaceIds.has(currentSpaceId)) return null;
  if ((dwellBySpace.get(currentSpaceId) ?? 0) < thresholdMs) return null;

  for (const fromSpaceId of openTabSpaceIds) {
    if (fromSpaceId === currentSpaceId || neverSpaceIds.has(fromSpaceId)) continue;
    const last = lastOfferAt.get(pairKey(fromSpaceId, currentSpaceId));
    if (last !== undefined && now - last < throttleMs) continue;
    return { fromSpaceId, toSpaceId: currentSpaceId };
  }

  return null;
}

async function getThrottleMap(): Promise<Map<string, number>> {
  const { [SWITCH_THROTTLE_KEY]: raw } = await chrome.storage.local.get<Record<string, Record<string, number>>>(
    SWITCH_THROTTLE_KEY,
  );
  return new Map(Object.entries(raw ?? {}));
}

async function getNeverSpaceIds(): Promise<Set<number>> {
  const { [SWITCH_NEVER_KEY]: raw } = await chrome.storage.local.get<Record<string, number[]>>(SWITCH_NEVER_KEY);
  return new Set(raw ?? []);
}

export async function recordSwitchOffer(candidate: SwitchCandidate): Promise<void> {
  const map = await getThrottleMap();
  map.set(pairKey(candidate.fromSpaceId, candidate.toSpaceId), Date.now());
  await chrome.storage.local.set({ [SWITCH_THROTTLE_KEY]: Object.fromEntries(map) });
}

export async function neverSwitchForSpace(spaceId: number): Promise<void> {
  const set = await getNeverSpaceIds();
  set.add(spaceId);
  await chrome.storage.local.set({ [SWITCH_NEVER_KEY]: [...set] });
}

/** Gathers live chrome.* and Dexie data and runs the pure decision function. */
export async function checkForSwitch(demoMode: boolean): Promise<SwitchCandidate | null> {
  const now = Date.now();
  const thresholdMs = demoMode ? SWITCH_THRESHOLD_MS_DEMO : SWITCH_THRESHOLD_MS;

  const spaceUrls = await getSpaceUrls();
  const urlToSpace = new Map(spaceUrls.map((u) => [u.url, u.spaceId]));

  const windowStart = now - SWITCH_WINDOW_MS;
  const inWindow = await getEventsByKind('tab_activated', windowStart, now);
  // The activation that began a stay already in progress may predate the window (e.g. 8 minutes of
  // typing in one doc). Include it so that stay counts; computeDwellBySpace clamps it to the window.
  const prior = await getLastEventOfKindBefore('tab_activated', windowStart);
  const events = (prior ? [prior, ...inWindow] : inWindow).filter((e) => !e.programmatic);
  const activations: Activation[] = events
    .filter((e): e is typeof e & { url: string } => !!e.url)
    .map((e) => ({ url: e.url, ts: e.ts }))
    .sort((a, b) => a.ts - b.ts);

  const focusLost = await getEventsByKind('chrome_focus_lost', now - SWITCH_WINDOW_MS, now);
  const dwellBySpace = computeDwellBySpace(
    activations,
    urlToSpace,
    now,
    SWITCH_WINDOW_MS,
    focusLost.map((e) => ({ ts: e.ts })),
  );

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const currentNormalized = activeTab?.url ? normalizeUrl(activeTab.url) : null;
  const currentSpaceId = currentNormalized ? urlToSpace.get(currentNormalized.url) ?? null : null;

  const tabs = await chrome.tabs.query({});
  const openTabSpaceIds = new Set<number>();
  for (const tab of tabs) {
    if (!tab.url) continue;
    const normalized = normalizeUrl(tab.url);
    const spaceId = normalized ? urlToSpace.get(normalized.url) : undefined;
    if (spaceId !== undefined) openTabSpaceIds.add(spaceId);
  }

  const [lastOfferAt, neverSpaceIds] = await Promise.all([getThrottleMap(), getNeverSpaceIds()]);

  return detectSwitchCandidate({
    dwellBySpace,
    currentSpaceId,
    openTabSpaceIds,
    thresholdMs,
    lastOfferAt,
    neverSpaceIds,
    throttleMs: SWITCH_THROTTLE_MS,
    now,
  });
}
