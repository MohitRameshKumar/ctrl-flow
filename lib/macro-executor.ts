/**
 * The macro execution loop.
 *
 * v1 replayed a macro by partitioning its steps into "all the opens" and then "all the clicks",
 * which threw away the recorded order — the reason Run felt like it only made a tab group. This
 * walks `macro.steps` exactly as the user sees them, one at a time.
 *
 * Everything that touches the browser lives behind `RunHost`, so this file holds only rules:
 * ordering, pacing, retries, pause/resume/skip/stop, the per-tab failure policy, and the budget.
 * That keeps it testable in plain Node against a fake host, the same discipline
 * `switch-detection.ts` follows.
 *
 * The host primitives are deliberately fine-grained (probe / click / awaitLoad) rather than one
 * method per step kind. Retrying has to happen out here: a hidden page clamps its own timers, so
 * an in-page poll is nearly useless in silent mode, and a retry loop inside the host could not
 * honor Pause or Stop between attempts.
 */

import {
  MACRO_BUDGET_GUIDED_MS,
  MACRO_BUDGET_SILENT_MS,
  MACRO_HEARTBEAT_MS,
  MACRO_PACE_FLOOR_MS,
  MACRO_PACE_MAX_MS,
  MACRO_PACE_SILENT_MS,
  MACRO_PAUSE_MAX_MS,
  MACRO_RETRY_ATTEMPTS,
  MACRO_RETRY_INTERVAL_MS,
  MACRO_WAIT_MAX_MS,
  MACRO_WAIT_SILENT_CAP_MS,
} from './constants';
import type {
  Macro,
  MacroRunResult,
  MacroRunState,
  MacroStep,
  RunCommandName,
  RunMode,
  RunSpeed,
  RunStatus,
  StepOutcome,
  StepOutcomeStatus,
} from './types';

export interface OpenedTabInfo {
  tabId?: number;
  error?: string;
  /** False when an already-open tab was reused, so cleanup only closes what this run created. */
  created: boolean;
}

export interface TabCondition {
  discarded?: boolean;
  /** Chrome 132+. `undefined` means unknown — rely on the injection timeout instead of branching. */
  frozen?: boolean;
}

/**
 * Every browser interaction the engine needs.
 *
 * **Implementations must guarantee every method settles.** The engine owns retries and the
 * overall budget, but a call that hangs forever would defeat both — see
 * `MACRO_INJECT_TIMEOUT_MS`.
 */
export interface RunHost {
  now(): number;
  sleep(ms: number): Promise<void>;

  openTab(url: string, opts: { active: boolean }): Promise<OpenedTabInfo>;
  focusTab(tabId: number): Promise<void>;
  awaitLoad(tabId: number, timeoutMs: number): Promise<'complete' | 'timeout'>;
  tabCondition(tabId: number): Promise<TabCondition | null>;
  reloadTab(tabId: number): Promise<void>;
  setAutoDiscardable(tabId: number, value: boolean): Promise<void>;
  groupTabs(tabIds: number[], title: string, focusFirst: boolean): Promise<void>;
  findTabForUrl(url: string): Promise<number | undefined>;
  closeTabs(tabIds: number[]): Promise<void>;

  /** One attempt. Returns false when the element is simply not there yet. */
  probe(tabId: number, selector: string): Promise<boolean>;
  click(tabId: number, selector: string): Promise<{ clicked: boolean; reason?: string }>;
  type(tabId: number, selector: string, text: string): Promise<{ ok: boolean; reason?: string }>;
  /** Cadence-side: true when the URL is on the current exclusions list. Optional so existing fakes still work. */
  isUrlBlocked?(url: string): Promise<boolean>;

  /** Publishes progress. Doubles as the keepalive — see `MACRO_HEARTBEAT_MS`. */
  publish(state: MacroRunState): Promise<void>;
  /** Next pending control command, consumed by reading. */
  nextCommand(): Promise<RunCommandName | null>;
}

export interface ExecOptions {
  mode: RunMode;
  /** Guided dwell length. Ignored in silent mode, which has no audience to pace for. */
  speed?: RunSpeed;
  signal?: AbortSignal;
}

/* ---------------------------------------------------------------- *
 * Pure helpers — each separately testable
 * ---------------------------------------------------------------- */

/**
 * Guided honors the recorded rhythm, clamped; silent just yields.
 *
 * The speed sets the floor rather than scaling the result, so a macro that recorded a genuine
 * two-second pause still takes two seconds on every setting. Speed decides how long to linger
 * where the user had no measured rhythm to copy.
 */
export function paceFor(step: MacroStep, mode: RunMode, speed: RunSpeed = 'normal'): number {
  if (mode === 'silent') return MACRO_PACE_SILENT_MS;
  const floor = MACRO_PACE_FLOOR_MS[speed];
  const recorded = step.delayBeforeMs ?? 0;
  if (recorded <= 0) return floor;
  return Math.min(Math.max(recorded, floor), MACRO_PACE_MAX_MS);
}

/** A recorded `wait` is trusted in guided mode but cut short when running headless. */
export function waitMsFor(step: MacroStep, mode: RunMode): number {
  const requested = Math.min(Math.max(step.waitMs ?? 0, 0), MACRO_WAIT_MAX_MS);
  return mode === 'silent' ? Math.min(requested, MACRO_WAIT_SILENT_CAP_MS) : requested;
}

export function budgetFor(mode: RunMode): number {
  return mode === 'silent' ? MACRO_BUDGET_SILENT_MS : MACRO_BUDGET_GUIDED_MS;
}

/** Steps that act on a page, and so belong to a tab that can fail. */
export function isPageStep(step: MacroStep): boolean {
  return step.kind === 'click' || step.kind === 'type' || step.kind === 'wait_for';
}

/** Human-readable phase for the progress UI. */
export function describeStep(step: MacroStep): string {
  switch (step.kind) {
    case 'open_url':
      return `Opening ${step.title || hostOf(step.url)}`;
    case 'focus_tab':
      return `Switching to ${step.title || hostOf(step.url)}`;
    case 'click':
      return `Clicking ${step.label ?? step.selector ?? 'element'}`;
    case 'type':
      return `Typing into ${step.label ?? step.selector ?? 'field'}`;
    case 'wait':
      return 'Waiting';
    case 'wait_for':
      return `Waiting for ${step.label ?? step.selector ?? 'element'}`;
    case 'close_tabs':
      return 'Closing tabs';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* ---------------------------------------------------------------- *
 * The loop
 * ---------------------------------------------------------------- */

interface Outcome {
  status: StepOutcomeStatus;
  error?: string;
  tabId?: number;
}

/**
 * Runs a macro's enabled steps in order.
 *
 * `state` is mutated as the run progresses and republished on every heartbeat; the caller owns
 * persisting it. `enabled` is consulted exactly once, here — disabled steps are reported as
 * `skipped` rather than dropped, so the UI can say "2 click steps skipped" instead of quietly
 * doing less than the step list shows.
 */
export async function executeMacro(
  macro: Macro,
  host: RunHost,
  state: MacroRunState,
  opts: ExecOptions,
): Promise<MacroRunResult> {
  const { mode, speed = 'normal', signal } = opts;
  const startedAt = state.startedAt || host.now();
  const budget = budgetFor(mode);
  const outcomes = new Map<string, StepOutcome>();

  for (const step of macro.steps) {
    if (!step.enabled) outcomes.set(step.key, { stepKey: step.key, status: 'skipped' });
  }

  const enabled = macro.steps.filter((s) => s.enabled);
  state.total = enabled.length;

  /** URL -> tab, so later steps act on the tab an earlier step opened. */
  const tabIdByUrl = new Map<string, number>(Object.entries(state.tabIdByUrl ?? {}));
  const createdTabIds = new Set<number>(state.openedTabIds ?? []);
  // A click assumes the click before it on the same page landed, so one failure stops that tab's
  // chain. Other tabs are unaffected — a broken selector never costs the user the whole run.
  const failedTabs = new Set<number>();

  let paused = false;
  let stopped = false;
  let skipRequested = false;
  let pausedMs = 0;

  const elapsed = (): number => host.now() - startedAt - pausedMs;

  const publish = async (status: RunStatus, stepIndex: number, phase: string): Promise<void> => {
    state.status = status;
    state.stepIndex = stepIndex;
    state.phase = phase;
    state.paused = paused;
    state.heartbeatAt = host.now();
    state.openedTabIds = [...createdTabIds];
    state.tabIdByUrl = Object.fromEntries(tabIdByUrl);
    state.outcomes = [...outcomes.values()];
    await host.publish(state);
  };

  /** Applies every pending command. Returns false when the run should stop. */
  const drain = async (): Promise<boolean> => {
    for (;;) {
      const command = await host.nextCommand();
      if (command === null) return !stopped;
      if (command === 'stop') {
        stopped = true;
        return false;
      }
      if (command === 'pause') paused = true;
      if (command === 'resume') paused = false;
      if (command === 'skip') skipRequested = true;
    }
  };

  /**
   * Holds while paused, beating so the worker survives — but only up to `MACRO_PAUSE_MAX_MS`.
   * Pinning a service worker alive for an hour because someone walked away is worse than ending
   * the run and saying so.
   */
  const holdWhilePaused = async (stepIndex: number, phase: string): Promise<void> => {
    const pauseStart = host.now();
    while (paused && !stopped && !signal?.aborted) {
      if (host.now() - pauseStart > MACRO_PAUSE_MAX_MS) {
        stopped = true;
        state.status = 'interrupted';
        break;
      }
      await publish('paused', stepIndex, phase);
      await host.sleep(MACRO_HEARTBEAT_MS);
      if (!(await drain())) break;
    }
    pausedMs += host.now() - pauseStart;
  };

  /** Sleeps in heartbeat-sized slices so the worker stays alive and commands stay responsive. */
  const sleepAlive = async (ms: number, stepIndex: number, phase: string): Promise<void> => {
    let remaining = ms;
    while (remaining > 0 && !stopped && !skipRequested && !signal?.aborted) {
      const slice = Math.min(remaining, MACRO_HEARTBEAT_MS);
      await host.sleep(slice);
      remaining -= slice;
      await publish('running', stepIndex, phase);
      if (!(await drain())) return;
      if (paused) await holdWhilePaused(stepIndex, phase);
    }
  };

  /** True when the loop should abandon the current step. */
  const interrupted = (): boolean => stopped || skipRequested || (signal?.aborted ?? false);

  for (const [index, step] of enabled.entries()) {
    const phase = describeStep(step);
    state.cursorKey = step.key;

    if (!(await drain())) break;
    if (paused) {
      await holdWhilePaused(index, phase);
      if (stopped) break;
    }
    if (signal?.aborted) {
      outcomes.set(step.key, { stepKey: step.key, status: 'skipped', error: 'stopped' });
      continue;
    }
    if (elapsed() > budget) {
      outcomes.set(step.key, { stepKey: step.key, status: 'skipped', error: 'run budget exceeded' });
      continue;
    }
    if (skipRequested) {
      skipRequested = false;
      outcomes.set(step.key, { stepKey: step.key, status: 'skipped', error: 'skipped by user' });
      continue;
    }

    // Exclusions can change after a macro was saved: re-check every step that touches a URL, and
    // stop the whole run (not just the step) when one is blocked.
    if (step.url && host.isUrlBlocked && (await host.isUrlBlocked(step.url))) {
      const domain = (() => {
        try {
          return new URL(step.url).hostname;
        } catch {
          return step.url;
        }
      })();
      const why = `Stopped at step ${index + 1} (${phase}): ${domain} is on your excluded sites`;
      outcomes.set(step.key, { stepKey: step.key, status: 'failed', error: why });
      state.phase = why;
      stopped = true;
      break;
    }

    await publish('running', index, phase);

    const pace = paceFor(step, mode, speed);
    if (pace > 0) await sleepAlive(pace, index, phase);
    if (stopped || signal?.aborted) {
      outcomes.set(step.key, { stepKey: step.key, status: 'skipped', error: 'stopped' });
      continue;
    }
    if (skipRequested) {
      skipRequested = false;
      outcomes.set(step.key, { stepKey: step.key, status: 'skipped', error: 'skipped by user' });
      continue;
    }

    const result = await runStep(step, {
      host,
      mode,
      tabIdByUrl,
      createdTabIds,
      failedTabs,
      macroName: macro.name,
      reuseOpenTabs: macro.reuseOpenTabs === true,
      index,
      phase,
      sleepAlive,
      interrupted,
    });

    outcomes.set(step.key, { stepKey: step.key, status: result.status, error: result.error });
    if (result.status === 'failed' && isPageStep(step) && result.tabId !== undefined) {
      failedTabs.add(result.tabId);
    }
  }

  // Anything never reached — a stop part-way through — is reported, not omitted.
  for (const step of enabled) {
    if (!outcomes.has(step.key)) {
      outcomes.set(step.key, { stepKey: step.key, status: 'skipped', error: 'stopped' });
    }
  }

  const finishedAt = host.now();
  state.outcomes = [...outcomes.values()];
  state.openedTabIds = [...createdTabIds];
  state.heartbeatAt = finishedAt;
  if (state.status !== 'interrupted') state.status = stopped ? 'stopped' : 'done';

  return {
    startedAt,
    finishedAt,
    // Reported in the order the steps are displayed, not the order they happened to run.
    outcomes: macro.steps
      .map((s) => outcomes.get(s.key))
      .filter((o): o is StepOutcome => o !== undefined),
  };
}

interface StepContext {
  host: RunHost;
  mode: RunMode;
  tabIdByUrl: Map<string, number>;
  createdTabIds: Set<number>;
  failedTabs: Set<number>;
  macroName: string;
  /** Per-macro option; default false = `open_url` always opens a new tab. */
  reuseOpenTabs: boolean;
  index: number;
  phase: string;
  sleepAlive: (ms: number, index: number, phase: string) => Promise<void>;
  interrupted: () => boolean;
}

async function runStep(step: MacroStep, ctx: StepContext): Promise<Outcome> {
  try {
    switch (step.kind) {
      case 'open_url':
        return await doOpen(step, ctx);
      case 'focus_tab':
        return await doFocus(step, ctx);
      case 'click':
      case 'type':
      case 'wait_for':
        return await doPageStep(step, ctx);
      case 'wait':
        await ctx.sleepAlive(waitMsFor(step, ctx.mode), ctx.index, ctx.phase);
        return { status: 'ok' };
      case 'close_tabs': {
        const ids = [...ctx.createdTabIds];
        if (ids.length > 0) await ctx.host.closeTabs(ids);
        ctx.createdTabIds.clear();
        return { status: 'ok' };
      }
    }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

async function doOpen(step: MacroStep, ctx: StepContext): Promise<Outcome> {
  // Cadence-side: by default an open step opens a new tab even if the page is already open somewhere
  // (the macro should do what the user did, and still work when those tabs are gone). The per-macro
  // "switch to it" option restores the old reuse.
  if (ctx.reuseOpenTabs) {
    const existing = ctx.tabIdByUrl.get(step.url) ?? (await ctx.host.findTabForUrl(step.url));
    if (existing !== undefined) {
      ctx.tabIdByUrl.set(step.url, existing);
      if (ctx.mode === 'guided') await ctx.host.focusTab(existing);
      return { status: 'ok', tabId: existing };
    }
  }

  // Guided brings each page to the front as it opens, which is the whole point of the mode.
  // Silent never does, so the user's current tab is never yanked away.
  const opened = await ctx.host.openTab(step.url, { active: ctx.mode === 'guided' });
  if (opened.tabId === undefined) {
    return { status: 'failed', error: opened.error ?? 'tab was not opened' };
  }

  ctx.tabIdByUrl.set(step.url, opened.tabId);
  if (opened.created) {
    ctx.createdTabIds.add(opened.tabId);
    // Memory Saver can discard a background tab out from under a silent run.
    if (ctx.mode === 'silent') await ctx.host.setAutoDiscardable(opened.tabId, false);
  }
  await ctx.host.groupTabs([...ctx.createdTabIds], ctx.macroName, ctx.mode === 'guided');
  return { status: 'ok', tabId: opened.tabId };
}

async function doFocus(step: MacroStep, ctx: StepContext): Promise<Outcome> {
  // Silent mode's whole promise is that focus never moves, so this is reported as skipped
  // rather than ok — it genuinely did not happen.
  if (ctx.mode === 'silent') {
    return { status: 'skipped', error: 'focus steps do not run in silent mode' };
  }
  const tabId = ctx.tabIdByUrl.get(step.url) ?? (await ctx.host.findTabForUrl(step.url));
  if (tabId === undefined) return { status: 'failed', error: 'no open tab for this page' };
  ctx.tabIdByUrl.set(step.url, tabId);
  await ctx.host.focusTab(tabId);
  return { status: 'ok', tabId };
}

/** click / type / wait_for all share tab resolution, readiness, and the retry loop. */
async function doPageStep(step: MacroStep, ctx: StepContext): Promise<Outcome> {
  const selector = step.selector ?? '';
  if (!selector) return { status: 'failed', error: 'step has no selector' };

  const tabId = ctx.tabIdByUrl.get(step.url) ?? (await ctx.host.findTabForUrl(step.url));
  if (tabId === undefined) return { status: 'failed', error: 'no open tab for this page' };
  ctx.tabIdByUrl.set(step.url, tabId);

  if (ctx.failedTabs.has(tabId)) {
    return { status: 'skipped', error: 'an earlier step on this page failed', tabId };
  }

  const ready = await ensureUsable(tabId, ctx);
  if (ready) return { ...ready, tabId };

  for (let attempt = 0; attempt < MACRO_RETRY_ATTEMPTS; attempt++) {
    if (ctx.interrupted()) return { status: 'skipped', error: 'stopped', tabId };

    if (step.kind === 'wait_for') {
      if (await ctx.host.probe(tabId, selector)) return { status: 'ok', tabId };
    } else if (step.kind === 'click') {
      const result = await ctx.host.click(tabId, selector);
      if (result.clicked) return { status: 'ok', tabId };
    } else {
      const result = await ctx.host.type(tabId, selector, step.text ?? '');
      if (result.ok) return { status: 'ok', tabId };
      // A refusal is a decision, not a transient miss — retrying a password field is pointless.
      if (result.reason && result.reason !== 'element not found') {
        return { status: 'failed', error: result.reason, tabId };
      }
    }

    if (attempt < MACRO_RETRY_ATTEMPTS - 1) {
      await ctx.sleepAlive(MACRO_RETRY_INTERVAL_MS, ctx.index, ctx.phase);
    }
  }

  const hint =
    ctx.mode === 'silent'
      ? 'element not found — this page may need guided mode'
      : 'element not found';
  return { status: 'failed', error: hint, tabId };
}

/** Returns a failing outcome when the tab cannot be acted on at all, otherwise null. */
async function ensureUsable(tabId: number, ctx: StepContext): Promise<Outcome | null> {
  const condition = await ctx.host.tabCondition(tabId);

  if (condition?.discarded) {
    await ctx.host.reloadTab(tabId);
  }

  // A frozen tab swallows injections without ever settling. The only non-debugger thaw is to
  // activate it, which silent mode has promised not to do — so say so instead of hanging.
  if (condition?.frozen && ctx.mode === 'silent') {
    return { status: 'failed', error: 'tab was frozen by Chrome — try guided mode' };
  }
  if (condition?.frozen) await ctx.host.focusTab(tabId);

  const loaded = await ctx.host.awaitLoad(tabId, MACRO_INJECT_LOAD_TIMEOUT_MS);
  if (loaded === 'timeout') return { status: 'failed', error: 'page did not finish loading' };
  return null;
}

const MACRO_INJECT_LOAD_TIMEOUT_MS = 15_000;

/** One-line summary for the UI: "Opened 3 tabs · 2 actions · 1 failed". */
export function summarizeRun(macro: Macro, result: MacroRunResult): string {
  const byKey = new Map(macro.steps.map((s) => [s.key, s]));
  let opened = 0;
  let acted = 0;
  let failed = 0;
  let skipped = 0;

  for (const outcome of result.outcomes) {
    const kind = byKey.get(outcome.stepKey)?.kind;
    if (outcome.status === 'ok') {
      if (kind === 'open_url') opened++;
      else if (kind === 'click' || kind === 'type') acted++;
    } else if (outcome.status === 'failed') failed++;
    else skipped++;
  }

  const parts: string[] = [`Opened ${opened} tab${opened === 1 ? '' : 's'}`];
  if (acted > 0) parts.push(`${acted} action${acted === 1 ? '' : 's'}`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(' · ');
}
