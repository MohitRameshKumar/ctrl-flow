import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callHook, EXTENSION_PATH } from './helpers';

/** Launches a fresh context against a given (possibly pre-existing) profile dir, waiting for
 * the service worker the same way helpers.launchExtension does. */
async function launchAgainst(profileDir: string) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return { context, sw };
}

test('data survives closing and relaunching the context against the same profile, and new events still log', async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-persist-'));

  const first = await launchAgainst(profileDir);
  await callHook(first.sw, 'clearAllTables');
  await callHook(first.sw, 'seedEvents', [{ ts: Date.now(), kind: 'click', selector: '#before-restart' }]);

  const beforeClose = await callHook<unknown[]>(first.sw, 'readTable', 'events');
  expect(beforeClose.length).toBe(1);

  // Simulates "stop the service worker" — the SW's in-memory state (there is none that
  // matters, by design) is gone; what's left is only what IndexedDB/chrome.storage persisted.
  await first.context.close();

  const second = await launchAgainst(profileDir);
  const afterRelaunch = await callHook<Array<{ selector?: string }>>(second.sw, 'readTable', 'events');
  expect(afterRelaunch.some((e) => e.selector === '#before-restart')).toBe(true);

  // New activity must still log after the relaunch — the top-level listener registration
  // pattern (no state that matters kept in memory) is what makes this reliable in real MV3.
  await callHook(second.sw, 'seedEvents', [{ ts: Date.now(), kind: 'click', selector: '#after-restart' }]);
  const afterNewEvent = await callHook<Array<{ selector?: string }>>(second.sw, 'readTable', 'events');
  expect(afterNewEvent.some((e) => e.selector === '#after-restart')).toBe(true);
  expect(afterNewEvent.length).toBe(2);

  await second.context.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});
