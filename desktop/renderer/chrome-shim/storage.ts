/**
 * `chrome.storage.local`, `chrome.storage.session`, and `chrome.storage.onChanged`.
 *
 * This is the busiest part of the shim — ~115 call sites, and `storage.onChanged` is the whole
 * panel-to-worker reactivity model in this codebase.
 *
 * **Read-through cache.** The authoritative store lives in the main process, but `get` is on genuine
 * hot paths (`isPaused()` runs on every recorded event), and an IPC round trip per read would show
 * up under load. So the renderer keeps a mirror, primed once at install and kept coherent by the
 * same `onChanged` broadcast the listeners use. Writes update the mirror optimistically before the
 * IPC completes, so a `get` immediately following a `set` cannot read stale.
 *
 * **Changes echo to the writer.** Chrome fires `onChanged` in the context that performed the write,
 * and this codebase depends on that: `App.tsx`'s `togglePause()` writes `paused` and relies on its
 * own listener to re-render. The main process broadcasts to every window including the sender, so
 * that falls out naturally — but it is load-bearing, not incidental.
 */

import type { StorageArea, StorageChange, StorageChangedPayload } from '../../shared/ipc';
import type { CadenceNative } from '../../preload';
import { ShimEvent } from './events';

type Bag = Record<string, unknown>;

export type OnChangedListener = (
  changes: Record<string, StorageChange>,
  areaName: string,
) => void;

const mirror: Record<StorageArea, Bag> = { local: {}, session: {} };

export const onChanged = new ShimEvent<OnChangedListener>();

function applyToMirror(area: StorageArea, changes: Record<string, StorageChange>): void {
  const bag = mirror[area];
  for (const [key, change] of Object.entries(changes)) {
    if (change.newValue === undefined) delete bag[key];
    else bag[key] = change.newValue;
  }
}

function readMirror(area: StorageArea, keys: string | string[] | null | undefined): Bag {
  const bag = mirror[area];
  if (keys === null || keys === undefined) return { ...bag };
  const wanted = typeof keys === 'string' ? [keys] : keys;
  const out: Bag = {};
  for (const key of wanted) {
    if (key in bag) out[key] = bag[key];
  }
  return out;
}

/**
 * One storage area.
 *
 * Only the `string` and `string[]` argument forms are used anywhere in this codebase (verified
 * across all 115 call sites), but `null` for "everything" is free to support and `lib/db.ts`-style
 * debugging benefits from it.
 */
function makeArea(area: StorageArea, native: CadenceNative) {
  return {
    async get(keys?: string | string[] | null): Promise<Bag> {
      return readMirror(area, keys);
    },

    async set(items: Bag): Promise<void> {
      const changes: Record<string, StorageChange> = {};
      for (const [key, newValue] of Object.entries(items)) {
        changes[key] = { oldValue: mirror[area][key], newValue };
      }
      // Optimistic: a get() issued before the broadcast lands must still see this write.
      applyToMirror(area, changes);
      await native.storage.set(area, items);
    },

    async remove(keys: string | string[]): Promise<void> {
      const wanted = typeof keys === 'string' ? [keys] : keys;
      const changes: Record<string, StorageChange> = {};
      for (const key of wanted) {
        if (!(key in mirror[area])) continue;
        changes[key] = { oldValue: mirror[area][key], newValue: undefined };
      }
      applyToMirror(area, changes);
      await native.storage.remove(area, keys);
    },

    async clear(): Promise<void> {
      applyToMirror(
        area,
        Object.fromEntries(
          Object.keys(mirror[area]).map((k) => [k, { oldValue: mirror[area][k], newValue: undefined }]),
        ),
      );
      await native.storage.clear(area);
    },
  };
}

export interface StorageShim {
  local: ReturnType<typeof makeArea>;
  session: ReturnType<typeof makeArea>;
  onChanged: ShimEvent<OnChangedListener>;
}

/** Primes the mirror, then wires the broadcast. Must be awaited before any `lib/` code runs. */
export async function createStorage(native: CadenceNative): Promise<StorageShim> {
  const [localBag, sessionBag] = await Promise.all([
    native.storage.get('local', null),
    native.storage.get('session', null),
  ]);
  mirror.local = { ...localBag };
  mirror.session = { ...sessionBag };

  native.storage.onChanged((payload: StorageChangedPayload) => {
    applyToMirror(payload.area, payload.changes);
    onChanged.emit(payload.changes, payload.area);
  });

  return {
    local: makeArea('local', native),
    session: makeArea('session', native),
    onChanged,
  };
}

/** Test seam: lets unit tests drive the mirror without Electron. */
export const __test = { mirror, applyToMirror, readMirror };
