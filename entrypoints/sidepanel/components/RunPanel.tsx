import { useEffect, useState } from 'react';
import {
  MACRO_RUN_STATE_KEY,
  isStale,
  isTerminal,
  readRunState,
  sendRunCommand,
  clearRunState,
} from '@/lib/macro-run-channel';
import type { MacroRunState, MacroStep } from '@/lib/types';

/**
 * Live view of the run in flight.
 *
 * v1 wrote progress to session storage and nothing ever read it. This reads it, driven by
 * `storage.onChanged` rather than the 5-second poll the other tabs use — per-step progress needs
 * to be immediate to be worth showing at all.
 */
export interface RunPanelProps {
  state: MacroRunState;
  /** True when the run stopped beating — see `useRunState`. */
  abandoned: boolean;
  /** Steps of the macro being run, so each line can be labeled. */
  stepsByMacroId: Map<number, MacroStep[]>;
}

function stepLabel(step: MacroStep | undefined, index: number): string {
  if (!step) return `Step ${index + 1}`;
  switch (step.kind) {
    case 'open_url':
      return step.title || step.url;
    case 'focus_tab':
      return `Switch to ${step.title || step.url}`;
    case 'click':
      return `Click ${step.label ?? step.selector ?? 'element'}`;
    case 'type':
      return `Type into ${step.label ?? step.selector ?? 'field'}`;
    case 'wait':
      return `Wait ${Math.round((step.waitMs ?? 0) / 100) / 10}s`;
    case 'wait_for':
      return `Wait for ${step.label ?? step.selector ?? 'element'}`;
    case 'close_tabs':
      return 'Close the tabs this macro opened';
  }
}

/**
 * Subscribes to the one run that may be in flight.
 *
 * Lifted out of `RunPanel` so `MacrosTab` can know *which* macro is running and swap that
 * macro's card for the run view, rather than stacking a second card above the list.
 */
export function useRunState(onFinished: () => void): {
  state: MacroRunState | null;
  abandoned: boolean;
} {
  const [state, setState] = useState<MacroRunState | null>(null);
  /**
   * Re-evaluated on a timer, not just on storage changes.
   *
   * A run dies precisely by going quiet, so the event that should update the UI is the one that
   * never arrives. Without a clock the panel sits on the last frame the dead worker wrote and
   * shows an in-flight run with working-looking controls, indefinitely.
   */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    readRunState().then((s) => {
      if (!cancelled) setState(s);
    });

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'session' || !(MACRO_RUN_STATE_KEY in changes)) return;
      const next = (changes[MACRO_RUN_STATE_KEY]?.newValue ?? null) as MacroRunState | null;
      setState(next);
      if (next && isTerminal(next)) onFinished();
    };

    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [onFinished]);

  return { state, abandoned: state ? isStale(state, now) : false };
}

export function RunPanel({ state, abandoned, stepsByMacroId }: RunPanelProps) {
  const steps = (state.macroId >= 0 ? stepsByMacroId.get(state.macroId) : undefined) ?? [];
  const enabled = steps.filter((s) => s.enabled);
  // A run that stopped beating is over whether or not anything got around to writing that down.
  // The worker that would have finalized it is the one that died, and it may be minutes before
  // anything wakes a replacement — so the panel decides for itself rather than waiting.
  const done = isTerminal(state) || abandoned;
  const percent = state.total > 0 ? Math.round((state.stepIndex / state.total) * 100) : 0;

  if (done) {
    const failed = state.outcomes.some((o) => o.status === 'failed');
    return (
      <section className={failed || abandoned ? 'run-panel run-panel-error' : 'run-panel'}>
        <div className="run-panel-header">
          <strong>{state.macroName}</strong>
          <span className="run-panel-status">
            {state.status === 'interrupted' || abandoned
              ? 'Interrupted — Chrome stopped the run'
              : (state.summary ?? 'Finished')}
          </span>
        </div>
        <div className="space-actions">
          <button className="btn btn-secondary" onClick={() => void clearRunState()}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  const send = (command: 'pause' | 'resume' | 'stop' | 'skip') =>
    void sendRunCommand(state.runId, command);

  return (
    <section className="run-panel">
      <div className="run-panel-header">
        <strong>{state.macroName}</strong>
        <span className="run-panel-status">
          {state.paused ? 'Paused' : state.phase} · step {Math.min(state.stepIndex + 1, state.total)}{' '}
          of {state.total}
        </span>
      </div>

      <div className="run-progress">
        <div className="run-progress-fill" style={{ width: `${percent}%` }} />
      </div>

      {/* Silent mode has nothing to watch, so the step list would just be noise. */}
      {state.mode === 'guided' && enabled.length > 0 && (
        <ol className="run-steps">
          {enabled.map((step, index) => {
            const outcome = state.outcomes.find((o) => o.stepKey === step.key);
            const status = outcome?.status ?? (index === state.stepIndex ? 'active' : 'pending');
            return (
              <li key={step.key} className={`run-step run-step-${status}`}>
                <span className="run-step-mark">
                  {status === 'ok'
                    ? '✓'
                    : status === 'failed'
                      ? '✕'
                      : status === 'skipped'
                        ? '–'
                        : status === 'active'
                          ? '▸'
                          : '○'}
                </span>
                <span className="run-step-label">{stepLabel(step, index)}</span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="space-actions">
        {state.paused ? (
          <button className="btn btn-accept" onClick={() => send('resume')}>
            Resume
          </button>
        ) : (
          <button className="btn btn-secondary" onClick={() => send('pause')}>
            Pause
          </button>
        )}
        <button className="btn btn-secondary" onClick={() => send('skip')}>
          Skip step
        </button>
        <button className="btn btn-secondary" onClick={() => send('stop')}>
          Stop
        </button>
      </div>
    </section>
  );
}
