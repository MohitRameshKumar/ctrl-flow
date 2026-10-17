import { expect, test } from '@playwright/test';
import { callHook, closeExtension, debugPageUrl, FIXTURES_ORIGIN, launchExtension, sidePanelUrl, type ExtensionHandle } from './helpers';

interface RitualRow {
  id: number;
  seriesKey: string;
  status: string;
  urls: Array<{ url: string; occurrences: number }>;
}

let ext: ExtensionHandle;

test.beforeAll(async () => {
  ext = await launchExtension();
});
test.afterAll(async () => {
  await closeExtension(ext);
});
test.beforeEach(async () => {
  await callHook(ext.sw, 'clearAllTables');
  await callHook(ext.sw, 'setPaused', false);
  await callHook(ext.sw, 'setDemoMode', true);
});

const rituals = () => callHook<RitualRow[]>(ext.sw, 'readTable', 'rituals');

test('debug "Simulate 2 past Team syncs" yields a suggested ritual, "Test now" notifies, and its button opens the tab group; wipe removes it', async () => {
  const docA = await ext.context.newPage();
  await docA.goto(`${FIXTURES_ORIGIN}/test-page.html`);
  const docB = await ext.context.newPage();
  await docB.goto(`${FIXTURES_ORIGIN}/second-page.html`);

  const debug = await ext.context.newPage();
  await debug.goto(debugPageUrl(ext.extensionId));
  await debug.click('button:text("Simulate 2 past Team syncs")');
  await expect(debug.locator('text=ritual(s) now exist')).toBeVisible({ timeout: 10000 });

  const created = (await rituals()).find((r) => r.seriesKey === 'team sync');
  expect(created?.status).toBe('suggested');
  const urls = created!.urls.map((u) => u.url);
  expect(urls).toContain(`${FIXTURES_ORIGIN}/test-page.html`);
  expect(urls).toContain(`${FIXTURES_ORIGIN}/second-page.html`);
  expect(created!.urls.every((u) => u.occurrences === 2)).toBe(true);

  // Synthetic data is clearly marked.
  const events = await callHook<Array<{ synthetic?: boolean; kind: string }>>(ext.sw, 'readTable', 'events');
  expect(events.some((e) => e.synthetic === true && e.kind === 'tab_opened')).toBe(true);

  // Side panel: ritual is listed; "Test now" fires the notification, whose button opens the group.
  const panel = await ext.context.newPage();
  await panel.goto(sidePanelUrl(ext.extensionId));
  await expect(panel.locator('.ritual-title', { hasText: 'Team sync' })).toBeVisible({ timeout: 10000 });
  await ext.sw.evaluate(() => chrome.notifications.getAll().then((all) => Promise.all(Object.keys(all).map((id) => chrome.notifications.clear(id)))));
  await panel.click('button:text("Test now")');
  // "Test now" runs in the panel's own context; chrome.notifications.getAll() is global.
  await expect
    .poll(async () => Object.keys(await ext.sw.evaluate(() => chrome.notifications.getAll())))
    .toContain(`cadence-ritual:${created!.id}`);

  await callHook(ext.sw, 'callNotificationButtonClicked', `cadence-ritual:${created!.id}`, 0);
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  const groups = await ext.sw.evaluate(() => chrome.tabGroups.query({}));
  const group = groups.find((g) => g.title === 'Team sync');
  expect(group).toBeTruthy();

  // One-click wipe.
  await debug.bringToFront();
  await debug.click('button:text("Wipe simulated data")');
  await expect(debug.locator('text=were removed')).toBeVisible({ timeout: 10000 });
  expect((await rituals()).find((r) => r.seriesKey === 'team sync')).toBeUndefined();
  const after = await callHook<Array<{ synthetic?: boolean }>>(ext.sw, 'readTable', 'events');
  expect(after.some((e) => e.synthetic === true)).toBe(false);
});
