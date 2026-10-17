import { expect, test, type Page } from '@playwright/test';
import { callHook, closeExtension, launchExtension, MOCK_PROXY_ORIGIN, sidePanelUrl, type ExtensionHandle } from './helpers';

interface SpaceRow {
  id: number;
  name: string;
  status: string;
}
interface SpaceUrlRow {
  id: number;
  spaceId: number;
  url: string;
  source: string;
}

const ARTICLE_1 = 'https://news-a.test/ai-is-changing-everything';
const ARTICLE_2 = 'https://news-b.test/how-llms-work';
const DOC = 'https://docs.example.test/d/1/edit';
const UNRELATED = 'https://recipes.test/pasta';

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
  await setMockFail(false);
});

async function setMockFail(enabled: boolean) {
  await fetch(`${MOCK_PROXY_ORIGIN}/__mock/fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}
const spaces = () => callHook<SpaceRow[]>(ext.sw, 'readTable', 'spaces');
const spaceUrls = () => callHook<SpaceUrlRow[]>(ext.sw, 'readTable', 'spaceUrls');

async function openTab(url: string, title: string): Promise<Page> {
  const page = await ext.context.newPage();
  await ext.context.route(`${new URL(url).origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: `<html><head><title>${title}</title></head><body>stub</body></html>` }),
  );
  await page.goto(url);
  return page;
}

/** Four tabs: two articles + an "Untitled document" the user takes notes in, and one unrelated tab. */
async function openResearchFixture(): Promise<Page[]> {
  return [
    await openTab(ARTICLE_1, 'AI is changing everything'),
    await openTab(ARTICLE_2, 'How large language models work'),
    await openTab(DOC, 'Untitled document'),
    await openTab(UNRELATED, 'Pasta carbonara recipe'),
  ];
}

/** ~10 switches among the articles and the doc, typing in the doc; the unrelated tab is only touched once. */
async function seedResearchUsage() {
  const now = Date.now();
  await callHook(ext.sw, 'clearTable', 'events');
  const order = [ARTICLE_1, DOC, ARTICLE_2, DOC, ARTICLE_1, DOC, ARTICLE_2, DOC, ARTICLE_1, DOC, ARTICLE_2];
  const titles: Record<string, string> = {
    [ARTICLE_1]: 'AI is changing everything',
    [ARTICLE_2]: 'How large language models work',
    [DOC]: 'Untitled document',
  };
  const events: Array<Record<string, unknown>> = order.map((url, i) => ({
    ts: now - (order.length - i) * 20000,
    kind: 'tab_activated',
    url,
    domain: new URL(url).hostname,
    title: titles[url],
  }));
  events.push({ ts: now - 400000, kind: 'tab_activated', url: UNRELATED, domain: 'recipes.test', title: 'Pasta carbonara recipe' });
  for (let i = 0; i < 4; i++) {
    events.push({ ts: now - 150000 + i * 20000, kind: 'typing_burst', url: DOC, domain: 'docs.example.test', keyCount: 25 });
  }
  await callHook(ext.sw, 'seedEvents', events);
}

async function openSpacesPanel(): Promise<Page> {
  const panel = await ext.context.newPage();
  await panel.goto(sidePanelUrl(ext.extensionId));
  await panel.click('button:text("Spaces")');
  await expect(panel.locator('.space-name-input').nth(0)).toBeVisible({ timeout: 10000 });
  return panel;
}

function spaceOf(rows: SpaceUrlRow[], url: string): number | undefined {
  return rows.find((r) => r.url === url)?.spaceId;
}

test('two articles + an "Untitled document" with many switches between them land in one space; unrelated tab stays apart', async () => {
  const pages = await openResearchFixture();
  await seedResearchUsage();
  const panel = await openSpacesPanel();

  const rows = await spaceUrls();
  const articleSpace = spaceOf(rows, ARTICLE_1);
  expect(articleSpace).toBeDefined();
  expect(spaceOf(rows, ARTICLE_2)).toBe(articleSpace);
  expect(spaceOf(rows, DOC)).toBe(articleSpace);
  expect(spaceOf(rows, UNRELATED)).toBeDefined();
  expect(spaceOf(rows, UNRELATED)).not.toBe(articleSpace);
  expect((await spaces()).every((s) => s.status === 'ai')).toBe(true);

  await panel.close();
  await Promise.all(pages.map((p) => p.close()));
});

test('what is sent to the proxy is titles, URLs, and counts only', async () => {
  const pages = await openResearchFixture();
  await seedResearchUsage();
  const panel = await openSpacesPanel();

  const { last } = (await (await fetch(`${MOCK_PROXY_ORIGIN}/__mock/last`)).json()) as {
    last: { task: string; input: Record<string, unknown> };
  };
  expect(last.task).toBe('name_spaces');
  expect(Object.keys(last.input).sort()).toEqual(['edges', 'typed', 'urls']);
  const urls = last.input.urls as Array<Record<string, unknown>>;
  for (const u of urls) expect(Object.keys(u).sort()).toEqual(['title', 'url']);
  const edges = last.input.edges as Array<Record<string, number>>;
  expect(edges.length).toBeGreaterThan(0);
  for (const e of edges) expect(Object.keys(e).sort()).toEqual(['a', 'b', 'near', 'switches']);
  const docIdx = urls.findIndex((u) => u.url === DOC);
  expect(last.input.typed).toEqual([{ i: docIdx, bursts: 4 }]);

  // The same record is what "Show last AI request" displays.
  const record = await callHook<{ request: { input: unknown } }>(ext.sw, 'getLastAiRequest');
  expect(record.request.input).toEqual(last.input);

  await panel.close();
  await Promise.all(pages.map((p) => p.close()));
});

test('offline fallback still merges strongly co-used tabs across domains', async () => {
  const pages = await openResearchFixture();
  await seedResearchUsage();
  await setMockFail(true);
  const panel = await openSpacesPanel();

  const rows = await spaceUrls();
  const all = await spaces();
  const articleSpace = spaceOf(rows, ARTICLE_1);
  expect(spaceOf(rows, ARTICLE_2)).toBe(articleSpace);
  expect(spaceOf(rows, DOC)).toBe(articleSpace);
  expect(spaceOf(rows, UNRELATED)).not.toBe(articleSpace);
  expect(all.find((s) => s.id === articleSpace)?.status).toBe('auto_offline');

  await panel.close();
  await Promise.all(pages.map((p) => p.close()));
});

test('a later recompute regroups offline spaces with the AI, but never touches a renamed space or a user-moved tab', async () => {
  const pages = await openResearchFixture();
  await seedResearchUsage();
  await setMockFail(true);
  const panel = await openSpacesPanel();

  // User renames the unrelated tab's (offline) space.
  const unrelatedSpaceId = spaceOf(await spaceUrls(), UNRELATED)!;
  const renamedIndex = (await spaces()).findIndex((s) => s.id === unrelatedSpaceId);
  const input = panel.locator('.space-name-input').nth(renamedIndex);
  await input.fill('Dinner ideas');
  await input.blur();
  await panel.waitForTimeout(300);

  await setMockFail(false);
  await panel.click('button:text("Recompute now")');
  await panel.waitForTimeout(1500);

  const rows = await spaceUrls();
  const all = await spaces();
  const articleSpace = spaceOf(rows, ARTICLE_1);
  expect(spaceOf(rows, ARTICLE_2)).toBe(articleSpace);
  expect(spaceOf(rows, DOC)).toBe(articleSpace);
  expect(all.find((s) => s.id === articleSpace)?.status).toBe('ai');
  expect(all.filter((s) => s.status === 'auto_offline')).toHaveLength(0);

  const dinner = all.find((s) => s.name === 'Dinner ideas');
  expect(dinner?.status).toBe('user');
  expect(spaceOf(rows, UNRELATED)).toBe(dinner?.id);

  await panel.close();
  await Promise.all(pages.map((p) => p.close()));
});

test('with the side panel open, the switch offer is staged for the in-panel banner and shown there', async () => {
  const pageA = await openTab('https://panel-a.test/', 'Panel A');
  const pageB = await openTab('https://panel-b.test/', 'Panel B');
  const panel = await openSpacesPanel();
  await pageA.bringToFront();
  await callHook(ext.sw, 'clearTable', 'events');
  await callHook(ext.sw, 'seedEvents', [
    { ts: Date.now() - 40000, kind: 'tab_activated', url: 'https://panel-a.test/', title: 'Panel A' },
  ]);

  // Playwright can't open a real side panel surface (it reports as a TAB context), so report one.
  await ext.sw.evaluate(() => {
    (globalThis as unknown as { __origGetContexts?: unknown }).__origGetContexts = chrome.runtime.getContexts;
    chrome.runtime.getContexts = async () => [{ contextType: 'SIDE_PANEL' }] as chrome.runtime.ExtensionContext[];
  });
  await callHook(ext.sw, 'fireAlarm', 'cadence-switch-check');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  await panel.bringToFront();
  await expect(panel.locator('text=Switch to panel-a.test space?')).toBeVisible({ timeout: 8000 });

  // Undo the stub: the service worker is shared with every other test in this file.
  await ext.sw.evaluate(() => {
    chrome.runtime.getContexts = (globalThis as unknown as { __origGetContexts: typeof chrome.runtime.getContexts })
      .__origGetContexts;
  });
  await ext.sw.evaluate(() => chrome.storage.session.remove('pendingSwitchSuggestion'));

  await panel.close();
  await pageA.close();
  await pageB.close();
});

test('activations flagged programmatic (Cadence restoring a space, opening ritual docs) never trigger a switch offer', async () => {
  const pageA = await openTab('https://prog-a.test/', 'Prog A');
  const pageB = await openTab('https://prog-b.test/', 'Prog B');
  const panel = await openSpacesPanel();
  await panel.close();
  await pageA.bringToFront();

  const notificationsBefore = Object.keys(await ext.sw.evaluate(() => chrome.notifications.getAll()));
  await callHook(ext.sw, 'clearTable', 'events');
  await callHook(ext.sw, 'seedEvents', [
    { ts: Date.now() - 40000, kind: 'tab_activated', url: 'https://prog-a.test/', title: 'Prog A', programmatic: true },
  ]);
  await callHook(ext.sw, 'fireAlarm', 'cadence-switch-check');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  expect(Object.keys(await ext.sw.evaluate(() => chrome.notifications.getAll()))).toEqual(notificationsBefore);

  // The same activation, made by the user, does trigger one.
  await callHook(ext.sw, 'clearTable', 'events');
  await callHook(ext.sw, 'seedEvents', [
    { ts: Date.now() - 40000, kind: 'tab_activated', url: 'https://prog-a.test/', title: 'Prog A' },
  ]);
  await callHook(ext.sw, 'fireAlarm', 'cadence-switch-check');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  expect(Object.keys(await ext.sw.evaluate(() => chrome.notifications.getAll())).length).toBe(notificationsBefore.length + 1);

  await ext.sw.evaluate(() => chrome.notifications.getAll().then((all) => Promise.all(Object.keys(all).map((id) => chrome.notifications.clear(id)))));
  await pageA.close();
  await pageB.close();
});
