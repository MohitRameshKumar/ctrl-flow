import { expect, test } from '@playwright/test';
import { callHook, closeExtension, FIXTURES_ORIGIN, launchExtension, type ExtensionHandle } from './helpers';

const SECRET = 'cadence-secret-123';

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

async function allTableContents(): Promise<string> {
  const tables = ['events', 'rituals', 'spaces', 'spaceUrls', 'shelves'];
  const contents = await Promise.all(tables.map((t) => callHook(ext.sw, 'readTable', t)));
  return JSON.stringify(contents);
}

test('a secret typed into a password field or a normal field never appears in any table', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${FIXTURES_ORIGIN}/test-page.html`);

  await page.click('#password-field');
  await page.keyboard.type(SECRET);
  await page.click('#plain-input');
  await page.keyboard.type(SECRET);

  // field_changed fires on blur/change; blur both fields.
  await page.click('#plain-textarea');
  await page.waitForTimeout(500);

  const dump = await allTableContents();
  expect(dump).not.toContain(SECRET);

  const rows = await callHook<Array<{ kind: string; fieldName?: string }>>(ext.sw, 'readTable', 'events');
  const passwordFieldChange = rows.find((e) => e.kind === 'field_changed' && e.fieldName === 'password-field');
  expect(passwordFieldChange).toBeUndefined();

  await page.close();
});

test('navigating to a blocklisted domain logs zero events for it', async () => {
  await ext.context.route('https://chase.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stub chase page</body></html>' }),
  );

  const page = await ext.context.newPage();
  await page.goto('https://chase.com/');
  await page.waitForTimeout(500);

  const rows = await callHook<Array<{ domain?: string }>>(ext.sw, 'readTable', 'events');
  expect(rows.some((e) => e.domain === 'chase.com')).toBe(false);

  await page.close();
});

test('while paused, no events are written', async () => {
  await callHook(ext.sw, 'setPaused', true);

  const page = await ext.context.newPage();
  await page.goto(`${FIXTURES_ORIGIN}/test-page.html`);
  await page.click('#plain-button');
  await page.waitForTimeout(500);

  const rows = await callHook<unknown[]>(ext.sw, 'readTable', 'events');
  expect(rows.length).toBe(0);

  await callHook(ext.sw, 'setPaused', false);
  await page.close();
});

test('lastAiRequest after a Spaces recompute contains only url/title-shaped data', async () => {
  // Candidates for a recompute come from *currently open tabs* plus tab_activated history
  // (lib/spaces.ts getCandidateUrls). A closed tab's only tab_activated event fires before
  // navigation completes (empty url), so the tab must stay open for recompute to see it.
  const page = await ext.context.newPage();
  await page.goto(`${FIXTURES_ORIGIN}/test-page.html`);
  await page.waitForTimeout(300);

  await callHook(ext.sw, 'fireAlarm', 'cadence-space-recompute');
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 500)));

  const record = await callHook<{ request: { input: unknown } } | null>(ext.sw, 'getLastAiRequest');
  expect(record).toBeTruthy();

  const input = record!.request.input as { urls?: Array<Record<string, unknown>> };
  expect(Array.isArray(input.urls)).toBe(true);
  expect((input.urls ?? []).length).toBeGreaterThan(0);
  for (const u of input.urls ?? []) {
    const keys = Object.keys(u).sort();
    expect(keys).toEqual(['title', 'url']);
    expect(typeof u.url).toBe('string');
    expect(typeof u.title).toBe('string');
  }

  await page.close();
});
