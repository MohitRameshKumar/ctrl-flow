import { expect, killServiceWorker, test } from './fixtures';
import { macroCard, openMacros } from './panel';

/** T9, T10 — the collector's blind spots, and the privacy rules. */

test.describe('T9 — capture', () => {
  test('the tab you are sitting on is recorded when the worker wakes', async ({
    harness,
    panel,
    context,
    server,
    sw,
  }) => {
    const page = await context.newPage();
    await page.goto(`${server.origin}/page-a`);
    await page.bringToFront();
    await expect.poll(async () => (await harness.events()).length).toBeGreaterThan(0);

    // Session storage outlives the worker, so the once-per-session guard has to be cleared by
    // hand to reproduce a cold start.
    await sw.evaluate(() => chrome.storage.session.remove('activeTabsSeeded'));

    const restartedAt = Date.now();
    await killServiceWorker(context, page);

    // Woken by a message from the panel rather than by touching the tab under test. Reloading
    // page-a would wake it too, but that writes a `navigated` for the same tab and URL first,
    // and the 1500ms dedupe would then correctly collapse the seeded row — measuring the
    // dedupe instead of the seeding.
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'wake' }).catch(() => {}));

    // `onActivated` never fires for a tab you simply stay on, so a `tab_activated` for page-a
    // can only have come from the seeding path. That gap is what made it invisible before.

    await expect
      .poll(
        async () => {
          const events = await harness.events();
          return events.filter(
            (e) =>
              e.kind === 'tab_activated' &&
              typeof e.url === 'string' &&
              e.url.includes('/page-a') &&
              (e.ts as number) >= restartedAt,
          ).length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  });

  test('history.pushState navigation is captured', async ({ harness, context, server }) => {
    const page = await context.newPage();
    await page.goto(`${server.origin}/spa`);
    await page.getByRole('button', { name: 'two' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'three' }).click();

    // `onCommitted` never fires for these, so before the SPA listener this produced zero events
    // — and most repetitive knowledge work happens inside exactly this kind of navigation.
    await expect
      .poll(
        async () => {
          const events = await harness.events();
          return new Set(
            events
              .filter((e) => e.kind === 'navigated' && String(e.url).includes('/spa/'))
              .map((e) => e.url),
          ).size;
        },
        { timeout: 30_000 },
      )
      .toBe(2);
  });
});

test.describe('T10 — privacy and the self-reinforcement fix', () => {
  test('running a macro does not make Cadence more confident in it', async ({
    harness,
    panel,
  }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    const card = await macroCard(panel, 'ordering check');

    const occurrencesOf = async () =>
      (await harness.macros()).find((m) => m.macroKey === 'm:harness-ordering')
        ?.occurrences as number;
    const before = await occurrencesOf();

    await card.getByRole('button', { name: 'Run', exact: true }).click();
    await expect
      .poll(async () => (await harness.runChannel()).macroRun, { timeout: 60_000 })
      .toMatchObject({ status: expect.stringMatching(/done|stopped|interrupted/) });

    await panel.getByRole('button', { name: 'Scan now' }).click();
    await expect(panel.getByRole('button', { name: 'Working…' })).toHaveCount(0);

    // A run writes real navigation events. Counting those as another occurrence of the macro
    // that produced them would make every run raise Cadence's confidence in it, forever.
    await expect.poll(occurrencesOf).toBe(before);
  });

  test('the replay flag is cleared once a run ends', async ({ harness, panel }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    const card = await macroCard(panel, 'ordering check');
    await card.getByRole('button', { name: 'Run', exact: true }).click();

    // A flag left set silently stops all collection and all offers, which looks exactly like
    // the feature breaking.
    await expect
      .poll(async () => (await harness.runChannel()).macroReplayInProgress, { timeout: 60_000 })
      .toBeFalsy();
  });

  test('stored events carry no page content and nothing blocklisted', async ({
    harness,
    context,
    server,
  }) => {
    const page = await context.newPage();
    await page.goto(`${server.origin}/page-a`);
    await page.locator('#more').click();
    await page.goto(`${server.origin}/page-b`);
    await page.locator('#searchInput').fill('some typed text');
    await page.waitForTimeout(1500);

    const events = await harness.events();
    expect(events.length).toBeGreaterThan(0);

    const summarize = (rows: Array<Record<string, unknown>>) =>
      rows.map((e) => ({ kind: e.kind, url: e.url, label: e.label }));

    // `textContent` is the whole subtree, so an uncapped label used to capture page prose
    // verbatim. This is the only path by which page text is stored at all.
    expect(
      summarize(events.filter((e) => typeof e.label === 'string' && e.label.length > 40)),
    ).toEqual([]);

    // A row whose URL failed to normalize used to be written anyway, bypassing the blocklist.
    // Focus events are windowed, not tabbed, so they legitimately carry no URL.
    //
    // This catches the condition opportunistically rather than provoking it: a urlless
    // `tab_activated` was observed once in a run where the worker restarted, but no reliable
    // way to reproduce it on demand was found, so treat a pass here as the absence of evidence.
    const urlless = events.filter(
      (e) => !e.url && e.kind !== 'chrome_focus_lost' && e.kind !== 'chrome_focus_gained',
    );
    expect(summarize(urlless)).toEqual([]);

    // Keystrokes are counted, never captured.
    expect(JSON.stringify(events)).not.toContain('some typed text');
  });
});
