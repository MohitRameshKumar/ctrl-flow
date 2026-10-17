import { expect, test } from './fixtures';
import { macroCard, openMacros, openTab } from './panel';
import type { Page } from '@playwright/test';
import type { TestServer } from './server';

/** T6, T7 — the proactive half: noticing a routine in flight, and running one unattended. */

/**
 * Performs the first two steps of the seeded macro by hand, the way a user would.
 *
 * Real navigations in a real tab, because that is what the collector listens to — writing
 * events straight into Dexie would skip the entire path under test.
 */
async function doFirstTwoSteps(page: Page, server: TestServer): Promise<void> {
  await page.goto(`${server.origin}/page-a`);
  await page.waitForTimeout(400);
  await page.goto(`${server.origin}/page-b`);
}

test.describe('T6 — offering to finish a routine already under way', () => {
  test('the banner appears even while the panel sits on another tab', async ({
    harness,
    panel,
    context,
    server,
  }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    await macroCard(panel, 'ordering check');

    // Deliberately parked away from Macros. The old dual-surface rule only asked whether a panel
    // existed, not which tab was mounted, so an offer raised here was written and seen by nobody.
    await openTab(panel, 'Rituals');

    const page = await context.newPage();
    await doFirstTwoSteps(page, server);

    const banner = panel.locator('.macro-offer');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('first 2 steps');
    await expect(banner).toContainText('remaining 1');
  });

  test('accepting opens only what is left', async ({ harness, panel, context, server }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    await macroCard(panel, 'ordering check');

    const page = await context.newPage();
    await doFirstTwoSteps(page, server);

    const banner = panel.locator('.macro-offer');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await banner.getByRole('button', { name: 'Finish it' }).click();

    await expect
      .poll(() => context.pages().filter((p) => p.url().includes('/page-c')).length, {
        timeout: 45_000,
      })
      .toBe(1);
  });

  test('stays quiet when nothing is left to do', async ({ harness, panel, context, server }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    await macroCard(panel, 'ordering check');

    // With the last page already open there is nothing useful to offer, so silence here is the
    // feature working rather than failing.
    const last = await context.newPage();
    await last.goto(`${server.origin}/page-c`);

    const page = await context.newPage();
    await doFirstTwoSteps(page, server);

    await page.waitForTimeout(6000);
    await expect(panel.locator('.macro-offer')).toHaveCount(0);
  });
});

test.describe('T7 — auto-run', () => {
  test.beforeEach(async ({ panel }) => {
    await openTab(panel, 'Macros');
    // `.check()` would fail: like the per-step toggles, this checkbox is controlled by state
    // that only updates after the storage write round-trips, so it reads as unchanged at the
    // instant of the click.
    const optIn = panel.getByRole('checkbox', { name: 'Let trusted macros run themselves' });
    await optIn.click();
    await expect(optIn).toBeChecked();
  });

  test('counts down, and cancelling demotes the macro', async ({
    harness,
    panel,
    context,
    server,
  }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    await macroCard(panel, 'ordering check');
    await harness.selectMacro(/ordering check/);
    await harness.makeAuto();

    const page = await context.newPage();
    await doFirstTwoSteps(page, server);

    const banner = panel.locator('.macro-offer');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText(/Running on its own in \d+s/);

    await banner.getByRole('button', { name: 'Cancel' }).click();

    // One cancel is the strongest "no" available, so trust resets all the way.
    await expect
      .poll(async () => {
        const macros = await harness.macros();
        return macros.find((m) => m.macroKey === 'm:harness-ordering')?.status;
      })
      .toBe('accepted');
    await expect(panel.locator('.macro-offer')).toHaveCount(0);
  });

  test('left alone it fires, silently, without taking focus', async ({
    harness,
    panel,
    context,
    server,
  }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    await macroCard(panel, 'ordering check');
    await harness.selectMacro(/ordering check/);
    await harness.makeAuto();

    const page = await context.newPage();
    await doFirstTwoSteps(page, server);
    await expect(panel.locator('.macro-offer')).toBeVisible({ timeout: 30_000 });

    // The countdown is 10s; the run then opens what remains. Auto-runs force silent mode
    // regardless of the playback setting, so the tab the user was on keeps focus.
    await expect
      .poll(() => context.pages().filter((p) => p.url().includes('/page-c')).length, {
        timeout: 60_000,
      })
      .toBe(1);

    const focused = await page.evaluate(() => document.visibilityState);
    expect(focused).toBe('visible');
  });
});
