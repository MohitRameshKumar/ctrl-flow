/**
 * A `chrome` just large enough for `entrypoints/content.ts` to run inside a real web page.
 *
 * This exists so the collector is **reused, not forked**. `content.ts` is 300 lines of
 * privacy-sensitive logic — sensitive-field detection, label trimming to 40 chars, frame-origin
 * handling — and a desktop copy of it would drift from the extension's copy in exactly the places
 * where drift is most damaging.
 *
 * Its entire outbound surface is four members:
 *   - `runtime.sendMessage`  → the CDP binding
 *   - `runtime.id`           → must be truthy, or `content-guard.ts` tears the script down
 *   - `storage.local.get('focusFlipEnabled')`
 *   - `storage.onChanged`    → so toggling Focus Flip takes effect without a reload
 */

const BINDING = '__cadenceSend';

export interface PageChromeOptions {
  /** Settings the page needs at injection time, so the first read does not need a round trip. */
  initialStorage: Record<string, unknown>;
}

type StorageListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

export function installPageChrome(options: PageChromeOptions): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.chrome && (g.chrome as { __cadence?: boolean }).__cadence) return; // already installed

  const local: Record<string, unknown> = { ...options.initialStorage };
  const listeners: StorageListener[] = [];

  const send = (payload: unknown): void => {
    const binding = g[BINDING] as ((s: string) => void) | undefined;
    if (typeof binding !== 'function') return;
    try {
      binding(JSON.stringify(payload));
    } catch {
      /* the page is unloading, or the binding was torn down */
    }
  };

  const chrome = {
    __cadence: true,

    runtime: {
      // `content-guard.ts`'s runtimeAlive() checks this; a falsy id tears the collector down.
      id: 'cadence-desktop',
      sendMessage: (message: unknown) => {
        send({ channel: 'runtime', message });
        // content.ts calls `.catch()` on the result, so it must be a promise.
        return Promise.resolve();
      },
      onMessage: {
        addListener: () => {},
        removeListener: () => {},
      },
    },

    storage: {
      local: {
        get: (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const key of wanted) if (key in local) out[key] = local[key];
          return Promise.resolve(out);
        },
        set: (items: Record<string, unknown>) => {
          Object.assign(local, items);
          send({ channel: 'storage-set', items });
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (fn: StorageListener) => listeners.push(fn),
        removeListener: (fn: StorageListener) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
  };

  g.chrome = chrome;

  /**
   * Pushed from the main process when watched settings change.
   *
   * Without this, turning Focus Flip on would not reach pages that were already open — the
   * collector would keep suppressing its activity pulses until every tab was reloaded.
   */
  g.__cadenceStorageChanged = (json: string): void => {
    let payload: { changes: Record<string, { oldValue?: unknown; newValue?: unknown }>; area: string };
    try {
      payload = JSON.parse(json);
    } catch {
      return;
    }
    for (const [key, change] of Object.entries(payload.changes)) {
      if (change.newValue === undefined) delete local[key];
      else local[key] = change.newValue;
    }
    for (const fn of [...listeners]) {
      try {
        fn(payload.changes, payload.area);
      } catch {
        /* a listener in a dying page */
      }
    }
  };
}
