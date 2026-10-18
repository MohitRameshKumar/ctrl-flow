/**
 * Repeat-to-Macro orchestration: the impure half.
 *
 * All the rules live in `macro-detection.ts` as pure functions. This module only gathers live
 * data, calls them, and writes the result — the same split as `checkForSwitch` /
 * `detectSwitchCandidate`.
 */

import {
  MACRO_AUTORUN_GRACE_MS,
  MACRO_INPROGRESS_MIN_MATCH,
  MACRO_LOOKBACK_MS,
  MACRO_OFFER_THROTTLE_MS,
  MACRO_RECORD_WINDOW_MS,
  macroThresholds,
} from './constants';
import {
  deleteMacro,
  getMacroById,
  getMacros,
  putMacro,
  recordMacroRun,
  setMacroTrigger,
  snoozeMacro,
  updateMacroStats,
  updateMacroStatus,
} from './db';
import {
  applyCandidate,
  applyParams,
  candidateFromSession,
  detectBySequence,
  detectByTimeOfDay,
  isUsableSession,
  localDayKey,
  matchExistingMacro,
  matchInProgress,
  mintMacroKey,
  nameMacro,
  sessionize,
  unionCandidates,
} from './macro-detection';
import {
  recordOfferDismissed,
  recordOfferShown,
  recordUndo,
  shouldDemoteFromAuto,
  shouldOffer,
  shouldPromoteToAuto,
} from './macro-learning';
import { isReplayInProgress } from './macro-run-channel';
import { runFindPdf } from './find-pdf';
import { refineSegment } from './macro-repeat';
import { dominatedSuggestions, visibleSuggestions } from './macro-suggestions';
import { snoozeMs } from './macro-thresholds';
import { normalizeUrl } from './normalize';
import { chromeActionSource } from './macro-source';
import { getAutoRunEnabled, getDemoMode, getRunMode, getRunSpeed } from './settings';
import type { Macro, MacroCandidate, MacroRunResult, ObservedAction, RunMode } from './types';

export const MACRO_RECOMPUTE_ALARM = 'cadence-macro-recompute';
export const MACRO_NOTIFICATION_PREFIX = 'cadence-macro:';
export const MACRO_PALETTE_COMMAND = 'open-macro-palette';
/** Written by the shortcut handler, consumed by the side panel. */
export const MACRO_PALETTE_REQUEST_KEY = 'macroPaletteRequest';

const MACRO_OFFER_THROTTLE_KEY = 'macroOfferThrottle';

/**
 * Rebuilds the macro list from collected activity.
 *
 * Idempotent by construction: a candidate is matched to an existing macro by URL-set similarity
 * and then merged through `applyCandidate`, so re-running this never duplicates a macro and
 * never undoes a user's edits.
 */
export async function recomputeMacros(demoMode: boolean): Promise<void> {
  const { sessionGapMs, minRuns, minSequenceDays } = macroThresholds(demoMode);
  const now = Date.now();

  const actions = await chromeActionSource.getActions(now - MACRO_LOOKBACK_MS, now);
  // Cadence-side: learn from real tasks, not tab switching. `refineSegment` drops activations of
  // already-open tabs and unclicked in-page navigations and collapses redirect chains, so a session
  // of "GitHub, Claude, GitHub, Claude" (switching) is no longer a routine.
  const sessions = sessionize(actions, sessionGapMs).map(refineSegment).filter(isUsableSession);
  if (sessions.length === 0) return;

  const candidates = unionCandidates([
    ...detectByTimeOfDay(sessions, minRuns),
    ...detectBySequence(sessions, minRuns, minSequenceDays, { durationThresholds: true }),
  ]);

  const existing = await getMacros();
  const taken = new Set(existing.map((m) => m.name));

  for (const [index, candidate] of candidates.entries()) {
    const match = matchExistingMacro(existing, candidate);
    // A macro the user said "never" to must not come back on the next scan.
    if (match?.status === 'never') continue;

    const macroKey = match?.macroKey ?? mintMacroKey(candidate);
    const name = match ? match.name : nameMacro(candidate, index, taken);
    if (!match) taken.add(name);

    const next = applyCandidate(match ?? null, candidate, name, macroKey, now);
    if (next.steps.length < 2) continue;

    await putMacro(match?.id !== undefined ? { ...next, id: match.id } : next);
  }

  // Overlapping suggestions collapse to the longest one. Saved macros are never touched.
  for (const redundant of dominatedSuggestions(await getMacros())) {
    if (redundant.id !== undefined) await deleteMacro(redundant.id);
  }
}

/** "Not now": counts the dismissal and hides the suggestion for longer each time (PAT-4). */
export async function notNowSuggestion(macroId: number): Promise<void> {
  await dismissMacroOffer(macroId);
  const macro = await getMacroById(macroId);
  if (macro) await snoozeMacro(macroId, Date.now() + snoozeMs(macro.stats.offersDismissed));
}

/**
 * Turns the last 30 seconds of activity into a saved macro.
 *
 * The honest answer to having only a weekend of history, and it runs through exactly the same
 * candidate pipeline the detectors feed, so there is no second code path to keep correct.
 */
export async function recordMacroFromRecentActivity(
  /**
   * Cadence-side additions for Leader K / R / M; omitted means the last 30 seconds, unrefined.
   * `refine` cleans the raw actions (redirect chains, tab switches) before the candidate is built;
   * `reuseExisting` returns the stored macro for the same routine instead of adding a duplicate.
   */
  window?: {
    fromTs: number;
    toTs: number;
    refine?: (actions: ObservedAction[]) => ObservedAction[];
    reuseExisting?: boolean;
    /** Names a new macro from its candidate (e.g. "Open Wikipedia, NYT, GitHub"); default is `nameMacro`. */
    nameFor?: (candidate: MacroCandidate, taken: Set<string>) => string;
  },
): Promise<Macro | null> {
  const now = Date.now();
  const raw = await chromeActionSource.getActions(window?.fromTs ?? now - MACRO_RECORD_WINDOW_MS, window?.toTs ?? now);
  const candidate = candidateFromSession(window?.refine ? window.refine(raw) : raw);
  if (!candidate) return null;

  const existing = await getMacros();
  if (window?.reuseExisting) {
    const match = matchExistingMacro(existing, candidate);
    if (match) return match;
  }
  const taken = new Set(existing.map((m) => m.name));
  const name = window?.nameFor ? window.nameFor(candidate, taken) : nameMacro(candidate, existing.length, taken);

  const macro = applyCandidate(null, candidate, name, mintMacroKey(candidate), now);
  // The user asked for this one explicitly, so it does not need to be offered back to them.
  macro.status = 'accepted';

  const id = await putMacro(macro);
  return id === undefined ? macro : { ...macro, id };
}

export interface RunMacroOptions {
  /** Overrides the user's setting. Auto-runs force `silent` so an unattended trigger never
   *  snatches focus. */
  mode?: RunMode;
  params?: Record<string, string>;
  signal?: AbortSignal;
}

export async function runMacro(
  macroId: number,
  options: RunMacroOptions = {},
): Promise<MacroRunResult | null> {
  const macro = await getMacroById(macroId);
  if (!macro || macro.status === 'never') return null;

  // Cadence-side: a saved command (Find PDF) has no steps to replay. It runs its resolver on the page's
  // current selection and is never auto-run or promoted, so it skips the replay bookkeeping below.
  if (macro.command?.kind === 'find_pdf') {
    const startedAt = Date.now();
    await runFindPdf();
    return { startedAt, finishedAt: Date.now(), outcomes: [] };
  }

  const [settingMode, speed] = await Promise.all([getRunMode(), getRunSpeed()]);
  const mode = options.mode ?? settingMode;
  // Parameter values that were redacted (ids, tokens, emails) are never remembered, so they must be supplied.
  const missing = (macro.params ?? []).filter((p) => !p.lastValue && !options.params?.[p.name]?.trim());
  if (missing.length > 0) throw new Error(`Enter a value for ${missing.map((p) => `{${p.name}}`).join(', ')} first.`);
  // Substituted before execution so the engine only ever sees concrete URLs. Any parameter the
  // caller did not supply falls back to its last observed value, so a macro is always runnable.
  const resolved = applyParams(macro, options.params);
  const result = await chromeActionSource.execute(resolved, {
    mode,
    speed,
    params: options.params,
    signal: options.signal,
  });
  await recordMacroRun(macroId, result, mode);
  await maybePromoteToAuto(macroId);
  return result;
}

/* ---------------------------------------------------------------- *
 * Offers
 * ---------------------------------------------------------------- */

async function isSidePanelOpen(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.SIDE_PANEL],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function getOfferThrottle(): Promise<Map<string, number>> {
  const { [MACRO_OFFER_THROTTLE_KEY]: raw } = await chrome.storage.local.get<
    Record<string, Record<string, number>>
  >(MACRO_OFFER_THROTTLE_KEY);
  return new Map(Object.entries(raw ?? {}));
}

async function recordOffer(macroKey: string): Promise<void> {
  const map = await getOfferThrottle();
  map.set(macroKey, Date.now());
  await chrome.storage.local.set({ [MACRO_OFFER_THROTTLE_KEY]: Object.fromEntries(map) });
}

/**
 * Surfaces the strongest new suggestion. If the side panel is open the user will already see the
 * SuggestionCard, so this only fires a notification when it isn't — the same dual-surface rule
 * Spaces uses for switch offers.
 */
export async function offerTopSuggestedMacro(): Promise<void> {
  const macros = await getMacros();
  // Commands (Find PDF) have their own suggestion notification with the right buttons.
  const suggested = visibleSuggestions(macros, Date.now()).filter((m) => m.id !== undefined && !m.command);

  const macro = suggested[0];
  if (!macro?.id) return;

  const throttle = await getOfferThrottle();
  const last = throttle.get(macro.macroKey);
  if (last !== undefined && Date.now() - last < MACRO_OFFER_THROTTLE_MS) return;

  await recordOffer(macro.macroKey);
  if (await isSidePanelOpen()) return;

  const tabCount = macro.steps.filter((s) => s.kind === 'open_url').length;
  await chrome.notifications.create(`${MACRO_NOTIFICATION_PREFIX}${macro.id}`, {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: `Repeated routine: ${macro.name}`,
    message: `You've done this ${macro.occurrences} times. Save it as a macro (${tabCount} tab${
      tabCount === 1 ? '' : 's'
    })?`,
    buttons: [{ title: 'Save and run' }, { title: 'Never' }],
  });
}

export async function handleMacroNotificationButtonClicked(
  notificationId: string,
  buttonIndex: number,
): Promise<void> {
  const rest = notificationId.slice(MACRO_NOTIFICATION_PREFIX.length);

  // "finish:<id>" is the mid-flow offer; a bare id is the save-this-routine suggestion. The two
  // mean different things, so Never on one must not be read as Never on the other.
  if (rest.startsWith('finish:')) {
    const macroId = Number(rest.slice('finish:'.length));
    if (!Number.isNaN(macroId)) {
      if (buttonIndex === 0) {
        await clearPendingMacroOffer();
        await runMacro(macroId);
      } else {
        await dismissMacroOffer(macroId);
      }
    }
    await chrome.notifications.clear(notificationId);
    return;
  }

  const macroId = Number(rest);
  if (!Number.isNaN(macroId)) {
    if (buttonIndex === 0) {
      await updateMacroStatus(macroId, 'accepted');
      await runMacro(macroId, { mode: 'silent' });
    } else {
      await updateMacroStatus(macroId, 'never');
    }
  }
  await chrome.notifications.clear(notificationId);
}

/* ---------------------------------------------------------------- *
 * Live mid-flow offers
 * ---------------------------------------------------------------- */

/** Written by the background when it spots a routine in progress; read by the side panel. */
export const PENDING_MACRO_OFFER_KEY = 'pendingMacroOffer';

export interface PendingMacroOffer {
  macroId: number;
  macroName: string;
  matched: number;
  remaining: number;
  /** Set when the macro is `auto` and will fire unless the user cancels. */
  firesAt?: number;
}

export async function getPendingMacroOffer(): Promise<PendingMacroOffer | null> {
  const stored = await chrome.storage.session.get<Record<string, PendingMacroOffer | undefined>>(
    PENDING_MACRO_OFFER_KEY,
  );
  return stored[PENDING_MACRO_OFFER_KEY] ?? null;
}

export async function clearPendingMacroOffer(): Promise<void> {
  await chrome.storage.session.remove(PENDING_MACRO_OFFER_KEY);
}

/**
 * Notices that the user has started a routine they already have, and offers to finish it.
 *
 * This is the half that makes the feature feel like it is paying attention rather than waiting
 * to be asked. Thin by design: gather, call the pure matcher, surface the result.
 */
export async function checkForInProgressMacro(demoMode: boolean): Promise<void> {
  // Never offer to finish a routine while a run is already doing exactly that.
  if (await isReplayInProgress()) return;
  if (await getPendingMacroOffer()) return;

  const { sessionGapMs } = macroThresholds(demoMode);
  const now = Date.now();

  const actions = await chromeActionSource.getActions(now - sessionGapMs, now);
  if (actions.length === 0) return;

  const macros = await getMacros();
  if (macros.length === 0) return;

  const tabs = await chrome.tabs.query({});
  const openUrls = new Set<string>();
  for (const tab of tabs) {
    const normalized = tab.url ? normalizeUrl(tab.url) : null;
    if (normalized) openUrls.add(normalized.url);
  }

  const match = matchInProgress(actions, macros, {
    minMatch: MACRO_INPROGRESS_MIN_MATCH,
    openUrls,
  });
  if (!match?.macro.id) return;

  const throttle = await getOfferThrottle();
  if (!shouldOffer(match.macro.stats, throttle.get(match.macro.macroKey), now)) return;

  await recordOffer(match.macro.macroKey);
  await updateMacroStats(match.macro.id, recordOfferShown);

  const autoRunEnabled = await getAutoRunEnabled();
  const willAutoRun = autoRunEnabled && match.macro.status === 'auto';

  const offer: PendingMacroOffer = {
    macroId: match.macro.id,
    macroName: match.macro.name,
    matched: match.matched,
    remaining: match.remaining.filter((s) => s.kind === 'open_url').length,
    firesAt: willAutoRun ? now + MACRO_AUTORUN_GRACE_MS : undefined,
  };
  await chrome.storage.session.set({ [PENDING_MACRO_OFFER_KEY]: offer });

  if (willAutoRun) {
    scheduleAutoRun(offer);
    return;
  }

  // The panel renders the offer itself when open; a notification is for when it is not.
  if (await isSidePanelOpen()) return;
  await chrome.notifications.create(`${MACRO_NOTIFICATION_PREFIX}finish:${match.macro.id}`, {
    type: 'basic',
    iconUrl: '/icon/128.png',
    title: `Finish ${match.macro.name}?`,
    message: `You've done the first ${match.matched} steps. Open the remaining ${offer.remaining}?`,
    buttons: [{ title: 'Finish it' }, { title: 'Not now' }],
  });
}

/**
 * Fires an auto-run after the grace period, unless the offer was cancelled.
 *
 * Deliberately not a `chrome.alarms` timer: alarm delays are clamped to 30 seconds, which is
 * three times the countdown the user is watching.
 */
function scheduleAutoRun(offer: PendingMacroOffer): void {
  setTimeout(() => {
    void (async () => {
      const still = await getPendingMacroOffer();
      // Cancelled, or superseded by a different offer.
      if (!still || still.macroId !== offer.macroId || still.firesAt !== offer.firesAt) return;
      await clearPendingMacroOffer();
      // Auto-runs are always silent regardless of the user's setting: taking over the screen
      // from an unattended trigger is the one behavior most likely to feel hostile.
      await runMacro(offer.macroId, { mode: 'silent' });
    })();
  }, MACRO_AUTORUN_GRACE_MS);
}

/** The user cancelled a countdown. That is the strongest "no" available, so trust resets. */
export async function cancelAutoRun(macroId: number): Promise<void> {
  await clearPendingMacroOffer();
  await updateMacroStats(macroId, recordUndo);
  const macro = await getMacroById(macroId);
  if (macro && shouldDemoteFromAuto(macro.status)) {
    await updateMacroStatus(macroId, 'accepted');
  }
}

export async function dismissMacroOffer(macroId: number): Promise<void> {
  await clearPendingMacroOffer();
  await updateMacroStats(macroId, recordOfferDismissed);
}

/**
 * Fires a time-of-day macro when its hour comes around.
 *
 * Checked on the recompute alarm rather than scheduled per macro: the alarm already runs on a
 * cadence, and a one-shot alarm per macro would need rebuilding on every edit for no benefit.
 * The once-a-day guard is what keeps a 20-minute alarm from firing the same routine three times.
 */
export async function checkTimeOfDayTriggers(): Promise<void> {
  if (!(await getAutoRunEnabled())) return;
  if (await isReplayInProgress()) return;
  if (await getPendingMacroOffer()) return;

  const now = Date.now();
  const hour = new Date(now).getHours();
  const today = localDayKey(now);

  const fired = await getTriggerLog();

  for (const macro of await getMacros()) {
    if (macro.status !== 'auto' || macro.id === undefined) continue;
    if (macro.trigger?.kind !== 'time_of_day') continue;
    if (macro.trigger.hour !== hour) continue;
    if (fired.get(macro.macroKey) === today) continue;

    await recordTrigger(macro.macroKey, today);

    const offer: PendingMacroOffer = {
      macroId: macro.id,
      macroName: macro.name,
      matched: 0,
      remaining: macro.steps.filter((s) => s.enabled && s.kind === 'open_url').length,
      firesAt: now + MACRO_AUTORUN_GRACE_MS,
    };
    await chrome.storage.session.set({ [PENDING_MACRO_OFFER_KEY]: offer });

    if (!(await isSidePanelOpen())) {
      await chrome.notifications.create(`${MACRO_NOTIFICATION_PREFIX}finish:${macro.id}`, {
        type: 'basic',
        iconUrl: '/icon/128.png',
        title: `Running ${macro.name}`,
        message: `Starting in ${MACRO_AUTORUN_GRACE_MS / 1000}s. Open ctrl-flow to cancel.`,
        buttons: [{ title: 'Run now' }, { title: 'Not now' }],
      });
    }

    scheduleAutoRun(offer);
    // One automatic run at a time is plenty.
    return;
  }
}

const MACRO_TRIGGER_LOG_KEY = 'macroTriggerLog';

async function getTriggerLog(): Promise<Map<string, string>> {
  const { [MACRO_TRIGGER_LOG_KEY]: raw } = await chrome.storage.local.get<
    Record<string, Record<string, string>>
  >(MACRO_TRIGGER_LOG_KEY);
  return new Map(Object.entries(raw ?? {}));
}

async function recordTrigger(macroKey: string, day: string): Promise<void> {
  const log = await getTriggerLog();
  log.set(macroKey, day);
  await chrome.storage.local.set({ [MACRO_TRIGGER_LOG_KEY]: Object.fromEntries(log) });
}

/** Promotes a macro that has earned it. Called after each run. */
export async function maybePromoteToAuto(macroId: number): Promise<boolean> {
  const [macro, autoRunEnabled] = await Promise.all([getMacroById(macroId), getAutoRunEnabled()]);
  if (!macro) return false;
  if (!shouldPromoteToAuto(macro.status, macro.stats, autoRunEnabled)) return false;
  await updateMacroStatus(macroId, 'auto');
  await setMacroTrigger(macroId, {
    kind: macro.typicalHour === null ? 'in_progress' : 'time_of_day',
    hour: macro.typicalHour ?? undefined,
  });
  return true;
}

/* ---------------------------------------------------------------- *
 * Palette handoff
 * ---------------------------------------------------------------- */

export interface MacroPaletteRequest {
  ts: number;
}

export async function consumeMacroPaletteRequest(): Promise<MacroPaletteRequest | null> {
  const stored = await chrome.storage.session.get<Record<string, MacroPaletteRequest | undefined>>(
    MACRO_PALETTE_REQUEST_KEY,
  );
  const request = stored[MACRO_PALETTE_REQUEST_KEY];
  if (!request) return null;
  await chrome.storage.session.remove(MACRO_PALETTE_REQUEST_KEY);
  return request;
}

/** The live binding, so the UI can tell the user when another extension took the shortcut. */
export async function getPaletteShortcut(): Promise<string> {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((c) => c.name === MACRO_PALETTE_COMMAND)?.shortcut ?? '';
  } catch {
    return '';
  }
}

export type { MacroCandidate };
