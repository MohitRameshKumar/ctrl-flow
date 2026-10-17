// Leader-key actions for Repeat-to-Macro. Everything here is a thin caller over the teammate's own
// functions (`runMacro`, `recordMacroFromRecentActivity`, the run channel); no detection or replay
// logic lives in this file.
import { MACRO_RECORD_WINDOW_MS } from './constants';
import { getMacros } from './db';
import type { LeaderContext, LeaderRepeatPreviewMessage } from './hotkeys';
import {
  lastSegment,
  planRepeat,
  previewText,
  refineSegment,
  segmentStart,
  type RepeatPlan,
} from './macro-repeat';
import { chromeActionSource } from './macro-source';
import {
  MACRO_NOTIFICATION_PREFIX,
  recordMacroFromRecentActivity,
  runMacro,
} from './macros';
import { getBlocklist, isBlocklisted } from './privacy';
import { isTerminal, readRunState, sendRunCommand } from './macro-run-channel';

const MARK_START_KEY = 'macroMarkStart';
/** End of the last K / R / M: later segments start after it, so a repeat never re-includes what was already kept. */
const CONSUMED_KEY = 'macroSegmentConsumedAt';
const PENDING_REPEAT_KEY = 'macroRepeatPending';
const PENDING_REPEAT_MAX_AGE_MS = 2 * 60 * 1000;
export const LEADER_NOTIFICATION_PREFIX = 'cadence-leader:';
const REPEAT_NOTIFICATION_ID = `${LEADER_NOTIFICATION_PREFIX}repeat`;
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

async function readSession<T>(key: string): Promise<T | undefined> {
  const stored = await chrome.storage.session.get<Record<string, T | undefined>>(key);
  return stored[key];
}

async function markConsumed(ts = Date.now()): Promise<void> {
  await chrome.storage.session.set({ [CONSUMED_KEY]: ts });
}

/** Stored events only: pause and exclusions were applied when they were written; re-applied here for later blocklist edits. */
async function recentActions(since: number, now: number) {
  const [actions, blocklist] = await Promise.all([chromeActionSource.getActions(since, now), getBlocklist()]);
  return actions.filter((a) => {
    try {
      return !isBlocklisted(new URL(a.target).hostname, blocklist);
    } catch {
      return true;
    }
  });
}

async function computePlan(now: number): Promise<RepeatPlan> {
  const macros = await getMacros();
  const [consumed, markStart] = await Promise.all([
    readSession<number>(CONSUMED_KEY),
    readSession<number>(MARK_START_KEY),
  ]);
  const lastRunEnd = Math.max(0, ...macros.map((m) => m.lastRunAt ?? 0));
  const since = segmentStart(now, { lastRunEnd, lastConsumed: consumed, markStart });
  const segment = lastSegment(await recentActions(since, now), since, now);
  return planRepeat(segment, macros);
}

interface PendingRepeat {
  plan: RepeatPlan;
  createdAt: number;
}

/**
 * R, step 1: work out what would be repeated and show it; nothing runs until the user confirms.
 * The overlay shows the preview in the page; where it cannot (panel, no tab) a notification with
 * Run / Cancel buttons does.
 */
export async function previewRepeat(ctx: LeaderContext = {}): Promise<void> {
  const plan = await computePlan(Date.now());
  const { runnable, text } = previewText(plan);
  if (runnable) await chrome.storage.session.set({ [PENDING_REPEAT_KEY]: { plan, createdAt: Date.now() } satisfies PendingRepeat });
  else await chrome.storage.session.remove(PENDING_REPEAT_KEY);

  if (ctx.tabId !== undefined) {
    const message: LeaderRepeatPreviewMessage = { type: 'leader_repeat_preview', text, runnable };
    try {
      await chrome.tabs.sendMessage(ctx.tabId, message, { frameId: 0 });
      return;
    } catch {
      /* no overlay in this tab: fall through to the notification */
    }
  }
  try {
    await chrome.notifications.create(REPEAT_NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: '/icon/128.png',
      title: 'Cadence · repeat',
      message: text,
      ...(runnable ? { buttons: [{ title: 'Run' }, { title: 'Cancel' }] } : {}),
    });
  } catch (err) {
    console.warn('[cadence] repeat preview notification failed', err);
  }
}

/** R, step 2 (Enter): run exactly what the preview showed. */
export async function confirmRepeat(): Promise<void> {
  const pending = await readSession<PendingRepeat>(PENDING_REPEAT_KEY);
  await chrome.storage.session.remove(PENDING_REPEAT_KEY);
  if (!pending || Date.now() - pending.createdAt > PENDING_REPEAT_MAX_AGE_MS) {
    await tell('Preview expired', 'Press the leader key and R again.');
    return;
  }
  const { plan } = pending;
  try {
    let macroId: number | undefined;
    if (plan.via === 'segment') {
      // The same function Leader K uses, over the window the preview was built from.
      const macro = await recordMacroFromRecentActivity({ ...plan.segment.window, refine: refineSegment, reuseExisting: true });
      macroId = macro?.id;
    } else if (plan.via === 'last-macro') {
      macroId = plan.macro.id;
    }
    if (macroId === undefined) {
      await tell('Could not repeat', 'The recorded steps are no longer available.');
      return;
    }
    await markConsumed();
    await runMacro(macroId);
  } catch (err) {
    await tell('Could not repeat', err instanceof Error ? err.message : String(err));
  }
}

export async function cancelRepeat(): Promise<void> {
  await chrome.storage.session.remove(PENDING_REPEAT_KEY);
  await chrome.notifications.clear(REPEAT_NOTIFICATION_ID).catch(() => undefined);
}

/** Buttons on the fallback notification: 0 = Run, 1 = Cancel. */
export async function handleLeaderNotificationButtonClicked(notificationId: string, buttonIndex: number): Promise<void> {
  if (notificationId !== REPEAT_NOTIFICATION_ID) return;
  if (buttonIndex === 0) await confirmRepeat();
  else await cancelRepeat();
  await chrome.notifications.clear(notificationId).catch(() => undefined);
}

/** R (the registered action) is just the preview. */
export const repeatLastMacro = previewRepeat;

/** K: keep the last ~30 seconds of activity as a macro. */
export async function keepLastAsMacro(): Promise<void> {
  const now = Date.now();
  const consumed = (await readSession<number>(CONSUMED_KEY)) ?? 0;
  const macro = await recordMacroFromRecentActivity({
    fromTs: Math.max(now - MACRO_RECORD_WINDOW_MS, consumed),
    toTs: now,
    refine: refineSegment,
  });
  if (macro) await markConsumed(now);
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
  const macro = await recordMacroFromRecentActivity({ fromTs: start, toTs: now, refine: refineSegment });
  await markConsumed(now);
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
