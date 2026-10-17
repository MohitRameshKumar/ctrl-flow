// Leader-key actions for Repeat-to-Macro. Everything here is a thin caller over the teammate's own
// functions (`runMacro`, `recordMacroFromRecentActivity`, the run channel); no detection or replay
// logic lives in this file.
import { getMacros, putMacro } from './db';
import { applyCandidate, matchExistingMacro, mintMacroKey, nameMacro } from './macro-detection';
import { SEGMENT_MAX_AGE_MS, lastCompletedSegment, planRepeat } from './macro-repeat';
import { chromeActionSource } from './macro-source';
import {
  MACRO_NOTIFICATION_PREFIX,
  recordMacroFromRecentActivity,
  runMacro,
} from './macros';
import { isTerminal, readRunState, sendRunCommand } from './macro-run-channel';

const MARK_START_KEY = 'macroMarkStart';
/** A forgotten mark (M pressed once, never again) expires rather than swallowing hours of history. */
const MARK_MAX_AGE_MS = 10 * 60 * 1000;

/** Feedback for a leader action. Button-less, so the shared router never has anything to route. */
async function tell(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create(`${MACRO_NOTIFICATION_PREFIX}info:${Date.now()}`, {
      type: 'basic',
      iconUrl: '/icon/128.png',
      title,
      message,
    });
  } catch (err) {
    console.warn('[cadence] macro leader notification failed', err);
  }
}

/**
 * R: repeat the last action. Builds (or finds) the macro for the most recent completed segment of
 * activity and runs it; with nothing recent enough, falls back to the last-run macro and says so.
 */
export async function repeatLastMacro(): Promise<void> {
  const now = Date.now();
  const [actions, macros] = await Promise.all([
    chromeActionSource.getActions(now - SEGMENT_MAX_AGE_MS, now),
    getMacros(),
  ]);
  const plan = planRepeat(lastCompletedSegment(actions, now), macros);

  try {
    if (plan.via === 'none') {
      await tell('Nothing to repeat yet', 'No recent action, and no macro has run. Press K to keep what you do as a macro.');
      return;
    }
    if (plan.via === 'last-macro') {
      await tell('No recent action — repeating last macro', plan.macro.name);
      await runMacro(plan.macro.id!);
      return;
    }
    const candidate = plan.candidate;
    let macro = matchExistingMacro(macros, candidate);
    if (!macro) {
      const taken = new Set(macros.map((m) => m.name));
      const fresh = applyCandidate(null, candidate, nameMacro(candidate, macros.length, taken), mintMacroKey(candidate), now);
      fresh.status = 'accepted'; // the user asked for it, same as K
      const id = await putMacro(fresh);
      macro = { ...fresh, id };
    }
    await tell('Repeating last action', macro.name);
    if (macro.id !== undefined) await runMacro(macro.id);
  } catch (err) {
    await tell('Could not repeat', err instanceof Error ? err.message : String(err));
  }
}

/** K: keep the last ~30 seconds of activity as a macro. */
export async function keepLastAsMacro(): Promise<void> {
  const macro = await recordMacroFromRecentActivity();
  if (!macro) {
    await tell('Nothing to keep', 'No repeatable steps in the last 30 seconds.');
    return;
  }
  await tell('Macro saved', macro.name);
}

/** M: first press marks the start; the second keeps everything since as a macro. */
export async function toggleMark(): Promise<void> {
  const { [MARK_START_KEY]: start } = await chrome.storage.session.get<Record<string, number | undefined>>(MARK_START_KEY);
  const now = Date.now();
  if (start === undefined || now - start > MARK_MAX_AGE_MS) {
    await chrome.storage.session.set({ [MARK_START_KEY]: now });
    await tell('Macro recording started', 'Do the routine, then press the leader key and M again.');
    return;
  }
  await chrome.storage.session.remove(MARK_START_KEY);
  const macro = await recordMacroFromRecentActivity({ fromTs: start, toTs: now });
  if (!macro) {
    await tell('Nothing to keep', 'No repeatable steps between the two marks.');
    return;
  }
  await tell('Macro saved', macro.name);
}

/**
 * Leader S: asks a running replay to stop. Works from any context (the engine's own command
 * channel); the host cuts its sleep short, so this lands within about a quarter of a second.
 */
export async function stopRunningMacro(): Promise<boolean> {
  const state = await readRunState();
  if (!state || isTerminal(state)) return false;
  await sendRunCommand(state.runId, 'stop');
  return true;
}
