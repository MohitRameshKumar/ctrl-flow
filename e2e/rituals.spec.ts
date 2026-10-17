import { expect, test } from '@playwright/test';
import { callHook, closeExtension, launchExtension, sidePanelUrl, type ExtensionHandle } from './helpers';

const HOUR = 60 * 60 * 1000;

interface RitualRow {
  id: number;
  seriesKey: string;
  title: string;
  status: string;
  urls: Array<{ url: string; pageTitle?: string; occurrences: number }>;
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

async function rituals(): Promise<RitualRow[]> {
  return callHook<RitualRow[]>(ext.sw, 'readTable', 'rituals');
}

/** Seeds 2 past "Team sync" occurrences (demo mode needs 2 of the last 2) with a matching
 * tab_activated event near each occurrence's start, then recomputes. */
async function seedTeamSyncRitual(url = 'https://docs.google.com/team-sync-notes'): Promise<void> {
  const now = Date.now();
  await callHook(ext.sw, 'seedDemoCalendar', [
    { id: 'ts1', seriesKey: 'team sync', title: 'Team sync', start: now - 9 * HOUR, end: now - 9 * HOUR + 30 * 60000 },
    { id: 'ts2', seriesKey: 'team sync', title: 'Team sync', start: now - 6 * HOUR, end: now - 6 * HOUR + 30 * 60000 },
  ]);
  await callHook(ext.sw, 'seedEvents', [
    { ts: now - 9 * HOUR + 2 * 60000, kind: 'tab_activated', url, title: 'Team sync notes' },
    { ts: now - 6 * HOUR + 2 * 60000, kind: 'tab_activated', url, title: 'Team sync notes' },
  ]);
  await callHook(ext.sw, 'fireAlarm', 'cadence-ritual-recompute');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));
}

test('a recurring meeting with matching tab activity is detected as a ritual with the right URLs', async () => {
  await seedTeamSyncRitual();

  const rows = await rituals();
  const ritual = rows.find((r) => r.seriesKey === 'team sync');
  expect(ritual).toBeTruthy();
  expect(ritual?.status).toBe('suggested');
  expect(ritual?.urls.map((u) => u.url)).toEqual(['https://docs.google.com/team-sync-notes']);
  expect(ritual?.urls[0]?.occurrences).toBe(2);
});

test('firing the trigger alarm then calling the notification handler opens a tab group named after the ritual', async () => {
  await ext.context.route('https://docs.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stub</body></html>' }),
  );
  await seedTeamSyncRitual();
  const ritual = (await rituals()).find((r) => r.seriesKey === 'team sync')!;

  await callHook(ext.sw, 'fireAlarm', `cadence-ritual-trigger:${ritual.id}`);
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  // Suggested/accepted rituals only notify — no tabs yet.
  let groups = await ext.sw.evaluate(() => chrome.tabGroups.query({}));
  expect(groups.some((g) => g.title === 'Team sync')).toBe(false);

  await callHook(ext.sw, 'callNotificationButtonClicked', `cadence-ritual:${ritual.id}`, 0);
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  groups = await ext.sw.evaluate(() => chrome.tabGroups.query({}));
  const group = groups.find((g) => g.title === 'Team sync');
  expect(group).toBeTruthy();

  // The new tab's url is briefly empty/pending, or an error page if the real site is unreachable
  // (seen ~1 run in 20) — stub the origin and wait for the url to settle instead of racing it.
  await expect
    .poll(async () => {
      const tabs = await ext.sw.evaluate((groupId) => chrome.tabs.query({ groupId }), group!.id);
      return tabs.map((t) => t.url || t.pendingUrl);
    })
    .toEqual(['https://docs.google.com/team-sync-notes']);
});

test('"Never" stops future trigger alarms for that ritual', async () => {
  await seedTeamSyncRitual();

  const panel = await ext.context.newPage();
  await panel.goto(sidePanelUrl(ext.extensionId));
  await expect(panel.locator('.ritual-card .suggestion-card')).toBeVisible({ timeout: 10000 });
  await panel.locator('.ritual-card .suggestion-actions button:text("Never")').click();
  await panel.waitForTimeout(300);

  const ritual = (await rituals()).find((r) => r.seriesKey === 'team sync')!;
  expect(ritual.status).toBe('never');

  await callHook(ext.sw, 'fireAlarm', 'cadence-ritual-recompute');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  const alarms = await ext.sw.evaluate(() => chrome.alarms.getAll());
  expect(alarms.some((a) => a.name === `cadence-ritual-trigger:${ritual.id}`)).toBe(false);

  await panel.close();
});

test('"Auto" opens the docs immediately when the trigger fires, without the notification button', async () => {
  await seedTeamSyncRitual();

  const panel = await ext.context.newPage();
  await panel.goto(sidePanelUrl(ext.extensionId));
  await expect(panel.locator('.ritual-card .suggestion-card')).toBeVisible({ timeout: 10000 });
  await panel.locator('.ritual-card .suggestion-actions button:text("Accept")').click();
  const checkbox = panel.locator('.ritual-card .checkbox-row input[type="checkbox"]');
  await expect(checkbox).toBeVisible({ timeout: 5000 });
  await checkbox.click();
  // The checkbox is a controlled component bound to ritual.status; give the async
  // updateRitualStatus + refresh a moment to land before reading the DB.
  await expect(checkbox).toBeChecked({ timeout: 5000 });

  const ritual = (await rituals()).find((r) => r.seriesKey === 'team sync')!;
  expect(ritual.status).toBe('auto');

  // Fire the trigger directly — never call the notification button handler.
  await callHook(ext.sw, 'fireAlarm', `cadence-ritual-trigger:${ritual.id}`);
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  const groups = await ext.sw.evaluate(() => chrome.tabGroups.query({}));
  expect(groups.some((g) => g.title === 'Team sync')).toBe(true);

  await panel.close();
});

test('a removed doc stays removed after a recompute', async () => {
  const now = Date.now();
  const urlA = 'https://docs.google.com/team-sync-notes';
  const urlB = 'https://docs.google.com/team-sync-agenda';

  await callHook(ext.sw, 'seedDemoCalendar', [
    { id: 'ts1', seriesKey: 'team sync', title: 'Team sync', start: now - 9 * HOUR, end: now - 9 * HOUR + 1800000 },
    { id: 'ts2', seriesKey: 'team sync', title: 'Team sync', start: now - 6 * HOUR, end: now - 6 * HOUR + 1800000 },
  ]);
  await callHook(ext.sw, 'seedEvents', [
    { ts: now - 9 * HOUR + 120000, kind: 'tab_activated', url: urlA, title: 'Notes' },
    { ts: now - 6 * HOUR + 120000, kind: 'tab_activated', url: urlA, title: 'Notes' },
    { ts: now - 9 * HOUR + 150000, kind: 'tab_activated', url: urlB, title: 'Agenda' },
    { ts: now - 6 * HOUR + 150000, kind: 'tab_activated', url: urlB, title: 'Agenda' },
  ]);
  await callHook(ext.sw, 'fireAlarm', 'cadence-ritual-recompute');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  let ritual = (await rituals()).find((r) => r.seriesKey === 'team sync')!;
  expect(ritual.urls.map((u) => u.url).sort()).toEqual([urlA, urlB].sort());

  const panel = await ext.context.newPage();
  await panel.goto(sidePanelUrl(ext.extensionId));
  await expect(panel.locator('.ritual-card .doc-list li')).toHaveCount(2, { timeout: 10000 });
  await panel.locator('.ritual-card .doc-list li', { hasText: 'Agenda' }).locator('button:text("Remove")').click();
  await panel.waitForTimeout(300);

  ritual = (await rituals()).find((r) => r.seriesKey === 'team sync')!;
  expect(ritual.urls.map((u) => u.url)).toEqual([urlA]);

  // Recompute again with the exact same qualifying activity — the removed doc must not return.
  await callHook(ext.sw, 'fireAlarm', 'cadence-ritual-recompute');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  ritual = (await rituals()).find((r) => r.seriesKey === 'team sync')!;
  expect(ritual.urls.map((u) => u.url)).toEqual([urlA]);

  await panel.close();
});
