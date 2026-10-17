import { expect, test, type Page } from '@playwright/test';
import {
  callHook,
  closeExtension,
  launchExtension,
  MOCK_PROXY_ORIGIN,
  sidePanelUrl,
  type ExtensionHandle,
} from './helpers';

interface SpaceRow {
  id: number;
  name: string;
  status: string;
}
interface SpaceUrlRow {
  id: number;
  spaceId: number;
  url: string;
  title?: string;
  source: string;
  alwaysOpen: boolean;
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
  await fetch(`${MOCK_PROXY_ORIGIN}/__mock/fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
});

async function spaces(): Promise<SpaceRow[]> {
  return callHook<SpaceRow[]>(ext.sw, 'readTable', 'spaces');
}
async function spaceUrls(): Promise<SpaceUrlRow[]> {
  return callHook<SpaceUrlRow[]>(ext.sw, 'readTable', 'spaceUrls');
}

async function stubDomain(page: Page, url: string, body = '<html><body>stub</body></html>') {
  await ext.context.route(`${new URL(url).origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body }),
  );
  await page.goto(url);
}

/** Opens the side panel as a tab — its own mount effect calls recomputeSpaces(). */
async function openSidePanel(): Promise<Page> {
  const page = await ext.context.newPage();
  await page.goto(sidePanelUrl(ext.extensionId));
  return page;
}

test('mock AI returns named spaces, and they appear in the UI', async () => {
  const docsPage = await ext.context.newPage();
  await stubDomain(docsPage, 'https://docs.google.com/document/d/abc');
  const ghPage = await ext.context.newPage();
  await stubDomain(ghPage, 'https://github.com/acme/repo');

  const panel = await openSidePanel();
  await panel.click('button:text("Spaces")');
  await panel.waitForTimeout(1000);

  await expect(panel.locator('.space-name-input').nth(0)).toBeVisible({ timeout: 10000 });
  const names = await panel
    .locator('.space-name-input')
    .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  expect(names.sort()).toEqual(['Club website', 'EE 242 homework']);

  const rows = await spaces();
  expect(rows.every((s) => s.status === 'ai')).toBe(true);

  await docsPage.close();
  await ghPage.close();
  await panel.close();
});

test('when the mock AI fails, domain-fallback spaces appear marked offline', async () => {
  await fetch(`${MOCK_PROXY_ORIGIN}/__mock/fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });

  const page = await ext.context.newPage();
  await stubDomain(page, 'https://fallback-a.test/');

  const panel = await openSidePanel();
  await panel.click('button:text("Spaces")');
  await panel.waitForTimeout(1000);

  await expect(panel.locator('.space-status').first()).toHaveText('auto (offline)', { timeout: 10000 });

  const rows = await spaces();
  expect(rows.some((s) => s.status === 'auto_offline')).toBe(true);

  await page.close();
  await panel.close();
});

test('renaming a space and moving a tab both survive a recompute', async () => {
  const docsPage = await ext.context.newPage();
  await stubDomain(docsPage, 'https://docs.google.com/document/d/abc');
  const ghPage = await ext.context.newPage();
  await stubDomain(ghPage, 'https://github.com/acme/repo');

  const panel = await openSidePanel();
  await panel.click('button:text("Spaces")');
  await expect(panel.locator('.space-name-input').nth(0)).toBeVisible({ timeout: 10000 });

  // Rename the first space.
  const firstNameInput = panel.locator('.space-name-input').nth(0);
  await firstNameInput.fill('My Renamed Space');
  await firstNameInput.blur();
  await panel.waitForTimeout(300);

  // Move the first space's tab to the second space.
  const beforeMove = await spaceUrls();
  const firstSpaceId = (await spaces()).find((s) => s.name === 'My Renamed Space')!.id;
  const otherSpaceId = (await spaces()).find((s) => s.id !== firstSpaceId)!.id;
  const movedUrl = beforeMove.find((u) => u.spaceId === firstSpaceId)!;

  const select = panel.locator('.tab-list select').first();
  await select.selectOption(String(otherSpaceId));
  await panel.waitForTimeout(300);

  // Recompute again — nothing new to assign, so this should be a no-op for existing data.
  await panel.click('button:text("Recompute now")');
  await panel.waitForTimeout(1000);

  const afterSpaces = await spaces();
  const afterUrls = await spaceUrls();
  expect(afterSpaces.some((s) => s.name === 'My Renamed Space')).toBe(true);

  const movedRow = afterUrls.find((u) => u.url === movedUrl.url);
  expect(movedRow?.spaceId).toBe(otherSpaceId);
  expect(movedRow?.source).toBe('user');

  await docsPage.close();
  await ghPage.close();
  await panel.close();
});

interface TabGroupInfo {
  id: number;
  title?: string;
  collapsed: boolean;
}

async function queryTabGroups(): Promise<TabGroupInfo[]> {
  return ext.sw.evaluate(() => chrome.tabGroups.query({}));
}

test('Shelve collapses a space into a named tab group; Restore expands it', async () => {
  const page1 = await ext.context.newPage();
  await stubDomain(page1, 'https://shelve-test.test/one');
  const page2 = await ext.context.newPage();
  await stubDomain(page2, 'https://shelve-test.test/two');

  const panel = await openSidePanel();
  await panel.click('button:text("Spaces")');
  await expect(panel.locator('.space-name-input').nth(0)).toBeVisible({ timeout: 10000 });

  const spaceName = await panel.locator('.space-name-input').nth(0).inputValue();
  expect(spaceName).toBe('shelve-test.test space');

  await panel.locator('.space-card button:text("Shelve")').first().click();
  await panel.waitForTimeout(500);

  let groups = await queryTabGroups();
  let group = groups.find((g) => g.title === spaceName);
  expect(group).toBeTruthy();
  expect(group?.collapsed).toBe(true);

  await panel.locator('.space-card button:text("Restore")').first().click();
  await panel.waitForTimeout(500);

  groups = await queryTabGroups();
  group = groups.find((g) => g.title === spaceName);
  expect(group?.collapsed).toBe(false);

  await page1.close();
  await page2.close();
  await panel.close();
});

async function clearAllNotifications(): Promise<void> {
  const all = await ext.sw.evaluate(() => chrome.notifications.getAll());
  await ext.sw.evaluate((ids) => Promise.all(ids.map((id) => chrome.notifications.clear(id))), Object.keys(all));
}

/** chrome.notifications has no getter for a notification's content once created — only
 * getAll(), which returns {id: true} existence flags. To see what was actually displayed,
 * capture the chrome.notifications.create() call itself. */
async function captureNextNotificationCreate(): Promise<void> {
  await ext.sw.evaluate(() => {
    const original = chrome.notifications.create.bind(chrome.notifications);
    (globalThis as unknown as { __capturedNotification?: unknown }).__capturedNotification = undefined;
    // test-only monkey-patch, restored by the caller
    chrome.notifications.create =(...args: unknown[]) => {
      (globalThis as unknown as { __capturedNotification?: unknown }).__capturedNotification = args;
      // @ts-expect-error
      return original(...args);
    };
  });
}
async function getCapturedNotification(): Promise<[string, chrome.notifications.NotificationOptions] | null> {
  return ext.sw.evaluate(() => (globalThis as unknown as { __capturedNotification?: unknown }).__capturedNotification ?? null) as Promise<
    [string, chrome.notifications.NotificationOptions] | null
  >;
}

// NOTE: Playwright cannot open a real Chrome side panel surface — opening sidepanel.html as a
// tab registers as contextType "TAB", never "SIDE_PANEL" (confirmed via
// chrome.runtime.getContexts() during development). So checkAndOfferSwitch's panel-open branch
// (which writes to chrome.storage.session for the in-panel SuggestionCard) can't be exercised by
// this harness — chrome.runtime.getContexts always reports no side panel open, so the code
// always takes its "closed" branch here. That's a real Playwright limitation, not a product bug;
// this test verifies the branch that *is* reachable: the chrome.notifications path.
test('a switch offer appears after the demo-mode threshold, and the throttle blocks a repeat', async () => {
  const pageA = await ext.context.newPage();
  await stubDomain(pageA, 'https://switch-a.test/');
  const pageB = await ext.context.newPage();
  await stubDomain(pageB, 'https://switch-b.test/');

  const panel = await openSidePanel();
  await panel.click('button:text("Spaces")');
  await expect(panel.locator('.space-name-input').nth(0)).toBeVisible({ timeout: 10000 });
  await panel.close(); // leave no page open so this run exercises the notification branch

  await pageA.bringToFront();
  await pageA.waitForTimeout(200);

  // Simulate having spent 35s (> the 30s demo threshold) actively on space A, without a real wait.
  await callHook(ext.sw, 'seedEvents', [
    { ts: Date.now() - 35000, kind: 'tab_activated', url: 'https://switch-a.test/', title: 'stub' },
  ]);

  await clearAllNotifications();
  await captureNextNotificationCreate();
  await callHook(ext.sw, 'fireAlarm', 'cadence-switch-check');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  const captured = await getCapturedNotification();
  expect(captured).toBeTruthy();
  const [, options] = captured!;
  expect(options.title).toBe('Switch to switch-a.test space?');
  expect(options.message).toContain('switch-b.test space');

  const afterFirstOffer = await ext.sw.evaluate(() => chrome.notifications.getAll());
  expect(Object.keys(afterFirstOffer).length).toBe(1);

  // Throttle: re-fire immediately under the same conditions — it must not create a second
  // notification within the 10-minute throttle window.
  await captureNextNotificationCreate();
  await callHook(ext.sw, 'fireAlarm', 'cadence-switch-check');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  const capturedSecond = await getCapturedNotification();
  expect(capturedSecond).toBeNull();

  const afterThrottledAttempt = await ext.sw.evaluate(() => chrome.notifications.getAll());
  expect(Object.keys(afterThrottledAttempt).length).toBe(1);

  await clearAllNotifications();
  await pageA.close();
  await pageB.close();
});

interface ShelfRow {
  spaceId: number;
  urls: Array<{ url: string; title?: string }>;
}

test('"Close and save" keeps a tab with a recent typing_burst and closes the others', async () => {
  const keepPage = await ext.context.newPage();
  await stubDomain(keepPage, 'https://close-save.test/keep');
  const closePage = await ext.context.newPage();
  await stubDomain(closePage, 'https://close-save.test/close');

  const panel = await openSidePanel();
  await panel.click('button:text("Spaces")');
  await expect(panel.locator('.space-name-input').nth(0)).toBeVisible({ timeout: 10000 });

  const spaceId = (await spaces())[0]!.id;

  const chromeTabs = await ext.sw.evaluate(() => chrome.tabs.query({}));
  // Note: .includes('/close') would also match the "close-save.test" *hostname* (the "/"
  // before "close-save" plus "close" forms that substring) — use endsWith on the path instead.
  const keepTab = chromeTabs.find((t) => t.url?.endsWith('/keep'));
  const closeTab = chromeTabs.find((t) => t.url?.endsWith('/close'));
  expect(keepTab?.id).toBeTruthy();
  expect(closeTab?.id).toBeTruthy();

  await callHook(ext.sw, 'seedEvents', [
    { ts: Date.now(), kind: 'typing_burst', tabId: keepTab!.id, keyCount: 12 },
  ]);

  await panel.locator('.space-card button:text("Close and save")').first().click();
  await panel.waitForTimeout(500);

  const tabsAfter = await ext.sw.evaluate(() => chrome.tabs.query({}));
  expect(tabsAfter.some((t) => t.id === keepTab!.id)).toBe(true);
  expect(tabsAfter.some((t) => t.id === closeTab!.id)).toBe(false);

  const shelves = await callHook<ShelfRow[]>(ext.sw, 'readTable', 'shelves');
  const shelf = shelves.find((s) => s.spaceId === spaceId);
  expect(shelf).toBeTruthy();
  expect(shelf!.urls.map((u) => u.url)).toEqual(['https://close-save.test/close']);

  await keepPage.close();
  await panel.close();
});

// REGRESSION (diagnosed in real-Chrome testing): the switch check only read tab_activated events from
// the trailing 5 minutes. If the user had been sitting on a tab (e.g. typing notes) for longer than
// that, the activation that started the stay fell outside the window, dwell was 0 and no offer fired.
test('a switch offer still fires when the current tab was activated before the 5-minute window', async () => {
  const pageA = await ext.context.newPage();
  await stubDomain(pageA, 'https://long-a.test/');
  const pageB = await ext.context.newPage();
  await stubDomain(pageB, 'https://long-b.test/');

  const panel = await openSidePanel();
  await panel.click('button:text("Spaces")');
  await expect(panel.locator('.space-name-input').nth(0)).toBeVisible({ timeout: 10000 });
  await panel.close();

  await pageA.bringToFront();
  await pageA.waitForTimeout(200);
  await callHook(ext.sw, 'clearTable', 'events');
  await callHook(ext.sw, 'seedEvents', [
    { ts: Date.now() - 8 * 60 * 1000, kind: 'tab_activated', url: 'https://long-a.test/', title: 'stub' },
  ]);

  await clearAllNotifications();
  await captureNextNotificationCreate();
  await callHook(ext.sw, 'fireAlarm', 'cadence-switch-check');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  const captured = await getCapturedNotification();
  expect(captured).toBeTruthy();
  expect(captured![1].title).toBe('Switch to long-a.test space?');

  await clearAllNotifications();
  await pageA.close();
  await pageB.close();
});
