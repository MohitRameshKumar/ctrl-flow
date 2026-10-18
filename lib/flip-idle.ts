// Activity-then-idle detection for Focus Flip, run inside the page. Pure apart from the injected
// timer / clock / sender, so the rule "a flip only follows activity followed by idle, measured from
// the real last event" is unit-testable with fake timers.
//
//   typing                -> one timer, restarted by every keystroke, fires after the *write* delay
//   scrolling + clicking  -> one shared timer, fires after the *read* delay
//
// A flip needs Focus Flip enabled, and nothing is ever sent without a prior event, so arriving at a
// tab and doing nothing can never produce an idle (and therefore never a flip). While it is OFF the
// page still reports that typing happened (at most every few seconds, no keys, no content) so the
// extension can notice a writing / reference pair and offer to turn Focus Flip on; no idle is ever
// sent and no timer runs.
import type { FlipDelays } from './flip-settings';

export type FlipActivity = 'key' | 'scroll' | 'click';
type Group = 'write' | 'read';

export type IdleMessage =
  /** First event of a burst (pair learning only). */
  | { type: 'activity'; what: FlipActivity; ts: number }
  /** Quiet for the delay; `ts` is the real last event, not the moment the timer fired. */
  | { type: 'activity_idle'; what: FlipActivity; ts: number };

/** While Focus Flip is off, typing is announced at most this often (pair detection only). */
export const LEARN_PING_MS = 3000;

export interface IdleTrackerOptions {
  enabled: () => boolean;
  delays: () => FlipDelays;
  send: (message: IdleMessage) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface IdleTracker {
  activity(what: FlipActivity): void;
  /** Drops every pending idle: toggled off, tab hidden, extension reloaded. */
  clear(): void;
}

export function createIdleTracker(opts: IdleTrackerOptions): IdleTracker {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const timers: Partial<Record<Group, unknown>> = {};
  const last: Partial<Record<Group, { what: FlipActivity; ts: number }>> = {};
  let lastLearnPing: number | undefined;

  function clear(): void {
    lastLearnPing = undefined;
    for (const g of ['write', 'read'] as Group[]) {
      if (timers[g] !== undefined) clearTimer(timers[g]);
      timers[g] = undefined;
      last[g] = undefined;
    }
  }

  function activity(what: FlipActivity): void {
    if (!opts.enabled()) {
      // Detection only: typing is what marks the writing tab. Scrolling and clicking tell us nothing here.
      if (what !== 'key') return;
      const t = now();
      if (lastLearnPing !== undefined && t - lastLearnPing < LEARN_PING_MS) return;
      lastLearnPing = t;
      opts.send({ type: 'activity', what, ts: t });
      return;
    }
    const group: Group = what === 'key' ? 'write' : 'read';
    const ts = now();
    const burstStart = timers[group] === undefined;
    last[group] = { what, ts };
    if (burstStart) opts.send({ type: 'activity', what, ts });
    if (timers[group] !== undefined) clearTimer(timers[group]);
    const d = opts.delays();
    timers[group] = setTimer(() => {
      timers[group] = undefined;
      const l = last[group];
      last[group] = undefined;
      if (opts.enabled() && l) opts.send({ type: 'activity_idle', what: l.what, ts: l.ts });
    }, group === 'write' ? d.writeMs : d.readMs);
  }

  return { activity, clear };
}
