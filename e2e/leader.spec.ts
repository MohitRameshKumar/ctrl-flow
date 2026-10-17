import { expect, test, type Page } from '@playwright/test';
import { callHook, closeExtension, FIXTURES_ORIGIN, launchExtension, sidePanelUrl, type ExtensionHandle } from './helpers';

let ext: ExtensionHandle;
let page: Page;

test.beforeAll(async () => {
  ext = await launchExtension();
});
test.afterAll(async () => {
  await closeExtension(ext);
});

test.beforeEach(async () => {
  await callHook(ext.sw, 'clearAllTables');
  await ext.sw.evaluate(() => chrome.storage.session.clear());
  await ext.sw.evaluate(() => chrome.storage.local.remove(['spaceLetters', 'leaderLetters']));
  await callHook(ext.sw, 'setPaused', false);
  await ext.sw.evaluate(() => chrome.storage.local.set({ retention: '24h' }));
  // Playwright can't open a real side panel, so record the calls instead.
  await ext.sw.evaluate(() => {
    const g = globalThis as unknown as { __spCalls: unknown[]; __spOrig?: unknown };
    g.__spCalls = [];
    g.__spOrig ??= chrome.sidePanel.open;
    chrome.sidePanel.open = (async (opts: unknown) => {
      g.__spCalls.push(opts);
    }) as typeof chrome.sidePanel.open;
  });
  page = await ext.context.newPage();
  await page.goto(`${FIXTURES_ORIGIN}/second-page.html`);
  await page.bringToFront();
});

test.afterEach(async () => {
  await page.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sidePanelCalls = () => ext.sw.evaluate(() => (globalThis as unknown as { __spCalls: unknown[] }).__spCalls);
const overlay = () => page.locator('#cadence-leader-host');
const events = () => callHook<Array<{ kind: string; url?: string; domain?: string }>>(ext.sw, 'readTable', 'events');

async function openOverlay() {
  expect(await callHook(ext.sw, 'triggerLeader')).toBe('overlay');
  await expect(overlay()).toBeAttached();
}

test('leader key shows the overlay with every letter, R/K/M as coming soon', async () => {
  await openOverlay();
  for (const text of ['Open side panel', 'Stop what Cadence is doing', 'Pause / resume recording', 'Search spaces & rituals']) {
    await expect(page.getByText(text)).toBeVisible();
  }
  await expect(page.getByText('Repeat-to-Macro (coming soon)')).toHaveCount(3);
});

test('the overlay closes after 2 s, and on Escape', async () => {
  await openOverlay();
  await expect(overlay()).toBeAttached();
  await wait(2600);
  await expect(overlay()).toHaveCount(0);

  await openOverlay();
  await page.keyboard.press('Escape');
  await expect(overlay()).toHaveCount(0);
});

test('E opens the side panel; reserved R does nothing', async () => {
  await openOverlay();
  await page.keyboard.press('r'); // reserved: ignored, overlay stays
  await expect(overlay()).toBeAttached();
  await page.keyboard.press('e');
  await expect(overlay()).toHaveCount(0);
  await expect.poll(sidePanelCalls).toHaveLength(1);
  expect(((await sidePanelCalls()) as Array<{ tabId?: number }>)[0]?.tabId).toBeGreaterThan(0);
});

test('P pauses and resumes recording, and the toolbar badge follows', async () => {
  const badge = () => ext.sw.evaluate(() => chrome.action.getBadgeText({}));
  await expect.poll(badge).toBe('●');

  await openOverlay();
  await page.keyboard.press('p');
  await expect.poll(() => ext.sw.evaluate(async () => (await chrome.storage.local.get('paused')).paused)).toBe(true);
  await expect.poll(badge).toBe('II');

  await openOverlay();
  await page.keyboard.press('p');
  await expect.poll(() => ext.sw.evaluate(async () => (await chrome.storage.local.get('paused')).paused)).toBe(false);
  await expect.poll(badge).toBe('●');
});

test('on a page content scripts cannot run on, the leader key opens the side panel with the letter list', async () => {
  const restricted = await ext.context.newPage();
  await restricted.goto('chrome://version');
  await restricted.bringToFront();
  expect(await callHook(ext.sw, 'triggerLeader')).toBe('panel');
  await expect.poll(sidePanelCalls).toHaveLength(1);
  expect(await ext.sw.evaluate(async () => typeof (await chrome.storage.session.get('leaderPanelAt')).leaderPanelAt)).toBe('number');

  const panel = await ext.context.newPage();
  await panel.goto(sidePanelUrl(ext.extensionId));
  await expect(panel.locator('.leader-fallback')).toBeVisible();
  await expect(panel.locator('.leader-list')).toContainText('Open side panel');
  await panel.close();
  await restricted.close();
});

async function seedClubSpace() {
  const now = Date.now();
  await callHook(ext.sw, 'seedTable', 'spaces', [
    { id: 1, name: 'Club website', status: 'user', createdAt: now, updatedAt: now },
    { id: 2, name: 'Cooking', status: 'user', createdAt: now, updatedAt: now },
  ]);
  await callHook(ext.sw, 'seedTable', 'spaceUrls', [
    { spaceId: 1, url: `${FIXTURES_ORIGIN}/test-page.html`, title: 'Club page', source: 'user', alwaysOpen: false },
  ]);
}

async function shelveClubGroup() {
  const clubTab = await ext.context.newPage();
  await clubTab.goto(`${FIXTURES_ORIGIN}/test-page.html`);
  await ext.sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.endsWith('/test-page.html'))!;
    const groupId = await chrome.tabs.group({ tabIds: [tab.id!] });
    await chrome.tabGroups.update(groupId, { title: 'Club website', collapsed: true });
  });
  await page.bringToFront();
  return clubTab;
}

const clubGroupCollapsed = () =>
  ext.sw.evaluate(async () => (await chrome.tabGroups.query({ title: 'Club website' }))[0]?.collapsed);

test('assigning letters to spaces: suggestion is the first free letter, conflicts and reserved letters are rejected', async () => {
  await seedClubSpace();
  const panel = await ext.context.newPage();
  await panel.goto(sidePanelUrl(ext.extensionId));
  await panel.click('button:text("Spaces")');
  const controls = panel.locator('.space-letter');
  // The panel's own recompute may add more spaces from open tabs; the seeded ones come first.
  await expect(controls.nth(1)).toBeVisible();

  await expect(controls.nth(0).locator('.letter-input')).toHaveAttribute('placeholder', 'C');
  await controls.nth(0).locator('button:has-text("Assign")').click();
  await expect(controls.nth(0).locator('.letter-kbd')).toHaveText('C');

  // "Cooking": C is taken, so the suggestion moves on to O.
  await expect(controls.nth(1).locator('.letter-input')).toHaveAttribute('placeholder', 'O');

  for (const [typed, message] of [
    ['c', 'already used'],
    ['p', 'already used'], // the built-in Pause letter
    ['r', 'reserved'],
  ] as const) {
    await controls.nth(1).locator('.letter-input').fill(typed);
    await controls.nth(1).locator('button:has-text("Assign")').click();
    await expect(controls.nth(1).locator('.letter-error')).toContainText(message);
  }
  await panel.close();
});

test('a space letter restores that space (leader, then the letter)', async () => {
  await seedClubSpace();
  await ext.sw.evaluate(() => chrome.storage.local.set({ spaceLetters: { '1': 'c' } }));
  const clubTab = await shelveClubGroup();
  expect(await clubGroupCollapsed()).toBe(true);

  await openOverlay();
  await expect(page.getByText('Project: Club website')).toBeVisible();
  await page.keyboard.press('c');
  await expect.poll(clubGroupCollapsed).toBe(false);
  await clubTab.close();
});

test('slash opens a search list of spaces and rituals; Enter runs the pick; typing is never recorded', async () => {
  await seedClubSpace();
  const now = Date.now();
  await callHook(ext.sw, 'seedTable', 'rituals', [
    { seriesKey: 'team sync', title: 'Team sync', urls: [], removedUrls: [], status: 'suggested', updatedAt: now },
  ]);
  const clubTab = await shelveClubGroup();
  await callHook(ext.sw, 'clearTable', 'events');

  await openOverlay();
  await page.keyboard.press('/');
  const input = overlay().locator('input');
  await expect(input).toBeVisible();
  await expect(page.getByText('Team sync')).toBeVisible();
  await expect(page.getByText('Cooking')).toBeVisible();
  await input.fill('club');
  await expect(page.getByText('Cooking')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect.poll(clubGroupCollapsed).toBe(false);
  await expect(overlay()).toHaveCount(0);

  // The typing_burst flush is 5 s after the last key: wait it out, then check nothing from the overlay was recorded.
  await wait(6200);
  const kinds = (await events()).map((e) => e.kind);
  expect(kinds).not.toContain('typing_burst');
  expect(kinds).not.toContain('field_changed');
  await clubTab.close();
});

test('keys pressed in the leader overlay are not recorded as typing', async () => {
  await callHook(ext.sw, 'clearTable', 'events');
  await openOverlay();
  for (const k of ['x', 'y', 'z']) await page.keyboard.press(k);
  await page.keyboard.press('Escape');
  await wait(6200);
  expect((await events()).filter((e) => e.kind === 'typing_burst')).toHaveLength(0);
});

test('retention: events older than the setting are deleted; rituals, spaces and shelves are kept', async () => {
  const now = Date.now();
  const MIN = 60_000;
  await seedClubSpace();
  await callHook(ext.sw, 'seedTable', 'rituals', [
    { seriesKey: 'team sync', title: 'Team sync', urls: [], removedUrls: [], status: 'accepted', updatedAt: now - 30 * 24 * 60 * MIN },
  ]);
  await callHook(ext.sw, 'seedTable', 'shelves', [{ spaceId: 1, urls: [{ url: 'https://x.test/' }], createdAt: now - 30 * 24 * 60 * MIN }]);
  await callHook(ext.sw, 'seedEvents', [
    { ts: now - 3 * 60 * MIN, kind: 'tab_activated', url: 'https://old.test/', domain: 'old.test' },
    { ts: now - 30 * MIN, kind: 'tab_activated', url: 'https://mid.test/', domain: 'mid.test' },
    { ts: now - 2 * MIN, kind: 'tab_activated', url: 'https://new.test/', domain: 'new.test' },
  ]);
  const domains = async () => (await events()).filter((e) => e.domain?.endsWith('.test') && e.domain !== 'localhost').map((e) => e.domain).sort();

  // Default 24 h: the cleanup alarm deletes nothing.
  await callHook(ext.sw, 'fireAlarm', 'cadence-cleanup');
  expect(await domains()).toEqual(expect.arrayContaining(['mid.test', 'new.test', 'old.test']));

  await ext.sw.evaluate(() => chrome.storage.local.set({ retention: '1h' }));
  await callHook(ext.sw, 'fireAlarm', 'cadence-cleanup');
  expect(await domains()).toEqual(expect.arrayContaining(['mid.test', 'new.test']));
  expect(await domains()).not.toContain('old.test');

  await ext.sw.evaluate(() => chrome.storage.local.set({ retention: '10m' }));
  await callHook(ext.sw, 'fireAlarm', 'cadence-cleanup');
  expect(await domains()).toContain('new.test');
  expect(await domains()).not.toContain('mid.test');

  expect(await callHook(ext.sw, 'readTable', 'rituals')).toHaveLength(1);
  expect(await callHook(ext.sw, 'readTable', 'spaces')).toHaveLength(2);
  expect(await callHook(ext.sw, 'readTable', 'spaceUrls')).toHaveLength(1);
  expect(await callHook(ext.sw, 'readTable', 'shelves')).toHaveLength(1);
});

test('exclusions: password managers are on by default; an added domain records nothing; removing it records again', async () => {
  const panel = await ext.context.newPage();
  await panel.goto(sidePanelUrl(ext.extensionId));
  await expect(panel.locator('.excluded-list')).toContainText('1password.com');
  await expect(panel.locator('.excluded-list')).toContainText('chase.com');

  await panel.fill('input[aria-label="Add excluded site"]', 'https://www.Excluded.test/some/page');
  await panel.click('.privacy-settings button:text("Add")');
  await expect(panel.locator('.excluded-list')).toContainText('excluded.test');

  for (const host of ['excluded.test', 'included.test']) {
    await ext.context.route(`https://${host}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><title>x</title></head><body>hi</body></html>' }),
    );
  }
  await callHook(ext.sw, 'clearTable', 'events');
  const ex = await ext.context.newPage();
  await ex.goto('https://excluded.test/');
  const inc = await ext.context.newPage();
  await inc.goto('https://included.test/');
  await wait(500);
  const seen = (await events()).map((e) => e.domain);
  expect(seen).toContain('included.test');
  expect(seen).not.toContain('excluded.test');

  await panel.click('.excluded-list li:has-text("excluded.test") button');
  await expect(panel.locator('.excluded-list')).not.toContainText('excluded.test');
  await ex.goto('https://excluded.test/again');
  await wait(500);
  expect((await events()).map((e) => e.domain)).toContain('excluded.test');
  await ex.close();
  await inc.close();
  await panel.close();
});
