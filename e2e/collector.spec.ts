import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { callHook, closeExtension, FIXTURES_ORIGIN, launchExtension, type ExtensionHandle } from './helpers';

interface CadenceEventRow {
  kind: string;
  url?: string;
  title?: string;
  selector?: string;
  label?: string;
  keyCount?: number;
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
});

async function events(): Promise<CadenceEventRow[]> {
  return callHook<CadenceEventRow[]>(ext.sw, 'readTable', 'events');
}

test('open, navigate, switch between, and close tabs all log with url and title', async () => {
  // tab_opened/the first tab_activated fire at tab-creation time, before page.goto() runs — so
  // they reflect the tab's initial (blank) state, not the destination. Real navigation shows up
  // as a `navigated` event; switching to an already-navigated tab is what makes tab_activated
  // carry a real url, so that's what this test exercises.
  const pageA = await ext.context.newPage();
  await pageA.goto(`${FIXTURES_ORIGIN}/test-page.html`);
  await pageA.waitForTimeout(300);

  const pageB = await ext.context.newPage();
  await pageB.goto(`${FIXTURES_ORIGIN}/second-page.html`);
  await pageB.waitForTimeout(300);

  await pageA.bringToFront();
  await pageA.waitForTimeout(300);

  const rows = await events();
  const opened = rows.filter((e) => e.kind === 'tab_opened');
  const navigatedA = rows.find((e) => e.kind === 'navigated' && e.url?.includes('test-page.html'));
  const navigatedB = rows.find((e) => e.kind === 'navigated' && e.url?.includes('second-page.html'));
  const switchedToA = rows.find((e) => e.kind === 'tab_activated' && e.url?.includes('test-page.html'));

  expect(opened.length).toBeGreaterThanOrEqual(2);
  expect(navigatedA?.title).toBe('Cadence test page');
  expect(navigatedB?.title).toBe('Second page');
  expect(switchedToA?.title).toBe('Cadence test page');

  await pageB.close();
  await ext.sw.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  const afterClose = await events();
  expect(afterClose.some((e) => e.kind === 'tab_closed')).toBe(true);

  await pageA.close();
});

test('clicking a button logs a click event with a sensible selector and label', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${FIXTURES_ORIGIN}/test-page.html`);
  await page.click('#plain-button');
  await page.waitForTimeout(300);

  const rows = await events();
  const click = rows.find((e) => e.kind === 'click');
  expect(click).toBeTruthy();
  // aria-label takes priority, but this button has none — falls back to data-testid.
  expect(click?.selector).toContain('main-button');
  expect(click?.label).toBe('Click me');

  await page.close();
});

test('typing in an input, textarea, contenteditable, and an iframe input all produce a typing_burst', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${FIXTURES_ORIGIN}/test-page.html`);

  await page.click('#plain-input');
  await page.keyboard.type('cat');
  await page.waitForTimeout(6000);

  await page.click('#plain-textarea');
  await page.keyboard.type('dog');
  await page.waitForTimeout(6000);

  await page.click('#plain-ce');
  await page.keyboard.type('fox');
  await page.waitForTimeout(6000);

  const frame = page.frameLocator('#child-iframe');
  await frame.locator('#iframe-input').click();
  await page.keyboard.type('owl');
  await page.waitForTimeout(6000);

  const rows = await events();
  const bursts = rows.filter((e) => e.kind === 'typing_burst');
  expect(bursts.length).toBeGreaterThanOrEqual(4);
  for (const b of bursts) {
    expect(b.keyCount).toBeGreaterThan(0);
  }

  await page.close();
});

test('a URL with a query string and fragment is stored without either', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${FIXTURES_ORIGIN}/test-page.html?utm_source=x#frag`);
  await page.waitForTimeout(300);

  const rows = await events();
  const navigated = rows.find((e) => e.kind === 'navigated' && e.url?.includes('test-page.html'));
  expect(navigated?.url).toBe(`${FIXTURES_ORIGIN}/test-page.html`);
  expect(navigated?.url).not.toContain('utm_source');
  expect(navigated?.url).not.toContain('frag');

  await page.close();
});

// SKIPPED: environment limit, not a product bug. Diagnosed in-session: osascript does move OS focus
// (frontmost: "Google Chrome for Testing" -> "Finder"), but Playwright-launched Chromium never fires
// chrome.windows.onFocusChanged (a raw listener in the service worker received nothing). Covered by
// the manual checklist in TESTING_REPORT.md instead.
test.skip('switching to another macOS app and back logs chrome_focus_lost then chrome_focus_gained', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${FIXTURES_ORIGIN}/test-page.html`);
  await page.waitForTimeout(300);

  // Re-activate the Playwright-launched Chromium by PID. Activating "Google Chrome" by name would
  // target the user's real browser, not the instance under test.
  const pid = execFileSync('pgrep', ['-f', `user-data-dir=${ext.profileDir}`]).toString().trim().split('\n')[0];
  execFileSync('osascript', ['-e', 'tell application "Finder" to activate']);
  await page.waitForTimeout(1000);
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
  ]);
  await page.waitForTimeout(1000);

  const rows = await events();
  const lost = rows.findIndex((e) => e.kind === 'chrome_focus_lost');
  const gained = rows.findIndex((e) => e.kind === 'chrome_focus_gained');

  expect(lost).toBeGreaterThanOrEqual(0);
  expect(gained).toBeGreaterThan(lost);

  await page.close();
});
