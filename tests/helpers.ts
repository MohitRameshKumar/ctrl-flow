import type { CadenceEvent, Macro, MacroCandidate, MacroStep, ObservedAction } from '@/lib/types';

/** Local-time timestamp builder, so time-of-day tests don't depend on the runner's timezone. */
export function at(day: number, hour: number, minute = 0, second = 0): number {
  return new Date(2026, 9, day, hour, minute, second).getTime();
}

export function open(ts: number, url: string, extra: Partial<ObservedAction> = {}): ObservedAction {
  return { ts, kind: 'open_url', target: url, deliberate: true, ...extra };
}

/** An open that came from switching back to an existing tab rather than going somewhere. */
export function activate(ts: number, url: string): ObservedAction {
  return { ts, kind: 'open_url', target: url, deliberate: false };
}

export function click(ts: number, url: string, selector: string): ObservedAction {
  return { ts, kind: 'click', target: url, selector, label: selector, deliberate: true };
}

export function event(partial: Partial<CadenceEvent> & Pick<CadenceEvent, 'ts' | 'kind'>): CadenceEvent {
  return partial as CadenceEvent;
}

export function openStep(url: string, overrides: Partial<MacroStep> = {}): MacroStep {
  return { key: `open:${url}`, kind: 'open_url', url, enabled: true, support: 1, ...overrides };
}

export function clickStep(url: string, selector: string, overrides: Partial<MacroStep> = {}): MacroStep {
  return {
    key: `click:${url}|${selector}`,
    kind: 'click',
    url,
    selector,
    enabled: false,
    support: 1,
    ...overrides,
  };
}

export function candidate(steps: MacroStep[], overrides: Partial<MacroCandidate> = {}): MacroCandidate {
  return { steps, detector: 'sequence', occurrences: 3, typicalHour: null, ...overrides };
}

export function macro(overrides: Partial<Macro> = {}): Macro {
  return {
    id: 1,
    macroKey: 'm:test',
    name: 'Test macro',
    nameIsUserSet: false,
    source: 'chrome',
    detector: 'sequence',
    steps: [],
    removedStepKeys: [],
    pinnedStepKeys: [],
    status: 'suggested',
    occurrences: 3,
    typicalHour: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export const A = 'https://github.com/org/repo/pulls';
export const B = 'https://linear.app/team/active';
export const C = 'https://docs.google.com/d/standup';
export const D = 'https://notion.so/team/notes';
