// Focus Flip: opt-in, continuous flipping between a writing tab and a reference tab.
//
// OFF by default. The side-panel toggle (storage key `focusFlipEnabled`) is the user's approval; while
// it is off nothing is learned, the content script sends nothing, and nothing flips. All state is
// counts, timestamps and URLs: never keys, scroll positions, or page content.
//
// Idle is measured in the page (see createFocusFlipPulses in entrypoints/content.ts), from the real
// last event, and arrives here as `activity_idle`. This file only decides (flip-cycle.ts) and acts;
// it holds no timers, so a sleeping service worker costs nothing: the idle message wakes it.
import { getFlipPair, getFlipPairs, putFlipPair } from './db';
import { EMPTY_TRACKER, applyRoundTrip, emptyPair, onKey, onUserActivation, type RoundTrip, type TrackerState } from './flip-learning';
import { decideFlip, type CycleTab, type FlipDecision, type IdleKind } from './flip-cycle';
import { normalizeUrl } from './normalize';
import { isReplayInProgress } from './macro-run-channel';
import { markProgrammaticNav } from './programmatic';
import { getBlocklist, isBlocklisted, isPaused } from './privacy';

export const FOCUS_FLIP_KEY = 'focusFlipEnabled';
/** Alarm used by the old return-timer model; cleared on startup in case an install still has one. */
export const LEGACY_FLIP_RETURN_ALARM = 'cadence-flip-return';
const TRACKER_KEY = 'flipTracker';
const SENSITIVE_KEY = 'flipSensitive';

export async function isFocusFlipEnabled(): Promise<boolean> {
  const { [FOCUS_FLIP_KEY]: enabled } = await chrome.storage.local.get<Record<string, boolean | undefined>>(FOCUS_FLIP_KEY);
  return enabled === true;
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
/** Chrome has focus *and* the tab's own window is the focused one. */
async function isChromeFocusedOn(windowId: number | undefined): Promise<boolean> {
  if (focusProbe !== null) return focusProbe;
  try {
    const win = await chrome.windows.getLastFocused();
    return win.focused === true && (windowId === undefined || win.id === windowId);
  } catch {
    return false;
  }
}

// ---- learning (pairs) ----------------------------------------------------------------------------

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

/** A user-initiated tab activation (callers skip ctrl-flow-initiated ones, so a flip never teaches itself). */
export async function handleUserActivation(tabId: number, rawUrl: string | undefined): Promise<void> {
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

/** Start of a burst of typing / scrolling / clicking in a tab (no details). Feeds pair learning only. */
export async function handleActivity(tabId: number, what: IdleKind, ts: number): Promise<void> {
  if (!(await isFocusFlipEnabled()) || (await isPaused())) return;
  if (await isReplayInProgress()) return; // ctrl-flow's own clicks / typing during a replay
  if (what === 'key') await serial(async () => writeTracker(onKey(await readTracker(), tabId, ts, true)));
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
  await serial(async () => {
    const map = await readSensitive();
    if (map[tabId]) {
      delete map[tabId];
      await chrome.storage.session.set({ [SENSITIVE_KEY]: map });
    }
  });
}

// ---- the cycle -----------------------------------------------------------------------------------

async function flippableTabs(): Promise<CycleTab[]> {
  const out: CycleTab[] = [];
  for (const t of await chrome.tabs.query({})) {
    if (t.id === undefined || t.incognito) continue;
    const url = await tabIsTrackable(t.url);
    if (url) out.push({ id: t.id, url, windowId: t.windowId, active: t.active });
  }
  return out;
}

/**
 * The page reports that typing (writing tab) or scrolling / clicking (reference tab) has stopped for
 * the configured delay. Flips to the paired tab if every rule in `decideFlip` allows it.
 */
export async function handleIdle(tabId: number, what: IdleKind): Promise<FlipDecision> {
  const [enabled, appPaused, replaying, tab] = await Promise.all([
    isFocusFlipEnabled(),
    isPaused(),
    isReplayInProgress(),
    chrome.tabs.get(tabId).catch(() => undefined),
  ]);
  if (!enabled) return { flip: false, reason: 'off' };
  const url = tab && !tab.incognito ? await tabIsTrackable(tab.url) : null;
  if (!tab || !url) return { flip: false, reason: 'no-pair' };

  const decision = decideFlip({
    enabled,
    appPaused,
    replaying,
    chromeFocused: await isChromeFocusedOn(tab.windowId),
    sensitiveTabIds: Object.keys(await readSensitive()).map(Number),
    tab: { id: tabId, url, windowId: tab.windowId, active: tab.active },
    kind: what,
    pairs: await getFlipPairs(),
    openTabs: await flippableTabs(),
  });
  if (decision.flip) await performFlip(decision.toTabId, tab.windowId);
  return decision;
}

/** Switches tabs as a ctrl-flow action: marked, so it never feeds Spaces, co-usage, the switch offer, macros or learning. */
async function performFlip(toTabId: number, fromWindowId: number | undefined): Promise<void> {
  try {
    await markProgrammaticNav(toTabId);
    const target = await chrome.tabs.update(toTabId, { active: true });
    if (target?.windowId !== undefined && target.windowId !== fromWindowId) {
      await chrome.windows.update(target.windowId, { focused: true });
    }
  } catch {
    /* the tab closed between the decision and the switch */
  }
}

// ---- manual pairing ------------------------------------------------------------------------------

/** "Pair current tab with…": makes (writing, reference) an active pair immediately, no learning needed. */
export async function pairTabs(writingTabId: number, referenceTabId: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [writing, reference] = await Promise.all([chrome.tabs.get(writingTabId).catch(() => undefined), chrome.tabs.get(referenceTabId).catch(() => undefined)]);
  const writingUrl = await tabIsTrackable(writing?.url);
  const referenceUrl = await tabIsTrackable(reference?.url);
  if (!writingUrl || !referenceUrl) return { ok: false, reason: 'Both tabs must be ordinary web pages that are not on your excluded sites.' };
  if (writingUrl === referenceUrl) return { ok: false, reason: 'Pick a different page.' };
  const existing = (await getFlipPair(writingUrl, referenceUrl)) ?? emptyPair(writingUrl, referenceUrl);
  await putFlipPair({ ...existing, active: true, manual: true, updatedAt: Date.now() });
  return { ok: true };
}

/** Called when the toggle is turned off: forget session learning state. The pages stop sending on their own. */
export async function disableFocusFlip(): Promise<void> {
  await chrome.storage.session.remove([TRACKER_KEY, SENSITIVE_KEY]);
}
