import { describe, expect, it } from 'vitest';
import { isStale, isTerminal } from '@/lib/macro-run-channel';
import { MACRO_RUN_STALE_MS } from '@/lib/constants';
import type { MacroRunState, RunStatus } from '@/lib/types';
import { freshRunState } from './fake-host';

function state(overrides: Partial<MacroRunState> = {}): MacroRunState {
  return freshRunState(overrides);
}

describe('isTerminal', () => {
  it('recognizes the ways a run can be over', () => {
    const over: RunStatus[] = ['done', 'stopped', 'interrupted'];
    for (const status of over) expect(isTerminal(state({ status }))).toBe(true);
  });

  it('a paused or stopping run is not over', () => {
    // `stopping` matters: Stop is honored at the next checkpoint, so a click already in flight
    // still finishes and the run is not yet finished.
    expect(isTerminal(state({ status: 'paused' }))).toBe(false);
    expect(isTerminal(state({ status: 'stopping' }))).toBe(false);
    expect(isTerminal(state({ status: 'running' }))).toBe(false);
  });
});

describe('isStale', () => {
  const now = 10_000_000;

  it('a run that stopped beating had its worker killed', () => {
    const dead = state({ status: 'running', heartbeatAt: now - MACRO_RUN_STALE_MS - 1 });
    expect(isStale(dead, now)).toBe(true);
  });

  it('a run beating normally is alive', () => {
    expect(isStale(state({ status: 'running', heartbeatAt: now - 1000 }), now)).toBe(false);
  });

  it('a paused run still beats, so going quiet still means dead', () => {
    const dead = state({ status: 'paused', heartbeatAt: now - MACRO_RUN_STALE_MS - 1 });
    expect(isStale(dead, now)).toBe(true);
  });

  it('a finished run is never stale, however old', () => {
    // Otherwise the summary of a completed run would be reaped out from under the user.
    const old = state({ status: 'done', heartbeatAt: now - 10 * MACRO_RUN_STALE_MS });
    expect(isStale(old, now)).toBe(false);
  });

  it('does not call a run stale exactly at the boundary', () => {
    const edge = state({ status: 'running', heartbeatAt: now - MACRO_RUN_STALE_MS });
    expect(isStale(edge, now)).toBe(false);
  });
});
