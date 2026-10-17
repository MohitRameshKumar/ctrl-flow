// Focus Flip: opt-in automatic flipping between a writing tab and a reference tab.
//
// OFF by default. The side-panel toggle (storage key `focusFlipEnabled`) is the user's approval;
// while it is off nothing is learned, no activity pulses are even sent by the content script, and
// nothing flips. All state is counts and timestamps: URLs, tab ids, durations. Never keys, scroll
// positions, or page content.
//
// MV3 notes: the service worker can sleep, so durable state (tracker, flip-in-progress) lives in
// chrome.storage.session. The 2–10 s typing-pause timer is a plain setTimeout — keystroke pulses
// keep the worker alive for that long. The return timer (3–60 s) has three layers: a setTimeout, a
// keep-alive ping every 20 s while a flip is running, and a chrome.alarms backup that resumes the
// flip if the worker was killed anyway (alarms fire with 30 s granularity, so it is only a net).
import { getFlipPair, getFlipPairs, putFlipPair } from './db';
import {
  EMPTY_TRACKER,
  applyRoundTrip,
  emptyPair,
  learnedDwellMs,
  learnedPauseMs,
  onKey,
  onUserActivation,
  type RoundTrip,
  type TrackerState,
} from './flip-learning';
import { normalizeUrl } from './normalize';
import { isReplayInProgress } from './macro-run-channel';
import { markProgrammaticNav } from './programmatic';
import { getBlocklist, isBlocklisted, isPaused } from './privacy';

export const FOCUS_FLIP_KEY = 'focusFlipEnabled';
export const FLIP_RETURN_ALARM = 'cadence-flip-return';
const TRACKER_KEY = 'flipTracker';
const SENSITIVE_KEY = 'flipSensitive';
const FLIP_STATE_KEY = 'flipState';

/** Don't flip if the user switched tabs themselves this recently. */
export const RECENT_USER_SWITCH_MS = 5000;
/** Ignore reference-tab interaction right after a flip starts (page-load / scroll-restore noise). */
const INTERACTION_GRACE_MS = 700;
/** A return that is this late (worker was asleep) is dropped rather than yanking the user around. */
const STALE_RETURN_MS = 10000;
const KEEPALIVE_MS = 20000;

export interface FlipState {
  id: string;
  writingTabId: number;
  referenceTabId: number;
  startedAt: number;
  returnAt: number;
  dwellMs: number;
}

export async function isFocusFlipEnabled(): Promise<boolean> {
  const { [FOCUS_FLIP_KEY]: enabled } = await chrome.storage.local.get<Record<string, boolean | undefined>>(FOCUS_FLIP_KEY);
  return enabled === true;
}

export async function getFlipState(): Promise<FlipState | null> {
  const { [FLIP_STATE_KEY]: state } = await chrome.storage.session.get<Record<string, FlipState | undefined>>(FLIP_STATE_KEY);
  return state ?? null;
}

// ---- serialized session-state access (messages arrive concurrently) -----------------------------

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function readTracker(): Promise<TrackerState> {
  const { [TRACKER_KEY]: t } = await chrome.storage.session.get<Record<string, TrackerState | undefined>>(TRACKER_KEY);
  return t ?? EMPTY_TRACKER;
}
function writeTracker(t: TrackerState): Promise<void> {
  return chrome.storage.session.set({ [TRACKER_KEY]: t });
}
async function readSensitive(): Promise<Record<number, boolean>> {
  const { [SENSITIVE_KEY]: s } = await chrome.storage.session.get<Record<string, Record<number, boolean> | undefined>>(SENSITIVE_KEY);
  return s ?? {};
}

// ---- test seam -----------------------------------------------------------------------------------

let focusProbe: boolean | null = null;
/** Lets the e2e harness assert the "Chrome isn't focused" rule. Always null (real check) in practice. */
export function setFocusProbeForTests(focused: boolean | null): void {
  focusProbe = focused;
}
async function isChromeFocused(): Promise<boolean> {
  if (focusProbe !== null) return focusProbe;
  try {
    return (await chrome.windows.getLastFocused()).focused === true;
  } catch {
    return false;
  }
}

// ---- timers (per worker lifetime) ----------------------------------------------------------------

let checkTimer: ReturnType<typeof setTimeout> | undefined;
let returnTimer: ReturnType<typeof setTimeout> | undefined;
let keepAlive: ReturnType<typeof setInterval> | undefined;

function clearFlipTimers(): void {
  if (returnTimer) clearTimeout(returnTimer);
  if (keepAlive) clearInterval(keepAlive);
  returnTimer = undefined;
  keepAlive = undefined;
}

// ---- learning ------------------------------------------------------------------------------------

async function tabIsTrackable(url: string | undefined): Promise<string | null> {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  if (isBlocklisted(normalized.domain, await getBlocklist())) return null;
  return normalized.url;
}

async function learn(trip: RoundTrip): Promise<void> {
  const { demoMode = true } = await chrome.storage.local.get<{ demoMode?: boolean }>('demoMode');
  const blocklist = await getBlocklist();
  for (const u of [trip.writingUrl, trip.referenceUrl]) {
    const n = normalizeUrl(u);
    if (!n || isBlocklisted(n.domain, blocklist)) return;
  }
  const existing = (await getFlipPair(trip.writingUrl, trip.referenceUrl)) ?? emptyPair(trip.writingUrl, trip.referenceUrl);
  await putFlipPair(applyRoundTrip(existing, trip, demoMode));
}

/** A user-initiated tab activation (callers skip Cadence-initiated ones). Cancels a running flip. */
export async function handleUserActivation(tabId: number, rawUrl: string | undefined): Promise<void> {
  await cancelFlip();
  if (!(await isFocusFlipEnabled()) || (await isPaused())) return;
  const url = await tabIsTrackable(rawUrl);
  if (!url) {
    // A non-trackable tab breaks any writing -> reference -> writing sequence.
    await serial(async () => writeTracker({ ...(await readTracker()), trail: [] }));
    return;
  }
  const trip = await serial(async () => {
    const { state, roundTrip } = onUserActivation(await readTracker(), { tabId, url, ts: Date.now() }, true);
    await writeTracker(state);
    return roundTrip;
  });
  if (trip) await learn(trip);
}

/** Content-script pulses: keystroke / scroll / click happened (no details). */
export async function handleActivity(tabId: number, what: 'key' | 'scroll' | 'click'): Promise<void> {
  if (!(await isFocusFlipEnabled()) || (await isPaused())) return;
  // Pulses produced while a macro replays are Cadence's own clicks/typing, not the user's.
  if (await isReplayInProgress()) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const url = await tabIsTrackable(tab?.url);
  if (!tab || !url) return;
  const now = Date.now();

  const flip = await getFlipState();
  if (flip && tabId === flip.referenceTabId && now - flip.startedAt > INTERACTION_GRACE_MS) {
    // The user is reading on purpose: scrolling, clicking or typing in the reference tab.
    await cancelFlip();
    return;
  }

  if (what === 'key') {
    await serial(async () => writeTracker(onKey(await readTracker(), tabId, now, true)));
    await scheduleCheck(tabId, url, now);
  }
}

export async function handleSensitiveFocus(tabId: number, value: boolean): Promise<void> {
  if (!(await isFocusFlipEnabled())) return;
  await serial(async () => {
    const map = await readSensitive();
    if (value) map[tabId] = true;
    else delete map[tabId];
    await chrome.storage.session.set({ [SENSITIVE_KEY]: map });
  });
}

export async function handleTabRemoved(tabId: number): Promise<void> {
  const flip = await getFlipState();
  if (flip && (flip.writingTabId === tabId || flip.referenceTabId === tabId)) await cancelFlip();
  await serial(async () => {
    const map = await readSensitive();
    if (map[tabId]) {
      delete map[tabId];
      await chrome.storage.session.set({ [SENSITIVE_KEY]: map });
    }
  });
}

// ---- flipping ------------------------------------------------------------------------------------

async function scheduleCheck(tabId: number, url: string, keyTs: number): Promise<void> {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = undefined;
  const pairs = (await getFlipPairs()).filter((p) => p.active && p.writingUrl === url);
  if (pairs.length === 0) return;
  const pause = Math.min(...pairs.map(learnedPauseMs));
  checkTimer = setTimeout(() => {
    checkFlip(tabId, keyTs).catch((err) => console.error('[cadence] flip check failed', err));
  }, pause);
}

/** Starts a flip if — and only if — every safety condition holds. Returns whether it flipped. */
export async function checkFlip(writingTabId: number, keyTs: number): Promise<boolean> {
  if (!(await isFocusFlipEnabled()) || (await isPaused())) return false;
  // A macro replay drives tabs on its own: never steal focus into a reference tab mid-run.
  if (await isReplayInProgress()) return false;
  if (await getFlipState()) return false;

  const tracker = await readTracker();
  if (tracker.lastKey[writingTabId] !== keyTs) return false; // typed again since

  const lastSwitch = tracker.trail[tracker.trail.length - 1];
  if (lastSwitch && Date.now() - lastSwitch.ts < RECENT_USER_SWITCH_MS) return false;

  if (!(await isChromeFocused())) return false;

  const writing = await chrome.tabs.get(writingTabId).catch(() => undefined);
  if (!writing || writing.incognito || !writing.active) return false;
  const [activeTab] = await chrome.tabs.query({ active: true, windowId: writing.windowId });
  if (activeTab?.id !== writingTabId) return false;

  const writingUrl = await tabIsTrackable(writing.url);
  if (!writingUrl) return false;
  if ((await readSensitive())[writingTabId]) return false;

  const pairs = (await getFlipPairs())
    .filter((p) => p.active && p.writingUrl === writingUrl)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const tabs = await chrome.tabs.query({});
  for (const pair of pairs) {
    const reference = tabs
      .filter((t) => t.id !== undefined && t.id !== writingTabId && !t.incognito && normalizeUrl(t.url)?.url === pair.referenceUrl)
      .sort((a, b) => Number(b.windowId === writing.windowId) - Number(a.windowId === writing.windowId))[0];
    if (!reference?.id) continue;
    if (!(await tabIsTrackable(reference.url))) continue;
    await startFlip(writingTabId, reference.id, learnedDwellMs(pair));
    return true;
  }
  return false;
}

async function startFlip(writingTabId: number, referenceTabId: number, dwellMs: number): Promise<void> {
  if (await isReplayInProgress()) return; // last line of defence: the flip itself, not just its triggers
  const now = Date.now();
  const state: FlipState = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    writingTabId,
    referenceTabId,
    startedAt: now,
    returnAt: now + dwellMs,
    dwellMs,
  };
  await chrome.storage.session.set({ [FLIP_STATE_KEY]: state });
  try {
    await markProgrammaticNav(referenceTabId);
    await chrome.tabs.update(referenceTabId, { active: true });
  } catch {
    await chrome.storage.session.remove(FLIP_STATE_KEY);
    return;
  }
  clearFlipTimers();
  returnTimer = setTimeout(() => {
    finishFlip(state.id).catch((err) => console.error('[cadence] flip return failed', err));
  }, dwellMs);
  keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => undefined); // any extension API call resets the idle timer
  }, KEEPALIVE_MS);
  chrome.alarms.create(FLIP_RETURN_ALARM, { when: state.returnAt });
}

async function endFlipBookkeeping(): Promise<void> {
  clearFlipTimers();
  await chrome.storage.session.remove(FLIP_STATE_KEY);
  await chrome.alarms.clear(FLIP_RETURN_ALARM);
}

/** Returns to the writing tab, unless the flip was cancelled (state gone / different flip). */
export async function finishFlip(id: string): Promise<void> {
  const state = await getFlipState();
  if (!state || state.id !== id) return;
  await endFlipBookkeeping();
  if (!(await isFocusFlipEnabled()) || Date.now() - state.returnAt > STALE_RETURN_MS) return;

  const writing = await chrome.tabs.get(state.writingTabId).catch(() => undefined);
  const reference = await chrome.tabs.get(state.referenceTabId).catch(() => undefined);
  if (!writing || !reference?.active) return; // closed, or the user already moved on
  await markProgrammaticNav(state.writingTabId);
  await chrome.tabs.update(state.writingTabId, { active: true });
}

/** chrome.alarms backup (and startup check): complete a flip whose timer died with the worker. */
export async function resumeFlipIfDue(): Promise<void> {
  const state = await getFlipState();
  if (state && Date.now() >= state.returnAt) await finishFlip(state.id);
}

/** Stops a flip in progress without switching tabs. Used by "Stay here", interaction, user switches, toggle-off. */
export async function cancelFlip(): Promise<void> {
  const state = await getFlipState();
  if (!state) return;
  await endFlipBookkeeping();
}

/** Called when the toggle is turned off: stop everything and forget in-memory/session learning state. */
export async function disableFocusFlip(): Promise<void> {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = undefined;
  await cancelFlip();
  await chrome.storage.session.remove([TRACKER_KEY, SENSITIVE_KEY]);
}
