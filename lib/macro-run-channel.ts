/**
 * Cross-context channel for the one macro run that may be in flight.
 *
 * Everything lives in `chrome.storage.session`, which is this codebase's established idiom for
 * worker <-> side panel handoff (`pendingSwitchSuggestion`, `macroPaletteRequest`). It is also
 * the only option that satisfies all three needs at once: a write wakes a sleeping service
 * worker, the value persists until read so nothing is lost to a race, and the browser clears it
 * on restart so a crashed run cannot haunt the next session.
 *
 * A `runtime.Port` was the obvious alternative and is the wrong tool — it dies with the side
 * panel, and an auto-run has no panel to begin with.
 */

import { MACRO_RUN_STALE_MS } from './constants';
import type { MacroRunCommand, MacroRunState, RunCommandName } from './types';

export const MACRO_RUN_STATE_KEY = 'macroRun';
export const MACRO_RUN_COMMAND_KEY = 'macroRunCommand';

/**
 * Set for the duration of a run so the collector ignores the traffic the run itself creates.
 *
 * Without this, replaying a macro writes `tab_activated` / `navigated` events that the next
 * `recomputeMacros` counts as another occurrence of that same macro — running a macro would make
 * Cadence more confident in it, forever.
 */
export const MACRO_REPLAY_FLAG_KEY = 'macroReplayInProgress';

async function readSession<T>(key: string): Promise<T | null> {
  try {
    const stored = await chrome.storage.session.get<Record<string, T | undefined>>(key);
    return stored[key] ?? null;
  } catch {
    return null;
  }
}

async function writeSession(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch {
    // Session storage is unavailable in a few contexts; progress reporting is best-effort.
  }
}

async function removeSession(key: string): Promise<void> {
  try {
    await chrome.storage.session.remove(key);
  } catch {
    /* best-effort */
  }
}

/* ---------------------------------------------------------------- *
 * Run state
 * ---------------------------------------------------------------- */

export function readRunState(): Promise<MacroRunState | null> {
  return readSession<MacroRunState>(MACRO_RUN_STATE_KEY);
}

export function writeRunState(state: MacroRunState): Promise<void> {
  return writeSession(MACRO_RUN_STATE_KEY, state);
}

export function clearRunState(): Promise<void> {
  return removeSession(MACRO_RUN_STATE_KEY);
}

/** A run is finished when it will never advance again. */
export function isTerminal(state: MacroRunState): boolean {
  return (
    state.status === 'done' || state.status === 'stopped' || state.status === 'interrupted'
  );
}

/**
 * True when a non-terminal run has stopped beating, which means its worker was killed.
 *
 * Pure so the reaping rule is testable without Chrome.
 */
export function isStale(state: MacroRunState, now: number): boolean {
  if (isTerminal(state)) return false;
  return now - state.heartbeatAt > MACRO_RUN_STALE_MS;
}

/* ---------------------------------------------------------------- *
 * Commands
 * ---------------------------------------------------------------- */

export async function sendRunCommand(runId: string, command: RunCommandName): Promise<void> {
  await writeSession(MACRO_RUN_COMMAND_KEY, {
    runId,
    command,
    ts: Date.now(),
  } satisfies MacroRunCommand);
}

/**
 * Reads and consumes the pending command, if it belongs to this run.
 *
 * Consume-on-read is intentional: the single key means a rapid pause-then-resume collapses to
 * `resume`, which is the correct end state anyway.
 */
export async function takeRunCommand(runId: string): Promise<RunCommandName | null> {
  const pending = await readSession<MacroRunCommand>(MACRO_RUN_COMMAND_KEY);
  if (!pending) return null;
  await removeSession(MACRO_RUN_COMMAND_KEY);
  // A command aimed at a previous run must not steer this one.
  if (pending.runId !== runId) return null;
  return pending.command;
}

export function clearRunCommand(): Promise<void> {
  return removeSession(MACRO_RUN_COMMAND_KEY);
}

/* ---------------------------------------------------------------- *
 * Replay suppression
 * ---------------------------------------------------------------- */

export async function setReplayInProgress(active: boolean): Promise<void> {
  if (active) await writeSession(MACRO_REPLAY_FLAG_KEY, true);
  else await removeSession(MACRO_REPLAY_FLAG_KEY);
}

export async function isReplayInProgress(): Promise<boolean> {
  return (await readSession<boolean>(MACRO_REPLAY_FLAG_KEY)) === true;
}
