import { expect, test } from '@playwright/test';
import { callHook, closeExtension, launchExtension, sidePanelUrl, type ExtensionHandle } from './helpers';

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
});

test('renders four tabs', async () => {
  const page = await ext.context.newPage();
  await page.goto(sidePanelUrl(ext.extensionId));
  await expect(page.getByRole('button', { name: 'Rituals' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Spaces' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Macros' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Standup' })).toBeVisible();
  await page.close();
});

test('event count updates as events are seeded', async () => {
  const page = await ext.context.newPage();
  await page.goto(sidePanelUrl(ext.extensionId));

  // Opening the side panel as a tab itself generates tab_opened/tab_activated/navigated
  // events (correct collector behavior) — so read the live baseline rather than assuming 0.
  const before = await callHook<Array<unknown>>(ext.sw, 'readTable', 'events');

  await callHook(ext.sw, 'seedEvents', [{ ts: Date.now(), kind: 'click', selector: '#x' }]);
  await expect(page.locator('.today-count')).toHaveText(`${before.length + 1} events today`, { timeout: 10000 });

  await page.close();
});

test('pause toggle writes the stored flag', async () => {
  const page = await ext.context.newPage();
  await page.goto(sidePanelUrl(ext.extensionId));

  const pauseButton = page.getByRole('button', { name: /^Pause$/ });
  await pauseButton.click();

  const stored = await ext.sw.evaluate(async () => {
    const { paused } = await chrome.storage.local.get('paused');
    return paused;
  });
  expect(stored).toBe(true);

  await page.close();
});
