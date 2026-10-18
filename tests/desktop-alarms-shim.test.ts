// Alarms drive every recompute (rituals 15m, macros 20m, spaces 30m, switch check 1m) plus the
// Focus Flip return. On desktop they are plain timers, which removes MV3's 30-second clamp —
// `lib/macros.ts` has a comment explaining it had to avoid alarms for its 10s countdown because
// of that clamp.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAlarmsShim, __test } from '@/desktop/renderer/chrome-shim/alarms';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const name of [...__test.entries.keys()]) __test.cancel(name);
  vi.useRealTimers();
});

it('fires a one-shot alarm at the requested time', async () => {
  const alarms = createAlarmsShim();
  const fired: string[] = [];
  alarms.onAlarm.addListener((a) => fired.push(a.name));

  await alarms.create('once', { when: Date.now() + 5_000 });

  vi.advanceTimersByTime(4_999);
  expect(fired).toEqual([]);
  vi.advanceTimersByTime(2);
  expect(fired).toEqual(['once']);
});

it('honours sub-30-second delays, unlike MV3', async () => {
  const alarms = createAlarmsShim();
  const fired: string[] = [];
  alarms.onAlarm.addListener((a) => fired.push(a.name));

  await alarms.create('soon', { when: Date.now() + 800 });
  vi.advanceTimersByTime(900);

  expect(fired).toEqual(['soon']);
});

it('repeats a periodic alarm', async () => {
  const alarms = createAlarmsShim();
  let count = 0;
  alarms.onAlarm.addListener((a) => {
    if (a.name === 'tick') count++;
  });

  await alarms.create('tick', { periodInMinutes: 1 });

  vi.advanceTimersByTime(60_000 * 3 + 100);
  expect(count).toBe(3);
});

it('drops a one-shot alarm from getAll once it has fired', async () => {
  const alarms = createAlarmsShim();
  await alarms.create('once', { when: Date.now() + 1_000 });
  expect(await alarms.get('once')).toBeDefined();

  vi.advanceTimersByTime(1_100);

  expect(await alarms.get('once')).toBeUndefined();
  expect(await alarms.getAll()).toEqual([]);
});

it('keeps a periodic alarm listed between firings', async () => {
  const alarms = createAlarmsShim();
  await alarms.create('tick', { periodInMinutes: 1 });
  vi.advanceTimersByTime(60_000 + 100);

  const all = await alarms.getAll();
  expect(all.map((a) => a.name)).toEqual(['tick']);
});

it('getAll lists every alarm, which is how stale ritual triggers are cleared', async () => {
  // lib/rituals.ts enumerates alarms to clear `cadence-ritual-trigger-*` leftovers.
  const alarms = createAlarmsShim();
  await alarms.create('cadence-ritual-trigger-1', { when: Date.now() + 10_000 });
  await alarms.create('cadence-ritual-trigger-2', { when: Date.now() + 20_000 });
  await alarms.create('other', { periodInMinutes: 5 });

  const names = (await alarms.getAll()).map((a) => a.name).sort();
  expect(names).toEqual(['cadence-ritual-trigger-1', 'cadence-ritual-trigger-2', 'other']);
});

it('clear stops an alarm from firing and reports whether it existed', async () => {
  const alarms = createAlarmsShim();
  const fired: string[] = [];
  alarms.onAlarm.addListener((a) => fired.push(a.name));

  await alarms.create('doomed', { when: Date.now() + 1_000 });
  expect(await alarms.clear('doomed')).toBe(true);
  expect(await alarms.clear('doomed')).toBe(false);

  vi.advanceTimersByTime(2_000);
  expect(fired).toEqual([]);
});

it('re-creating an alarm replaces the previous schedule', async () => {
  // armAlarms() runs on every startup; a duplicate would double every recompute.
  const alarms = createAlarmsShim();
  let count = 0;
  alarms.onAlarm.addListener(() => count++);

  await alarms.create('dup', { when: Date.now() + 1_000 });
  await alarms.create('dup', { when: Date.now() + 1_000 });

  vi.advanceTimersByTime(1_500);
  expect(count).toBe(1);
  expect(await alarms.getAll()).toHaveLength(0);
});

it('clearAll removes everything', async () => {
  const alarms = createAlarmsShim();
  await alarms.create('a', { periodInMinutes: 1 });
  await alarms.create('b', { when: Date.now() + 1_000 });

  expect(await alarms.clearAll()).toBe(true);
  expect(await alarms.getAll()).toEqual([]);
});

it('isolates listeners so one throwing cannot stop the others', async () => {
  // The collector, Focus Flip and switch detection all listen independently.
  const alarms = createAlarmsShim();
  const reached: string[] = [];
  alarms.onAlarm.addListener(() => {
    throw new Error('boom');
  });
  alarms.onAlarm.addListener(() => reached.push('second'));

  vi.spyOn(console, 'error').mockImplementation(() => {});
  await alarms.create('x', { when: Date.now() + 100 });
  vi.advanceTimersByTime(200);

  expect(reached).toEqual(['second']);
});
