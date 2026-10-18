// The storage shim is the load-bearing piece of the desktop port: ~115 call sites go through it,
// and `chrome.storage.onChanged` is the whole panel<->background reactivity model. These are the
// behaviours that are easy to get subtly wrong and impossible to notice until a feature misbehaves.
import { beforeEach, expect, it, vi } from 'vitest';
import { createStorage, __test } from '@/desktop/renderer/chrome-shim/storage';
import type { CadenceNative } from '@/desktop/preload';
import type { StorageChangedPayload } from '@/desktop/shared/ipc';

type Listener = (payload: StorageChangedPayload) => void;

/** A fake main process: holds the authoritative store and broadcasts changes back, as Electron does. */
function fakeNative(seed: { local?: Record<string, unknown>; session?: Record<string, unknown> } = {}) {
  const store = {
    local: { ...(seed.local ?? {}) } as Record<string, unknown>,
    session: { ...(seed.session ?? {}) } as Record<string, unknown>,
  };
  const listeners: Listener[] = [];

  const broadcast = (area: 'local' | 'session', changes: StorageChangedPayload['changes']) => {
    for (const fn of [...listeners]) fn({ area, changes });
  };

  const native = {
    storage: {
      get: vi.fn(async (area: 'local' | 'session', keys: string | string[] | null) => {
        if (keys === null) return { ...store[area] };
        const wanted = typeof keys === 'string' ? [keys] : keys;
        const out: Record<string, unknown> = {};
        for (const k of wanted) if (k in store[area]) out[k] = store[area][k];
        return out;
      }),
      set: vi.fn(async (area: 'local' | 'session', items: Record<string, unknown>) => {
        const changes: StorageChangedPayload['changes'] = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: store[area][k], newValue: v };
          store[area][k] = v;
        }
        broadcast(area, changes);
      }),
      remove: vi.fn(async (area: 'local' | 'session', keys: string | string[]) => {
        const wanted = typeof keys === 'string' ? [keys] : keys;
        const changes: StorageChangedPayload['changes'] = {};
        for (const k of wanted) {
          if (!(k in store[area])) continue;
          changes[k] = { oldValue: store[area][k], newValue: undefined };
          delete store[area][k];
        }
        broadcast(area, changes);
      }),
      clear: vi.fn(async () => {}),
      onChanged: (cb: Listener) => {
        listeners.push(cb);
        return () => listeners.splice(listeners.indexOf(cb), 1);
      },
    },
  } as unknown as CadenceNative;

  return { native, store, broadcast };
}

beforeEach(() => {
  __test.mirror.local = {};
  __test.mirror.session = {};
});

it('primes both areas from the main process so the first read is not empty', async () => {
  const { native } = fakeNative({ local: { paused: true }, session: { macroRun: { id: 'r1' } } });
  const storage = await createStorage(native);

  expect(await storage.local.get('paused')).toEqual({ paused: true });
  expect(await storage.session.get('macroRun')).toEqual({ macroRun: { id: 'r1' } });
});

it('supports the string, array and null key forms', async () => {
  const { native } = fakeNative({ local: { a: 1, b: 2, c: 3 } });
  const storage = await createStorage(native);

  expect(await storage.local.get('a')).toEqual({ a: 1 });
  expect(await storage.local.get(['a', 'c'])).toEqual({ a: 1, c: 3 });
  expect(await storage.local.get(null)).toEqual({ a: 1, b: 2, c: 3 });
});

it('omits missing keys entirely rather than returning undefined values', async () => {
  // `lib/settings.ts` and friends rely on `key in result` / `?? default` semantics.
  const { native } = fakeNative({ local: { a: 1 } });
  const storage = await createStorage(native);

  const got = await storage.local.get(['a', 'nope']);
  expect(got).toEqual({ a: 1 });
  expect('nope' in got).toBe(false);
});

it('reads its own write back immediately, before the broadcast lands', async () => {
  // Without the optimistic mirror update, code that sets then immediately gets — which this
  // codebase does in several throttle paths — would read a stale value.
  const { native } = fakeNative();
  const storage = await createStorage(native);

  const setPromise = storage.local.set({ demoMode: false });
  expect(await storage.local.get('demoMode')).toEqual({ demoMode: false });
  await setPromise;
});

it('fires onChanged in the writing context, with the area name', async () => {
  // App.tsx's togglePause() writes `paused` and relies on its *own* onChanged listener to
  // re-render. If the shim only notified other contexts, the pause button would appear dead.
  const { native } = fakeNative({ local: { paused: false } });
  const storage = await createStorage(native);

  const seen: { changes: Record<string, unknown>; area: string }[] = [];
  storage.onChanged.addListener((changes, area) => seen.push({ changes, area }));

  await storage.local.set({ paused: true });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.area).toBe('local');
  expect(seen[0]?.changes).toEqual({ paused: { oldValue: false, newValue: true } });
});

it('reports the right area for session writes', async () => {
  // The panel branches on `area === 'session'` to decide whether to consume a palette request.
  const { native } = fakeNative();
  const storage = await createStorage(native);

  const areas: string[] = [];
  storage.onChanged.addListener((_c, area) => areas.push(area));

  await storage.session.set({ macroPaletteRequest: { ts: 1 } });
  await storage.local.set({ paused: true });

  expect(areas).toEqual(['session', 'local']);
});

it('fires onChanged even when the value is unchanged', async () => {
  // Several flows use a repeated identical write as a "poke" (the leader panel hand-off writes a
  // timestamp key the panel watches). Diffing writes away would break them.
  const { native } = fakeNative({ local: { leaderPanelAt: 5 } });
  const storage = await createStorage(native);

  let count = 0;
  storage.onChanged.addListener(() => count++);

  await storage.local.set({ leaderPanelAt: 5 });
  expect(count).toBe(1);
});

it('removes keys and reports undefined as the new value', async () => {
  const { native } = fakeNative({ session: { macroRun: { id: 'r1' } } });
  const storage = await createStorage(native);

  const seen: Record<string, { oldValue?: unknown; newValue?: unknown }>[] = [];
  storage.onChanged.addListener((changes) => seen.push(changes));

  await storage.session.remove('macroRun');

  expect(await storage.session.get('macroRun')).toEqual({});
  expect(seen[0]).toEqual({ macroRun: { oldValue: { id: 'r1' }, newValue: undefined } });
});

it('applies changes broadcast by another context to the local mirror', async () => {
  // The debug window and the overlay are separate renderers; a write there must be visible here.
  const { native, broadcast } = fakeNative({ local: { paused: false } });
  const storage = await createStorage(native);

  broadcast('local', { paused: { oldValue: false, newValue: true } });

  expect(await storage.local.get('paused')).toEqual({ paused: true });
});

it('does not round-trip to the main process on every read', async () => {
  // isPaused() runs on every recorded event; an IPC hop per read would show up under load.
  const { native } = fakeNative({ local: { paused: true } });
  const storage = await createStorage(native);
  const callsAfterPrime = (native.storage.get as ReturnType<typeof vi.fn>).mock.calls.length;

  for (let i = 0; i < 50; i++) await storage.local.get('paused');

  expect((native.storage.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterPrime);
});
