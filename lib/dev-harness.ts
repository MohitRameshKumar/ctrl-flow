/**
 * Debug-page test harness: reaches macro states that are otherwise expensive to reach by hand.
 *
 * Auto-run promotion needs five clean runs, parameterization needs a routine repeated across
 * several days, and crash recovery needs a worker to actually die. Waiting those out by hand is
 * the difference between verifying three behaviors and verifying all of them, so the states are
 * seeded directly instead.
 *
 * This module is dev-only scaffolding. It is imported by `entrypoints/debug/` and nothing else;
 * deleting this file and the harness section of the debug page removes it entirely. The data it
 * writes is ordinary data, so everything it creates can also be undone from the normal UI.
 */

import { db, getMacroById, getMacros, putMacro, setMacroTrigger, updateMacroStats } from './db';
import { MACRO_AUTORUN_PROMOTE_RUNS, MACRO_RUN_STALE_MS } from './constants';
import {
  fixtureDomains,
  orderingMacro,
  pagesFor,
  paramRoutineEvents,
  PARAM_FIXTURE_VALUES,
  type FixturePages,
} from './dev-fixtures';
import { MACRO_RUN_STATE_KEY, MACRO_REPLAY_FLAG_KEY } from './macro-run-channel';
import { PENDING_MACRO_OFFER_KEY, recomputeMacros } from './macros';
import { updateMacroStatus } from './db';
import type { MacroRunState } from './types';

/** Marks everything this harness creates, so cleanup never guesses at the user's real data. */
const HARNESS_PREFIX = 'm:harness-';

/**
 * Set by the Playwright suite to point the fixtures at its own local server.
 *
 * Stored rather than passed because the seeding happens inside the extension, driven through the
 * debug page's buttons — the same door a human uses. Unset for a human, so the runbook keeps
 * acting on real pages.
 */
export const HARNESS_ORIGIN_KEY = 'harnessOrigin';

async function harnessPages(): Promise<FixturePages> {
  const { [HARNESS_ORIGIN_KEY]: origin } = await chrome.storage.local.get<
    Record<string, string | undefined>
  >(HARNESS_ORIGIN_KEY);
  return pagesFor(origin);
}

export interface HarnessResult {
  ok: boolean;
  message: string;
}

/**
 * Creates the interleaved open → click → open → wait_for → type macro.
 *
 * Saved as `accepted` so Run is available immediately: the point is to exercise the executor,
 * not the suggestion flow.
 */
export async function seedOrderingMacro(): Promise<HarnessResult> {
  const now = Date.now();
  const macro = orderingMacro(now, await harnessPages());

  const existing = await db.macros.where('macroKey').equals(macro.macroKey).first();
  if (existing?.id !== undefined) {
    // Reset rather than fork, so repeated presses stay idempotent and stats start clean.
    await db.macros.update(existing.id, {
      steps: macro.steps,
      status: 'accepted',
      stats: undefined,
      lastRunResult: undefined,
      lastRunAt: undefined,
      updatedAt: now,
    });
    return { ok: true, message: 'Reset "Harness — ordering check" to a clean state.' };
  }

  await putMacro(macro);
  return { ok: true, message: 'Created "Harness — ordering check" under Macros → saved.' };
}

/**
 * Seeds a per-ticket routine performed on three tickets across three days, then rescans.
 *
 * Writes real `navigated` rows rather than a finished macro, so the detector does the work and
 * what you see afterwards is genuinely what detection produces.
 */
export async function seedParamHistory(): Promise<HarnessResult> {
  const events = paramRoutineEvents(Date.now(), await harnessPages());
  await db.events.bulkAdd(events);
  // Production thresholds, deliberately: the fixture is built to clear them, so passing `true`
  // here would hide a regression in the real detection path.
  await recomputeMacros(false);

  const found = (await getMacros()).find((m) => (m.params ?? []).some((p) => p.name === 'pull'));
  if (!found) {
    return {
      ok: false,
      message: `Seeded ${events.length} events but no {pull} macro appeared — detection regressed.`,
    };
  }
  return {
    ok: true,
    message: `Seeded ${events.length} events. "${found.name}" has {pull}, seen as ${PARAM_FIXTURE_VALUES.join(', ')}.`,
  };
}

/**
 * Hands a macro the clean-run history that promotion requires, then promotes it.
 *
 * Writes a trigger of `in_progress` so doing the macro's first steps is what fires it — the
 * path that is actually worth watching, as opposed to waiting for a clock hour.
 */
export async function promoteToAuto(macroId: number): Promise<HarnessResult> {
  const macro = await getMacroById(macroId);
  if (!macro) return { ok: false, message: 'No macro with that id.' };

  await updateMacroStats(macroId, (stats) => ({
    ...stats,
    runs: stats.runs + MACRO_AUTORUN_PROMOTE_RUNS,
    successes: stats.successes + MACRO_AUTORUN_PROMOTE_RUNS,
    cleanStreak: MACRO_AUTORUN_PROMOTE_RUNS,
    undos: 0,
  }));
  await updateMacroStatus(macroId, 'auto');
  await setMacroTrigger(macroId, { kind: 'in_progress' });

  return {
    ok: true,
    message: `"${macro.name}" is now auto. Turn on "Let trusted macros run themselves" in Settings, then do its first two steps.`,
  };
}

/**
 * Plants a run whose heartbeat already expired, imitating a service worker killed mid-run.
 *
 * The next thing that touches the run channel should finalize this as `interrupted` and refuse
 * to resume it — a half-executed click sequence is not safe to repeat, so reporting the truth
 * is the correct behavior, not a limitation.
 */
export async function plantStaleRun(macroId: number): Promise<HarnessResult> {
  const macro = await getMacroById(macroId);
  if (!macro) return { ok: false, message: 'No macro with that id.' };

  const startedAt = Date.now() - MACRO_RUN_STALE_MS * 3;
  const state: MacroRunState = {
    runId: `harness-${startedAt}`,
    macroId,
    macroName: macro.name,
    mode: 'guided',
    status: 'running',
    stepIndex: 1,
    total: macro.steps.length,
    phase: 'Pretending the worker died here',
    cursorKey: macro.steps[1]?.key,
    paused: false,
    startedAt,
    heartbeatAt: startedAt,
    openedTabIds: [],
    tabIdByUrl: {},
    outcomes: [],
  };

  await chrome.storage.session.set({ [MACRO_RUN_STATE_KEY]: state });
  return {
    ok: true,
    message: 'Planted a stale run. Open the side panel — it should report an interrupted run, not resume it.',
  };
}

/** Reads back everything the run channel is holding, so a wedged state is visible. */
export async function inspectRunChannel(): Promise<Record<string, unknown>> {
  const session = await chrome.storage.session.get([
    MACRO_RUN_STATE_KEY,
    MACRO_REPLAY_FLAG_KEY,
    PENDING_MACRO_OFFER_KEY,
  ]);
  return {
    runState: session[MACRO_RUN_STATE_KEY] ?? null,
    replayInProgress: session[MACRO_REPLAY_FLAG_KEY] ?? false,
    pendingOffer: session[PENDING_MACRO_OFFER_KEY] ?? null,
  };
}

/**
 * Clears a replay flag left set by a run that died before it could unset it.
 *
 * Worth a button of its own: while that flag is set the collector records nothing and no offers
 * are made, so a stuck flag looks exactly like "the feature stopped working".
 */
export async function clearStuckReplayFlag(): Promise<HarnessResult> {
  await chrome.storage.session.remove([
    MACRO_RUN_STATE_KEY,
    MACRO_REPLAY_FLAG_KEY,
    PENDING_MACRO_OFFER_KEY,
  ]);
  return { ok: true, message: 'Cleared run state, replay flag, and any pending offer.' };
}

/** Removes only what the harness created; the user's own macros and events are left alone. */
export async function clearHarnessData(): Promise<HarnessResult> {
  const macroIds = await db.macros
    .filter((m) => m.macroKey.startsWith(HARNESS_PREFIX))
    .primaryKeys();
  if (macroIds.length > 0) await db.macros.bulkDelete(macroIds as number[]);

  // Derived from the active pages rather than a hardcoded list, so cleanup follows the fixtures
  // onto a local server instead of silently leaving every seeded row behind.
  const domains = fixtureDomains(await harnessPages());
  const eventIds = await db.events
    .filter((e) => domains.includes(e.domain ?? ''))
    .primaryKeys();
  if (eventIds.length > 0) await db.events.bulkDelete(eventIds as number[]);

  await clearStuckReplayFlag();

  return {
    ok: true,
    message: `Removed ${macroIds.length} harness macro(s) and ${eventIds.length} seeded event(s). Macros mined from the seed may remain — delete those from the Macros tab.`,
  };
}
