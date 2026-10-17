/**
 * Orchestration around the execution engine.
 *
 * The rules all live in `macro-executor.ts` and the browser contact in `macro-host-chrome.ts`.
 * This module owns the things that are neither: the single-run invariant, the run id, the
 * replay-suppression flag, and finalizing the record when a run ends.
 */

import { createChromeHost } from './macro-host-chrome';
import { executeMacro, summarizeRun } from './macro-executor';
import {
  clearRunCommand,
  isStale,
  isStopPending,
  isTerminal,
  readRunState,
  setReplayInProgress,
  takeRunCommand,
  writeRunState,
} from './macro-run-channel';
import type { Macro, MacroRunResult, MacroRunState, ReplayOptions, StepOutcome } from './types';

export { summarizeRun } from './macro-executor';

/**
 * Guards against two runs at once within a single worker lifetime.
 *
 * Checked synchronously before any `await`, which makes it race-free: the service worker is
 * single-threaded, so nothing can interleave between the check and the assignment. The stored
 * run state covers the cross-restart case that this cannot see.
 */
let activeRunId: string | null = null;

export class MacroRunBusyError extends Error {
  constructor() {
    super('A macro is already running.');
    this.name = 'MacroRunBusyError';
  }
}

function newRunId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function freshState(macro: Macro, runId: string, opts: ReplayOptions): MacroRunState {
  return {
    runId,
    macroId: macro.id ?? -1,
    macroName: macro.name,
    mode: opts.mode,
    status: 'running',
    stepIndex: 0,
    total: macro.steps.filter((s) => s.enabled).length,
    phase: 'Starting',
    paused: false,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    openedTabIds: [],
    tabIdByUrl: {},
    outcomes: [],
  };
}

/**
 * Finalizes a run left behind by a worker that was killed mid-step.
 *
 * Deliberately does not resume. A step may have half-executed and its side effects are not
 * idempotent, so re-running it could double-submit something. Reporting the truth beats guessing.
 */
export async function reconcileAbandonedRun(): Promise<MacroRunState | null> {
  const state = await readRunState();
  if (!state) return null;
  if (isTerminal(state)) return null;
  // A live run in this very worker is not abandoned.
  if (state.runId === activeRunId) return null;
  if (!isStale(state, Date.now())) return null;

  state.status = 'interrupted';
  state.paused = false;
  state.phase = 'Interrupted — Chrome stopped the run';
  state.summary = 'Run interrupted';
  await writeRunState(state);
  await clearRunCommand();
  await setReplayInProgress(false);
  return state;
}

/** True when a run is in flight right now and a new one should be refused. */
export async function isRunInFlight(): Promise<boolean> {
  if (activeRunId !== null) return true;
  const state = await readRunState();
  if (!state || isTerminal(state)) return false;
  return !isStale(state, Date.now());
}

/**
 * Runs a macro to completion.
 *
 * Returns the result so a caller in the same context can report it directly; the side panel
 * instead watches the published run state, since a run started from a notification or an
 * auto-trigger has no panel to return to.
 */
export async function replayMacro(macro: Macro, opts: ReplayOptions): Promise<MacroRunResult> {
  if (activeRunId !== null) throw new MacroRunBusyError();

  const runId = newRunId();
  activeRunId = runId;

  try {
    await reconcileAbandonedRun();
    await clearRunCommand();

    const state = freshState(macro, runId, opts);
    await writeRunState(state);
    // Suppress collection for the duration: without this the events the run generates are mined
    // as another occurrence of the macro that generated them.
    await setReplayInProgress(true);

    const host = createChromeHost({
      nextCommand: () => takeRunCommand(runId),
      stopPending: () => isStopPending(runId),
    });
    const result = await executeMacro(macro, host, state, {
      mode: opts.mode,
      speed: opts.speed,
      signal: opts.signal,
    });

    state.summary = summarizeRun(macro, result);
    state.heartbeatAt = Date.now();
    await writeRunState(state);
    return result;
  } finally {
    activeRunId = null;
    await setReplayInProgress(false);
    await clearRunCommand();
  }
}

/** Convenience for the UI: did anything actually go wrong? */
export function runHadFailure(result: MacroRunResult): boolean {
  return result.outcomes.some((o: StepOutcome) => o.status === 'failed');
}
