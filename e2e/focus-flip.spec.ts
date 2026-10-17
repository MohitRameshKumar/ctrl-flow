import { expect, test, type Page } from '@playwright/test';
import { callHook, closeExtension, FIXTURES_ORIGIN, launchExtension, sidePanelUrl, type ExtensionHandle } from './helpers';

const W_URL = `${FIXTURES_ORIGIN}/test-page.html`;
const R_URL = `${FIXTURES_ORIGIN}/long-page.html`;
const TYPED_SECRET = 'zqxjkvmarker';

interface PairRow {
  id: number;
  writingUrl: string;
  referenceUrl: string;
  roundTripTs: number[];
  dwellSamples: number[];
  pauseSamples: number[];
  active: boolean;
}
interface EventRow {
  kind: string;
  url?: string;
  programmatic?: boolean;
}

let ext: ExtensionHandle;
let writing: Page;
let reference: Page;

test.beforeAll(async () => {
  ext = await launchExtension();
});
test.afterAll(async () => {
  await closeExtension(ext);
});

test.beforeEach(async () => {
  await callHook(ext.sw, 'clearAllTables');
  await ext.sw.evaluate(() => chrome.storage.session.clear());
  await callHook(ext.sw, 'setPaused', false);
  await callHook(ext.sw, 'setDemoMode', true);
  await callHook(ext.sw, 'setFocusProbe', true); // don't depend on the OS keeping Chromium frontmost
  await setFlipEnabled(false);
  writing = await ext.context.newPage();
  await writing.goto(W_URL);
  reference = await ext.context.newPage();
  await reference.goto(R_URL);
});

test.afterEach(async () => {
  await setFlipEnabled(false);
  await writing.close();
  await reference.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pairs = () => callHook<PairRow[]>(ext.sw, 'readTable', 'flipPairs');
const events = () => callHook<EventRow[]>(ext.sw, 'readTable', 'events');

async function setFlipEnabled(enabled: boolean) {
  await ext.sw.evaluate((v) => chrome.storage.local.set({ focusFlipEnabled: v }), enabled);
  await wait(150);
}
async function activeUrl(): Promise<string | undefined> {
  return ext.sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url);
}
async function flipState() {
  return ext.sw.evaluate(async () => (await chrome.storage.session.get('flipState')).flipState ?? null);
}
async function waitForActive(url: string, timeout: number) {
  await expect.poll(activeUrl, { timeout, intervals: [100] }).toBe(url);
}
async function typeInWriting(text: string, field = '#plain-input') {
  await writing.bringToFront();
  await writing.click(field);
  await writing.keyboard.type(text);
}

/** writing -> reference -> writing, typing in the writing tab first, leaving ~2 s after the last key. */
async function roundTrip() {
  await typeInWriting('abc');
  await wait(2500);
  await reference.bringToFront();
  await wait(1300);
  await writing.bringToFront();
  await wait(300);
}

async function seedActivePair() {
  await callHook(ext.sw, 'seedTable', 'flipPairs', [
    {
      writingUrl: W_URL,
      referenceUrl: R_URL,
      roundTripTs: [],
      dwellSamples: [3000],
      pauseSamples: [2000],
      active: true,
      updatedAt: Date.now(),
    },
  ]);
}

async function learnPair() {
  await setFlipEnabled(true);
  await roundTrip();
  await roundTrip();
  await expect.poll(async () => (await pairs())[0]?.active, { timeout: 5000 }).toBe(true);
}

test('Focus Flip is off by default', async () => {
  const stored = await ext.sw.evaluate(async () => (await chrome.storage.local.get('focusFlipEnabled')).focusFlipEnabled);
  // beforeEach turned it off explicitly; the install default is checked in the side panel test below.
  expect(stored).toBe(false);
});

test('toggle off: round trips learn nothing and an active pair does not flip', async () => {
  await roundTrip();
  await roundTrip();
  await roundTrip();
  expect(await pairs()).toHaveLength(0);

  await seedActivePair();
  await wait(5200);
  await typeInWriting('hello');
  await wait(4500);
  expect(await activeUrl()).toBe(W_URL);
  expect(await flipState()).toBeNull();
});

test('toggle on: learns a pair after 2 round trips (demo mode), then flips to the reference and back', async () => {
  await learnPair();
  const [pair] = await pairs();
  expect(pair).toMatchObject({ writingUrl: W_URL, referenceUrl: R_URL, active: true });
  expect(pair!.roundTripTs).toHaveLength(2);

  await wait(5200); // the user's own switch must be > 5 s old
  const typedAt = Date.now();
  await typeInWriting('hello');
  await waitForActive(R_URL, 8000);
  const flippedAfter = Date.now() - typedAt;
  expect(flippedAfter).toBeGreaterThan(1800); // never before the learned pause (>= 2 s)
  const shownAt = Date.now();

  await waitForActive(W_URL, 8000);
  const shownFor = Date.now() - shownAt;
  expect(shownFor).toBeGreaterThan(2500); // learned dwell is clamped to >= 3 s
  expect(shownFor).toBeLessThan(5500);
  expect(await flipState()).toBeNull();
});

test('scrolling the reference tab during a flip cancels the automatic return', async () => {
  await learnPair();
  await wait(5200);
  await typeInWriting('hello');
  await waitForActive(R_URL, 8000);
  await wait(1100); // past the post-flip grace period
  await reference.evaluate(() => window.scrollBy(0, 400));
  await wait(4500); // well past the 3 s dwell
  expect(await activeUrl()).toBe(R_URL);
  expect(await flipState()).toBeNull();
});

test('clicking in the reference tab cancels the return too', async () => {
  await learnPair();
  await wait(5200);
  await typeInWriting('hello');
  await waitForActive(R_URL, 8000);
  await wait(1100);
  await reference.click('h1');
  await wait(4500);
  expect(await activeUrl()).toBe(R_URL);
});

test('switching tabs yourself during a flip cancels it', async () => {
  await learnPair();
  await wait(5200);
  await typeInWriting('hello');
  await waitForActive(R_URL, 8000);
  const other = await ext.context.newPage();
  await other.goto(`${FIXTURES_ORIGIN}/second-page.html`);
  await wait(4500);
  expect(await activeUrl()).toBe(`${FIXTURES_ORIGIN}/second-page.html`);
  await other.close();
});

test('turning the toggle off mid-flip stops it immediately', async () => {
  await learnPair();
  await wait(5200);
  await typeInWriting('hello');
  await waitForActive(R_URL, 8000);
  await setFlipEnabled(false);
  expect(await flipState()).toBeNull();
  await wait(4500);
  expect(await activeUrl()).toBe(R_URL);
});

test('never flips while paused, when Chrome is not focused, with a sensitive field focused, or right after a manual switch', async () => {
  await learnPair();
  await wait(5200);

  await callHook(ext.sw, 'setPaused', true);
  await typeInWriting('one');
  await wait(4500);
  expect(await activeUrl()).toBe(W_URL);
  await callHook(ext.sw, 'setPaused', false);

  await callHook(ext.sw, 'setFocusProbe', false);
  await typeInWriting('two');
  await wait(4500);
  expect(await activeUrl()).toBe(W_URL);
  await callHook(ext.sw, 'setFocusProbe', true);

  await typeInWriting('ab', '#password-field'); // sensitive field focused
  await wait(4500);
  expect(await activeUrl()).toBe(W_URL);
  await writing.click('#plain-button'); // leave the sensitive field
  await wait(300);

  // Just switched manually (< 5 s ago): the 2 s pause elapses first, so no flip.
  await reference.bringToFront();
  await wait(300);
  await typeInWriting('three');
  await wait(4000);
  expect(await activeUrl()).toBe(W_URL);
});

test('Cadence-initiated switches are flagged, do not create Spaces offers, and are not learned from', async () => {
  const now = Date.now();
  await callHook(ext.sw, 'seedTable', 'spaces', [
    { id: 1, name: 'Writing space', status: 'user', createdAt: now, updatedAt: now },
    { id: 2, name: 'Reading space', status: 'user', createdAt: now, updatedAt: now },
  ]);
  await callHook(ext.sw, 'seedTable', 'spaceUrls', [
    { spaceId: 1, url: W_URL, source: 'user', alwaysOpen: false },
    { spaceId: 2, url: R_URL, source: 'user', alwaysOpen: false },
  ]);
  await learnPair();
  const pairBefore = (await pairs())[0]!;

  // Make the reading space look like the user had been there 35 s: if the flip's programmatic
  // activation counted, a "Switch to Reading space?" offer would be created immediately.
  await callHook(ext.sw, 'seedEvents', [
    { ts: Date.now() - 40000, kind: 'tab_activated', url: R_URL, title: 'Reference article' },
    { ts: Date.now() - 5200, kind: 'tab_activated', url: W_URL, title: 'Cadence test page' },
  ]);
  const notificationsBefore = Object.keys(await ext.sw.evaluate(() => chrome.notifications.getAll()));

  await wait(5200);
  await typeInWriting('hello');
  await waitForActive(R_URL, 8000);
  await wait(800);
  await waitForActive(W_URL, 8000);
  await wait(500);

  expect(Object.keys(await ext.sw.evaluate(() => chrome.notifications.getAll()))).toEqual(notificationsBefore);
  const pending = await ext.sw.evaluate(async () => (await chrome.storage.session.get('pendingSwitchSuggestion')).pendingSwitchSuggestion ?? null);
  expect(pending).toBeNull();

  const flagged = (await events()).filter((e) => e.kind === 'tab_activated' && e.programmatic);
  expect(flagged.map((e) => e.url)).toEqual(expect.arrayContaining([R_URL, W_URL]));
  // The flip's own switches did not count as a round trip.
  const pairAfter = (await pairs())[0]!;
  expect(pairAfter.roundTripTs).toEqual(pairBefore.roundTripTs);
});

test('only counts, timestamps and urls are stored: no typed text, keys or scroll positions', async () => {
  await learnPair();
  await wait(5200);
  await typeInWriting(TYPED_SECRET);
  await waitForActive(R_URL, 8000);
  await wait(1100);
  await reference.evaluate(() => window.scrollBy(0, 777));
  await wait(500);

  const [pair] = await pairs();
  expect(Object.keys(pair!).sort()).toEqual(
    ['active', 'dwellSamples', 'id', 'pauseSamples', 'referenceUrl', 'roundTripTs', 'updatedAt', 'writingUrl'],
  );
  const dump = JSON.stringify({
    ...Object.fromEntries(
      await Promise.all(
        ['events', 'flipPairs', 'rituals', 'spaces', 'spaceUrls'].map(async (t) => [t, await callHook(ext.sw, 'readTable', t)]),
      ),
    ),
    local: await ext.sw.evaluate(() => chrome.storage.local.get(null)),
    session: await ext.sw.evaluate(() => chrome.storage.session.get(null)),
  });
  expect(dump).not.toContain(TYPED_SECRET);
  expect(dump).not.toContain('777');
  // Activity pulses are never written to the event log.
  const kinds = new Set((await events()).map((e) => e.kind));
  expect([...kinds].every((k) => ['tab_opened', 'tab_activated', 'tab_closed', 'navigated', 'click', 'field_changed', 'typing_burst', 'chrome_focus_lost', 'chrome_focus_gained'].includes(k))).toBe(true);
});

test('side panel: toggle starts off, flip indicator counts down with a working "Stay here", pairs list has Remove', async () => {
  await ext.sw.evaluate(() => chrome.storage.local.remove('focusFlipEnabled'));
  const panel = await ext.context.newPage();
  await panel.goto(sidePanelUrl(ext.extensionId));
  const checkbox = panel.locator('.focus-flip input[type=checkbox]');
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect.poll(() => ext.sw.evaluate(async () => (await chrome.storage.local.get('focusFlipEnabled')).focusFlipEnabled)).toBe(true);

  await roundTrip();
  await roundTrip();
  await expect(panel.locator('.flip-pairs li')).toHaveCount(1, { timeout: 8000 });
  await expect(panel.locator('.flip-pairs li')).toContainText('pause');
  await expect(panel.locator('.flip-pairs li')).toContainText('dwell');

  await wait(5200);
  await typeInWriting('hello');
  await waitForActive(R_URL, 8000);
  await expect(panel.locator('.flip-indicator')).toContainText('Flipping back in', { timeout: 5000 });
  await panel.click('.flip-indicator button:text("Stay here")');
  await wait(4500);
  expect(await activeUrl()).toBe(R_URL);
  await expect(panel.locator('.flip-indicator')).toHaveCount(0);

  await panel.click('.flip-pairs button:text("Remove")');
  await expect(panel.locator('.flip-pairs li')).toHaveCount(0);
  expect(await pairs()).toHaveLength(0);
  await panel.close();
});
