import type { OpenedTabInfo, RunHost, TabCondition } from '@/lib/macro-executor';
import type { MacroRunState, RunCommandName } from '@/lib/types';

/**
 * An in-memory `RunHost` that records an ordered trace of everything the engine asked for.
 *
 * The trace is the point: asserting `['open:A', 'click:A|#go', 'open:B']` expresses in one line
 * the exact thing v1's opens-then-clicks partition could not do. Because the host owns the clock
 * and `sleep` resolves instantly while still recording its argument, pacing is asserted with no
 * wall-clock time and no fake timers.
 */
export interface FakeHostOptions {
  /** Tabs already open before the run, by URL. */
  openTabs?: Record<string, number>;
  /** Per-selector click outcome. Anything unlisted succeeds on the first attempt. */
  clickResults?: Record<string, boolean>;
  /** Selectors that only appear after N probe/click attempts, for testing retry. */
  appearsAfter?: Record<string, number>;
  /** Per-selector type outcome. */
  typeResults?: Record<string, { ok: boolean; reason?: string }>;
  /** Commands handed to the engine in order, one per `nextCommand` call. */
  commands?: (RunCommandName | null)[];
  tabConditions?: Record<number, TabCondition>;
  loadResult?: 'complete' | 'timeout';
  openFails?: boolean;
}

export interface FakeHost extends RunHost {
  trace: string[];
  published: MacroRunState[];
  /** Virtual clock, advanced only by `sleep`. */
  clockMs: number;
}

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const {
    openTabs = {},
    clickResults = {},
    appearsAfter = {},
    typeResults = {},
    commands = [],
    tabConditions = {},
    loadResult = 'complete',
    openFails = false,
  } = options;

  const trace: string[] = [];
  const published: MacroRunState[] = [];
  const tabs = new Map<string, number>(Object.entries(openTabs));
  const attempts = new Map<string, number>();
  const queue = [...commands];
  let nextTabId = 1000;
  let clock = 0;

  const bump = (selector: string): number => {
    const n = (attempts.get(selector) ?? 0) + 1;
    attempts.set(selector, n);
    return n;
  };

  /** A selector listed in `appearsAfter` is missing until that many attempts have been made. */
  const present = (selector: string, attempt: number): boolean => {
    const threshold = appearsAfter[selector];
    if (threshold !== undefined && attempt < threshold) return false;
    return clickResults[selector] !== false;
  };

  const host: FakeHost = {
    trace,
    published,
    get clockMs() {
      return clock;
    },

    now: () => clock,
    async sleep(ms) {
      trace.push(`sleep:${ms}`);
      clock += ms;
    },

    async openTab(url, { active }) {
      if (openFails) {
        trace.push(`open-fail:${url}`);
        return { created: false, error: 'tabs.create failed' } satisfies OpenedTabInfo;
      }
      const tabId = nextTabId++;
      tabs.set(url, tabId);
      trace.push(`open:${url}${active ? ':active' : ':background'}`);
      return { tabId, created: true } satisfies OpenedTabInfo;
    },

    async focusTab(tabId) {
      trace.push(`focus:${tabId}`);
    },

    async awaitLoad(tabId) {
      trace.push(`await-load:${tabId}`);
      return loadResult;
    },

    async tabCondition(tabId) {
      return tabConditions[tabId] ?? {};
    },

    async reloadTab(tabId) {
      trace.push(`reload:${tabId}`);
    },

    async setAutoDiscardable(tabId, value) {
      trace.push(`auto-discardable:${tabId}:${value}`);
    },

    async groupTabs(tabIds, title) {
      trace.push(`group:[${tabIds.join(',')}]:${title}`);
    },

    async findTabForUrl(url) {
      return tabs.get(url);
    },

    async closeTabs(tabIds) {
      trace.push(`close:[${tabIds.join(',')}]`);
    },

    async probe(tabId, selector) {
      const attempt = bump(`probe:${selector}`);
      trace.push(`probe:${selector}`);
      return present(selector, attempt);
    },

    async click(tabId, selector) {
      const attempt = bump(`click:${selector}`);
      trace.push(`click:${selector}`);
      return present(selector, attempt)
        ? { clicked: true }
        : { clicked: false, reason: 'element not found' };
    },

    async type(tabId, selector, text) {
      trace.push(`type:${selector}:${text}`);
      return typeResults[selector] ?? { ok: true };
    },

    async publish(state) {
      published.push(structuredClone(state));
    },

    async nextCommand() {
      return queue.length > 0 ? (queue.shift() ?? null) : null;
    },
  };

  return host;
}

export function freshRunState(overrides: Partial<MacroRunState> = {}): MacroRunState {
  return {
    runId: 'run-test',
    macroId: 1,
    macroName: 'Test macro',
    mode: 'guided',
    status: 'running',
    stepIndex: 0,
    total: 0,
    phase: 'Starting',
    paused: false,
    startedAt: 0,
    heartbeatAt: 0,
    openedTabIds: [],
    tabIdByUrl: {},
    outcomes: [],
    ...overrides,
  };
}

/** Trace entries that represent real browser actions, dropping pacing and bookkeeping noise. */
export function actionsOnly(trace: string[]): string[] {
  return trace.filter(
    (entry) =>
      !entry.startsWith('sleep:') &&
      !entry.startsWith('await-load:') &&
      !entry.startsWith('group:') &&
      !entry.startsWith('auto-discardable:'),
  );
}
