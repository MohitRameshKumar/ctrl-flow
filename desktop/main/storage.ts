/**
 * `chrome.storage.local` and `chrome.storage.session`, in the main process.
 *
 * Why main and not the renderer: the session store has to be wiped when the *browser* restarts
 * (see SESSION_IS_CLEARED_ON_BROWSER_RESTART in ../shared/ipc.ts), and the main process is the only
 * thing that knows Chrome relaunched. Keeping it here also means a renderer reload cannot lose it.
 *
 * `local` is a single JSON file. The whole store is small — settings, letter assignments, throttle
 * timestamps, the last AI request — and everything bulky (events, macros, spaces) lives in Dexie.
 */

import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StorageArea, StorageChange } from '../shared/ipc';

type Store = Record<string, unknown>;

const WRITE_DEBOUNCE_MS = 150;

let localPath = '';
const local: Store = {};
const session: Store = {};

const subscribers = new Set<(area: StorageArea, changes: Record<string, StorageChange>) => void>();

let writeTimer: NodeJS.Timeout | null = null;

function areaStore(area: StorageArea): Store {
  return area === 'session' ? session : local;
}

/** Atomic enough: write a sibling temp file, then rename over the target. */
function flushLocal(): void {
  writeTimer = null;
  try {
    mkdirSync(dirname(localPath), { recursive: true });
    const tmp = `${localPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(local), 'utf8');
    renameSync(tmp, localPath);
  } catch (err) {
    console.error('[cadence] could not persist storage.local', err);
  }
}

function scheduleFlush(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(flushLocal, WRITE_DEBOUNCE_MS);
}

export function initStorage(): void {
  localPath = join(app.getPath('userData'), 'storage-local.json');
  try {
    const raw = readFileSync(localPath, 'utf8');
    const parsed = JSON.parse(raw) as Store;
    if (parsed && typeof parsed === 'object') Object.assign(local, parsed);
  } catch {
    /* first run, or a corrupt file we deliberately ignore rather than crash on */
  }
  // The app just started, so by definition no browser session is in flight.
  clearSession();
}

/**
 * Wipe the session area.
 *
 * Called on app start and on every Chrome launch/relaunch. See the comment on
 * SESSION_IS_CLEARED_ON_BROWSER_RESTART for why a stale `macroReplayInProgress` or
 * `activeTabsSeeded` is not a cosmetic problem.
 */
export function clearSession(): void {
  const changes: Record<string, StorageChange> = {};
  for (const key of Object.keys(session)) {
    changes[key] = { oldValue: session[key], newValue: undefined };
    delete session[key];
  }
  if (Object.keys(changes).length > 0) emit('session', changes);
}

export function subscribe(
  fn: (area: StorageArea, changes: Record<string, StorageChange>) => void,
): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit(area: StorageArea, changes: Record<string, StorageChange>): void {
  for (const fn of [...subscribers]) {
    try {
      fn(area, changes);
    } catch (err) {
      console.error('[cadence] storage subscriber threw', err);
    }
  }
}

/** `null`/`undefined` keys means "everything", matching `chrome.storage`. */
export function get(area: StorageArea, keys: string | string[] | null | undefined): Store {
  const store = areaStore(area);
  if (keys === null || keys === undefined) return { ...store };
  const wanted = typeof keys === 'string' ? [keys] : keys;
  const out: Store = {};
  for (const key of wanted) {
    if (key in store) out[key] = store[key];
  }
  return out;
}

export function set(area: StorageArea, items: Store): void {
  const store = areaStore(area);
  const changes: Record<string, StorageChange> = {};
  for (const [key, newValue] of Object.entries(items)) {
    const oldValue = store[key];
    // Chrome fires onChanged on every set, even an identical one. Several call sites in this
    // codebase use a repeated write as a "poke" (the leader panel hand-off, the palette request),
    // so deliberately do not diff here.
    store[key] = newValue;
    changes[key] = { oldValue, newValue };
  }
  if (area === 'local') scheduleFlush();
  if (Object.keys(changes).length > 0) emit(area, changes);
}

export function remove(area: StorageArea, keys: string | string[]): void {
  const store = areaStore(area);
  const wanted = typeof keys === 'string' ? [keys] : keys;
  const changes: Record<string, StorageChange> = {};
  for (const key of wanted) {
    if (!(key in store)) continue;
    changes[key] = { oldValue: store[key], newValue: undefined };
    delete store[key];
  }
  if (area === 'local') scheduleFlush();
  if (Object.keys(changes).length > 0) emit(area, changes);
}

export function clear(area: StorageArea): void {
  const store = areaStore(area);
  remove(area, Object.keys(store));
}

/** Persist immediately — used on quit, where a debounced write would be lost. */
export function flushNow(): void {
  if (writeTimer) clearTimeout(writeTimer);
  flushLocal();
}
