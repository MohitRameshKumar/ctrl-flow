/**
 * The seam between "where actions come from" and everything that reasons about them.
 *
 * Today there is one implementation, backed by the Chrome event collector. A desktop recorder
 * would implement the same two members and the detectors in `macro-detection.ts` would not
 * change at all, because they only ever see `ObservedAction`.
 */

import { getEvents } from './db';
import { eventToAction } from './macro-detection';
import { replayMacro } from './macro-replay';
import type { Macro, MacroRunResult, MacroSource, ObservedAction, ReplayOptions } from './types';

export interface ActionSource {
  readonly id: MacroSource;
  /** Replay-ready history in [fromTs, toTs], ascending by ts. */
  getActions(fromTs: number, toTs: number): Promise<ObservedAction[]>;
  execute(macro: Macro, opts: ReplayOptions): Promise<MacroRunResult>;
}

export const chromeActionSource: ActionSource = {
  id: 'chrome',

  async getActions(fromTs: number, toTs: number): Promise<ObservedAction[]> {
    const events = await getEvents(fromTs, toTs);
    const actions: ObservedAction[] = [];
    for (const event of events) {
      const action = eventToAction(event);
      if (action) actions.push(action);
    }
    return actions;
  },

  execute(macro: Macro, opts: ReplayOptions): Promise<MacroRunResult> {
    return replayMacro(macro, opts);
  },
};

/** Mirrors `createCalendarSource`. Only 'chrome' exists today. */
export function createActionSource(_source: MacroSource = 'chrome'): ActionSource {
  return chromeActionSource;
}
