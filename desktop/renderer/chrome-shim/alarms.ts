/**
 * `chrome.alarms`, backed by plain timers in the core renderer.
 *
 * This is one of the places the desktop app is strictly better than the extension. MV3 alarms are
 * clamped to a 30-second minimum — `lib/macros.ts` has a comment explaining that it had to use
 * `setTimeout` instead of an alarm for its 10-second auto-run countdown because of exactly that.
 * Here there is no clamp and no service worker to be evicted mid-interval.
 *
 * Alarms are in-memory, which differs from Chrome's persist-across-restart behaviour. That is fine
 * because every alarm this codebase creates is re-armed on startup: `background.ts` calls
 * `armAlarms()` from its main, and the one-shot ritual triggers are re-created by the 15-minute
 * ritual recompute.
 */

import { ShimEvent } from './events';

export interface ShimAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

interface Entry {
  alarm: ShimAlarm;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
  repeating: boolean;
}

const entries = new Map<string, Entry>();

export const onAlarm = new ShimEvent<(alarm: ShimAlarm) => void>();

function cancel(name: string): void {
  const entry = entries.get(name);
  if (!entry) return;
  if (entry.repeating) clearInterval(entry.timer as ReturnType<typeof setInterval>);
  else clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
  entries.delete(name);
}

export interface AlarmCreateInfo {
  when?: number;
  delayInMinutes?: number;
  periodInMinutes?: number;
}

function create(name: string, info: AlarmCreateInfo = {}): void {
  cancel(name);

  const { when, delayInMinutes, periodInMinutes } = info;

  if (periodInMinutes !== undefined) {
    const periodMs = Math.max(periodInMinutes * 60_000, 1_000);
    const firstDelay =
      when !== undefined
        ? Math.max(when - Date.now(), 0)
        : delayInMinutes !== undefined
          ? Math.max(delayInMinutes * 60_000, 0)
          : periodMs;

    // A period with a different first delay needs a timeout that then installs the interval.
    const startRepeating = () => {
      const timer = setInterval(() => {
        const entry = entries.get(name);
        if (!entry) return;
        entry.alarm.scheduledTime = Date.now() + periodMs;
        onAlarm.emit(entry.alarm);
      }, periodMs);
      entries.set(name, {
        alarm: { name, scheduledTime: Date.now() + periodMs, periodInMinutes },
        timer,
        repeating: true,
      });
    };

    if (firstDelay === periodMs) {
      startRepeating();
    } else {
      const timer = setTimeout(() => {
        onAlarm.emit({ name, scheduledTime: Date.now(), periodInMinutes });
        startRepeating();
      }, firstDelay);
      entries.set(name, {
        alarm: { name, scheduledTime: Date.now() + firstDelay, periodInMinutes },
        timer,
        repeating: false,
      });
    }
    return;
  }

  const delay =
    when !== undefined
      ? Math.max(when - Date.now(), 0)
      : Math.max((delayInMinutes ?? 0) * 60_000, 0);

  const timer = setTimeout(() => {
    entries.delete(name);
    onAlarm.emit({ name, scheduledTime: Date.now() });
  }, delay);

  entries.set(name, { alarm: { name, scheduledTime: Date.now() + delay }, timer, repeating: false });
}

export function createAlarmsShim() {
  return {
    create(name: string, info?: AlarmCreateInfo): Promise<void> {
      create(name, info);
      return Promise.resolve();
    },

    get(name: string): Promise<ShimAlarm | undefined> {
      return Promise.resolve(entries.get(name)?.alarm);
    },

    /** `lib/rituals.ts` uses this to clear stale `cadence-ritual-trigger-*` alarms. */
    getAll(): Promise<ShimAlarm[]> {
      return Promise.resolve([...entries.values()].map((e) => e.alarm));
    },

    clear(name: string): Promise<boolean> {
      const existed = entries.has(name);
      cancel(name);
      return Promise.resolve(existed);
    },

    clearAll(): Promise<boolean> {
      const existed = entries.size > 0;
      for (const name of [...entries.keys()]) cancel(name);
      return Promise.resolve(existed);
    },

    onAlarm,
  };
}

/** Test seam. */
export const __test = { entries, create, cancel };
