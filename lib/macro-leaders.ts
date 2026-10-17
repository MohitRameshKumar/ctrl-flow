// Leader-key actions for Repeat-to-Macro. Everything here is a thin caller over the teammate's own
// functions (`runMacro`, `recordMacroFromRecentActivity`, the run channel); no detection or replay
// logic lives in this file.
import { getMacros } from './db';
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

/** R: run the macro that ran most recently. */
export async function repeatLastMacro(): Promise<void> {
  const ran = (await getMacros())
    .filter((m) => m.id !== undefined && m.status !== 'never' && m.lastRunAt !== undefined)
    .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
  const last = ran[0];
  if (last?.id === undefined) {
    await tell('Nothing to repeat yet', 'Run a macro first, or press K to keep what you just did as one.');
    return;
  }
  if ((await runMacro(last.id)) === null) await tell('Could not run macro', last.name);
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
