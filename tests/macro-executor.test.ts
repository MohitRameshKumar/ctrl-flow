import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  describeStep,
  executeMacro,
  isPageStep,
  paceFor,
  summarizeRun,
  waitMsFor,
} from '@/lib/macro-executor';
import {
  MACRO_PACE_FLOOR_MS,
  MACRO_PACE_MAX_MS,
  MACRO_PACE_MIN_MS,
  MACRO_PACE_SILENT_MS,
  MACRO_RETRY_ATTEMPTS,
  MACRO_WAIT_SILENT_CAP_MS,
} from '@/lib/constants';
import type { MacroStep, StepOutcome } from '@/lib/types';
import { actionsOnly, createFakeHost, freshRunState } from './fake-host';
import { A, B, clickStep, macro, openStep } from './helpers';

function step(overrides: Partial<MacroStep> & Pick<MacroStep, 'key' | 'kind'>): MacroStep {
  return { url: '', enabled: true, support: 1, ...overrides };
}

function outcome(outcomes: StepOutcome[], key: string): StepOutcome | undefined {
  return outcomes.find((o) => o.stepKey === key);
}

const guided = { mode: 'guided' as const };
const silent = { mode: 'silent' as const };

describe('ordering', () => {
  it('runs interleaved steps in the order they are listed', async () => {
    // The v1 regression: opens were batched ahead of every click, so this exact sequence was
    // impossible to express. `attachClicks` has always emitted steps in this shape.
    const host = createFakeHost();
    const target = macro({
      steps: [
        openStep(A),
        clickStep(A, '#review', { enabled: true }),
        openStep(B),
        clickStep(B, '#mine', { enabled: true }),
      ],
    });

    await executeMacro(target, host, freshRunState(), guided);

    expect(actionsOnly(host.trace)).toEqual([
      `open:${A}:active`,
      'click:#review',
      `open:${B}:active`,
      'click:#mine',
    ]);
  });

  it('honors a user reorder that puts a click before an open', async () => {
    const host = createFakeHost({ openTabs: { [A]: 7 } });
    const target = macro({
      steps: [clickStep(A, '#first', { enabled: true }), openStep(B)],
    });

    await executeMacro(target, host, freshRunState(), guided);

    expect(actionsOnly(host.trace)).toEqual(['click:#first', `open:${B}:active`]);
  });

  it('reports outcomes in display order regardless of what ran', async () => {
    const host = createFakeHost();
    const target = macro({
      steps: [openStep(A), clickStep(A, '#go', { enabled: true }), openStep(B)],
    });

    const result = await executeMacro(target, host, freshRunState(), guided);

    expect(result.outcomes.map((o) => o.stepKey)).toEqual([
      `open:${A}`,
      `click:${A}|#go`,
      `open:${B}`,
    ]);
  });
});

describe('modes', () => {
  it('guided activates each tab as it opens', async () => {
    const host = createFakeHost();
    await executeMacro(macro({ steps: [openStep(A), openStep(B)] }), host, freshRunState(), guided);
    expect(host.trace.filter((t) => t.startsWith('open:'))).toEqual([
      `open:${A}:active`,
      `open:${B}:active`,
    ]);
  });

  it('silent never activates and never focuses', async () => {
    const host = createFakeHost();
    await executeMacro(macro({ steps: [openStep(A), openStep(B)] }), host, freshRunState(), silent);

    expect(host.trace.filter((t) => t.startsWith('open:'))).toEqual([
      `open:${A}:background`,
      `open:${B}:background`,
    ]);
    expect(host.trace.some((t) => t.startsWith('focus:'))).toBe(false);
  });

  it('silent protects its tabs from being discarded mid-run', async () => {
    const host = createFakeHost();
    await executeMacro(macro({ steps: [openStep(A)] }), host, freshRunState(), silent);
    expect(host.trace).toContain('auto-discardable:1000:false');
  });

  it('skips focus_tab steps in silent mode and says why', async () => {
    const host = createFakeHost();
    const focus = step({ key: `focus:${A}`, kind: 'focus_tab', url: A });
    const result = await executeMacro(
      macro({ steps: [openStep(A), focus] }),
      host,
      freshRunState(),
      silent,
    );

    const skipped = outcome(result.outcomes, `focus:${A}`);
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.error).toMatch(/silent mode/);
  });

  it('runs focus_tab in guided mode', async () => {
    const host = createFakeHost();
    const focus = step({ key: `focus:${A}`, kind: 'focus_tab', url: A });
    const result = await executeMacro(
      macro({ steps: [openStep(A), focus] }),
      host,
      freshRunState(),
      guided,
    );
    expect(outcome(result.outcomes, `focus:${A}`)?.status).toBe('ok');
  });

  it('tells the user to try guided mode when silent cannot find an element', async () => {
    const host = createFakeHost({ clickResults: { '#go': false } });
    const result = await executeMacro(
      macro({ steps: [openStep(A), clickStep(A, '#go', { enabled: true })] }),
      host,
      freshRunState(),
      silent,
    );
    expect(outcome(result.outcomes, `click:${A}|#go`)?.error).toMatch(/guided mode/);
  });

  it('refuses to act on a frozen tab in silent mode rather than hanging', async () => {
    // executeScript against a frozen tab never settles, so this must be caught up front.
    const host = createFakeHost({ openTabs: { [A]: 42 }, tabConditions: { 42: { frozen: true } } });
    const result = await executeMacro(
      macro({ steps: [clickStep(A, '#go', { enabled: true })] }),
      host,
      freshRunState(),
      silent,
    );
    expect(outcome(result.outcomes, `click:${A}|#go`)?.error).toMatch(/frozen/);
    expect(host.trace.some((t) => t.startsWith('click:'))).toBe(false);
  });

  it('reloads a discarded tab before acting on it', async () => {
    const host = createFakeHost({
      openTabs: { [A]: 42 },
      tabConditions: { 42: { discarded: true } },
    });
    await executeMacro(
      macro({ steps: [clickStep(A, '#go', { enabled: true })] }),
      host,
      freshRunState(),
      silent,
    );
    expect(host.trace).toContain('reload:42');
  });
});

describe('pacing', () => {
  it('clamps a recorded gap into the guided range', () => {
    expect(paceFor(openStep(A, { delayBeforeMs: 50 }), 'guided')).toBe(MACRO_PACE_MIN_MS);
    expect(paceFor(openStep(A, { delayBeforeMs: 1200 }), 'guided')).toBe(1200);
    expect(paceFor(openStep(A, { delayBeforeMs: 99_000 }), 'guided')).toBe(MACRO_PACE_MAX_MS);
  });

  it('ignores recorded pacing entirely in silent mode', () => {
    expect(paceFor(openStep(A, { delayBeforeMs: 2500 }), 'silent')).toBe(MACRO_PACE_SILENT_MS);
  });

  it('speed sets the floor for a step with no recorded rhythm', () => {
    // Which is every hand-authored step. At the old 250ms floor these went past far too fast
    // to follow, which is the whole reason the setting exists.
    const bare = openStep(A);
    expect(paceFor(bare, 'guided', 'slow')).toBe(MACRO_PACE_FLOOR_MS.slow);
    expect(paceFor(bare, 'guided', 'normal')).toBe(MACRO_PACE_FLOOR_MS.normal);
    expect(paceFor(bare, 'guided', 'fast')).toBe(MACRO_PACE_FLOOR_MS.fast);
  });

  it('a real recorded pause survives every speed', () => {
    // Speed raises the floor; it does not scale the result. A routine where the user genuinely
    // waited two seconds should still wait two seconds, even on Fast.
    const recorded = openStep(A, { delayBeforeMs: 2000 });
    expect(paceFor(recorded, 'guided', 'fast')).toBe(2000);
    expect(paceFor(recorded, 'guided', 'normal')).toBe(2000);
    // ...unless the floor is higher, in which case the floor wins.
    expect(paceFor(openStep(A, { delayBeforeMs: 400 }), 'guided', 'slow')).toBe(
      MACRO_PACE_FLOOR_MS.slow,
    );
  });

  it('never exceeds the ceiling, however slow the setting', () => {
    expect(paceFor(openStep(A, { delayBeforeMs: 99_000 }), 'guided', 'slow')).toBe(
      MACRO_PACE_MAX_MS,
    );
  });

  it('speed has no effect in silent mode', () => {
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      expect(paceFor(openStep(A), 'silent', speed)).toBe(MACRO_PACE_SILENT_MS);
    }
  });

  it('defaults to normal when no speed is given', () => {
    expect(paceFor(openStep(A), 'guided')).toBe(MACRO_PACE_FLOOR_MS.normal);
  });

  it('actually sleeps the paced amount between steps', async () => {
    const host = createFakeHost();
    // Both above the normal floor, so this measures that recorded pacing reaches the clock
    // rather than accidentally measuring the floor.
    const target = macro({
      steps: [openStep(A, { delayBeforeMs: 1100 }), openStep(B, { delayBeforeMs: 1500 })],
    });

    await executeMacro(target, host, freshRunState(), guided);

    expect(host.trace.filter((t) => t.startsWith('sleep:'))).toEqual(['sleep:1100', 'sleep:1500']);
  });

  it('the selected speed reaches the clock', async () => {
    const host = createFakeHost();
    const target = macro({ steps: [openStep(A), openStep(B)] });

    await executeMacro(target, host, freshRunState(), { mode: 'guided', speed: 'slow' });

    expect(host.trace.filter((t) => t.startsWith('sleep:'))).toEqual([
      `sleep:${MACRO_PACE_FLOOR_MS.slow}`,
      `sleep:${MACRO_PACE_FLOOR_MS.slow}`,
    ]);
  });

  it('caps a fixed wait hard in silent mode', () => {
    const wait = step({ key: 'wait:1', kind: 'wait', waitMs: 10_000 });
    expect(waitMsFor(wait, 'guided')).toBe(10_000);
    expect(waitMsFor(wait, 'silent')).toBe(MACRO_WAIT_SILENT_CAP_MS);
  });

  it('a wait step sleeps and reports ok', async () => {
    const host = createFakeHost();
    const wait = step({ key: 'wait:1', kind: 'wait', waitMs: 2000 });
    const result = await executeMacro(macro({ steps: [wait] }), host, freshRunState(), guided);

    expect(host.trace).toContain('sleep:2000');
    expect(outcome(result.outcomes, 'wait:1')?.status).toBe('ok');
  });
});

describe('retry', () => {
  it('retries a click from the engine until the element appears', async () => {
    // Retrying lives out here, not in the injected function: a hidden page clamps its own
    // timers, so an in-page poll barely runs in silent mode.
    const host = createFakeHost({ openTabs: { [A]: 5 }, appearsAfter: { '#late': 3 } });
    const result = await executeMacro(
      macro({ steps: [clickStep(A, '#late', { enabled: true })] }),
      host,
      freshRunState(),
      guided,
    );

    expect(outcome(result.outcomes, `click:${A}|#late`)?.status).toBe('ok');
    expect(host.trace.filter((t) => t === 'click:#late')).toHaveLength(3);
  });

  it('gives up after the attempt cap', async () => {
    const host = createFakeHost({ openTabs: { [A]: 5 }, clickResults: { '#never': false } });
    const result = await executeMacro(
      macro({ steps: [clickStep(A, '#never', { enabled: true })] }),
      host,
      freshRunState(),
      guided,
    );

    expect(outcome(result.outcomes, `click:${A}|#never`)?.status).toBe('failed');
    expect(host.trace.filter((t) => t === 'click:#never')).toHaveLength(MACRO_RETRY_ATTEMPTS);
  });

  it('wait_for probes instead of clicking', async () => {
    const host = createFakeHost({ openTabs: { [A]: 5 }, appearsAfter: { '#ready': 2 } });
    const waitFor = step({ key: 'wait_for:1', kind: 'wait_for', url: A, selector: '#ready' });

    const result = await executeMacro(macro({ steps: [waitFor] }), host, freshRunState(), guided);

    expect(outcome(result.outcomes, 'wait_for:1')?.status).toBe('ok');
    expect(host.trace.filter((t) => t === 'probe:#ready')).toHaveLength(2);
    expect(host.trace.some((t) => t.startsWith('click:'))).toBe(false);
  });

  it('does not retry a refusal, only a miss', async () => {
    const host = createFakeHost({
      openTabs: { [A]: 5 },
      typeResults: { '#pw': { ok: false, reason: 'refused: credential field' } },
    });
    const typeStep = step({
      key: 'type:1',
      kind: 'type',
      url: A,
      selector: '#pw',
      text: 'hunter2',
    });

    const result = await executeMacro(macro({ steps: [typeStep] }), host, freshRunState(), guided);

    expect(outcome(result.outcomes, 'type:1')?.error).toMatch(/credential/);
    expect(host.trace.filter((t) => t.startsWith('type:'))).toHaveLength(1);
  });
});

describe('failure policy', () => {
  it('stops one tab’s chain after a failure but keeps going elsewhere', async () => {
    const host = createFakeHost({ clickResults: { '#first': false } });
    const target = macro({
      steps: [
        openStep(A),
        clickStep(A, '#first', { enabled: true }),
        clickStep(A, '#second', { enabled: true }),
        openStep(B),
        clickStep(B, '#other', { enabled: true }),
      ],
    });

    const result = await executeMacro(target, host, freshRunState(), guided);

    expect(outcome(result.outcomes, `click:${A}|#first`)?.status).toBe('failed');
    expect(outcome(result.outcomes, `click:${A}|#second`)?.status).toBe('skipped');
    expect(outcome(result.outcomes, `click:${B}|#other`)?.status).toBe('ok');
    expect(host.trace).not.toContain('click:#second');
  });

  it('reports a disabled step as skipped and never touches the page', async () => {
    const host = createFakeHost();
    const target = macro({
      steps: [openStep(A), clickStep(A, '#go'), openStep(B, { enabled: false })],
    });

    const result = await executeMacro(target, host, freshRunState(), guided);

    expect(outcome(result.outcomes, `click:${A}|#go`)?.status).toBe('skipped');
    expect(outcome(result.outcomes, `open:${B}`)?.status).toBe('skipped');
    expect(host.trace.some((t) => t.startsWith('click:'))).toBe(false);
  });

  it('keeps the tabs when opening one fails', async () => {
    const host = createFakeHost({ openFails: true });
    const result = await executeMacro(
      macro({ steps: [openStep(A), openStep(B)] }),
      host,
      freshRunState(),
      guided,
    );
    // Each open fails on its own; one bad URL does not abort the rest of the run.
    expect(result.outcomes.every((o) => o.status === 'failed')).toBe(true);
    expect(host.trace.filter((t) => t.startsWith('open-fail:'))).toHaveLength(2);
  });

  it('fails a page step whose tab is not open', async () => {
    const host = createFakeHost();
    const result = await executeMacro(
      macro({ steps: [clickStep(B, '#go', { enabled: true })] }),
      host,
      freshRunState(),
      guided,
    );
    expect(outcome(result.outcomes, `click:${B}|#go`)?.error).toMatch(/no open tab/);
  });

  it('fails rather than injecting into a page that never loaded', async () => {
    const host = createFakeHost({ openTabs: { [A]: 9 }, loadResult: 'timeout' });
    const result = await executeMacro(
      macro({ steps: [clickStep(A, '#go', { enabled: true })] }),
      host,
      freshRunState(),
      guided,
    );
    // Before waitForTabComplete distinguished timeout from success this surfaced as a
    // confusing "element not found".
    expect(outcome(result.outcomes, `click:${A}|#go`)?.error).toMatch(/did not finish loading/);
  });

  it('reuses an already-open tab instead of duplicating it', async () => {
    const host = createFakeHost({ openTabs: { [A]: 3 } });
    await executeMacro(macro({ steps: [openStep(A), openStep(B)] }), host, freshRunState(), guided);
    expect(host.trace.filter((t) => t.startsWith('open:'))).toEqual([`open:${B}:active`]);
  });
});

describe('control', () => {
  it('stops the run and marks the rest skipped', async () => {
    // Commands are polled twice per step (once at the top, once during pacing), so these two
    // nulls let step A finish before the stop lands at step B.
    const host = createFakeHost({ commands: [null, null, 'stop'] });
    const target = macro({ steps: [openStep(A), openStep(B)] });

    const result = await executeMacro(target, host, freshRunState(), guided);

    expect(outcome(result.outcomes, `open:${A}`)?.status).toBe('ok');
    expect(outcome(result.outcomes, `open:${B}`)?.status).toBe('skipped');
  });

  it('skips only the current step and carries on', async () => {
    const host = createFakeHost({ commands: ['skip'] });
    const target = macro({ steps: [openStep(A), openStep(B)] });

    const result = await executeMacro(target, host, freshRunState(), guided);

    expect(outcome(result.outcomes, `open:${A}`)?.error).toMatch(/skipped by user/);
    expect(outcome(result.outcomes, `open:${B}`)?.status).toBe('ok');
  });

  it('an aborted signal skips everything without touching the browser', async () => {
    const host = createFakeHost();
    const controller = new AbortController();
    controller.abort();

    const result = await executeMacro(
      macro({ steps: [openStep(A), openStep(B)] }),
      host,
      freshRunState(),
      { mode: 'guided', signal: controller.signal },
    );

    expect(result.outcomes.every((o) => o.status === 'skipped')).toBe(true);
    expect(host.trace.some((t) => t.startsWith('open:'))).toBe(false);
  });

  it('pauses, then resumes where it left off', async () => {
    // pause lands at step B's first poll; the trailing null ends that drain so the loop
    // actually enters the paused hold, and resume releases it one heartbeat later.
    const host = createFakeHost({ commands: [null, null, 'pause', null, 'resume'] });
    const target = macro({ steps: [openStep(A), openStep(B)] });

    const result = await executeMacro(target, host, freshRunState(), guided);

    expect(result.outcomes.every((o) => o.status === 'ok')).toBe(true);
    expect(host.published.some((p) => p.status === 'paused')).toBe(true);
  });

  it('publishes progress with a step index the UI can render', async () => {
    const host = createFakeHost();
    const target = macro({ steps: [openStep(A), openStep(B)] });

    await executeMacro(target, host, freshRunState(), guided);

    const running = host.published.filter((p) => p.status === 'running');
    expect(running.length).toBeGreaterThan(0);
    expect(running.at(-1)?.total).toBe(2);
    expect(running.map((p) => p.stepIndex)).toContain(1);
    expect(running.at(0)?.phase).toMatch(/Opening/);
  });
});

describe('close_tabs', () => {
  it('closes only the tabs this run created', async () => {
    const host = createFakeHost({ openTabs: { [A]: 3 } });
    const close = step({ key: 'close:1', kind: 'close_tabs' });
    const target = macro({ steps: [openStep(A), openStep(B), close] });

    await executeMacro(target, host, freshRunState(), guided);

    // A was already open and so is left alone; only the newly created tab is closed.
    expect(host.trace).toContain('close:[1000]');
  });
});

describe('pure helpers', () => {
  it('knows which steps belong to a tab', () => {
    expect(isPageStep(clickStep(A, '#go'))).toBe(true);
    expect(isPageStep(openStep(A))).toBe(false);
    expect(isPageStep(step({ key: 'w', kind: 'wait' }))).toBe(false);
  });

  it('gives silent a tighter budget than guided', () => {
    expect(budgetFor('silent')).toBeLessThan(budgetFor('guided'));
  });

  it('describes every step kind', () => {
    const kinds: MacroStep[] = [
      openStep(A, { title: 'Pulls' }),
      step({ key: 'f', kind: 'focus_tab', url: A, title: 'Pulls' }),
      clickStep(A, '#go', { label: 'Go' }),
      step({ key: 't', kind: 'type', url: A, selector: '#q', label: 'Search' }),
      step({ key: 'w', kind: 'wait' }),
      step({ key: 'wf', kind: 'wait_for', url: A, selector: '#x', label: 'Results' }),
      step({ key: 'c', kind: 'close_tabs' }),
    ];
    expect(kinds.map(describeStep)).toEqual([
      'Opening Pulls',
      'Switching to Pulls',
      'Clicking Go',
      'Typing into Search',
      'Waiting',
      'Waiting for Results',
      'Closing tabs',
    ]);
  });
});

describe('summarizeRun', () => {
  it('reads as a plain sentence', async () => {
    const host = createFakeHost({ clickResults: { '#bad': false } });
    const target = macro({
      steps: [
        openStep(A),
        openStep(B),
        clickStep(A, '#bad', { enabled: true }),
        clickStep(B, '#off'),
      ],
    });

    const result = await executeMacro(target, host, freshRunState(), guided);

    expect(summarizeRun(target, result)).toBe('Opened 2 tabs · 1 failed · 1 skipped');
  });

  it('counts clicks and types as actions', async () => {
    const host = createFakeHost();
    const target = macro({
      steps: [openStep(A), clickStep(A, '#go', { enabled: true })],
    });

    const result = await executeMacro(target, host, freshRunState(), guided);

    expect(summarizeRun(target, result)).toBe('Opened 1 tab · 1 action');
  });
});
