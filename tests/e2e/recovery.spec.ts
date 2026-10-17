import { expect, test } from './fixtures';
import { macroCard, macroNames, openMacros } from './panel';

/** T8 — a run whose worker died is reported, never resumed. Plus the in-place run card. */

test.describe('T8 — crashed run recovery', () => {
  test('a stale run is finalized as interrupted and executes nothing', async ({
    harness,
    panel,
    context,
  }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    await macroCard(panel, 'ordering check');
    await harness.selectMacro(/ordering check/);

    const before = context.pages().length;
    await harness.plantCrashedRun();

    // Re-mount the panel so it reads the planted state the way it would after a worker death.
    await panel.reload();
    await openMacros(panel);

    const run = panel.locator('.run-panel');
    await expect(run).toBeVisible({ timeout: 20_000 });

    // Before this fix the panel rendered the dead run as live — "step 2 of 6" with working
    // Pause and Stop buttons — forever, because the event that would have corrected it is
    // precisely the heartbeat that stopped arriving.
    await expect(run).toContainText('Interrupted');
    await expect(run.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    await expect(run.getByRole('button', { name: 'Stop' })).toHaveCount(0);

    // The whole point: replaying half an executed click sequence is not safe, so recovery
    // reports the truth rather than picking up where the dead worker left off.
    await panel.waitForTimeout(3000);
    expect(context.pages().length).toBe(before);
  });

  test('the run view replaces that macro’s card rather than stacking above it', async ({
    harness,
    panel,
  }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    await macroCard(panel, 'ordering check');
    await harness.selectMacro(/ordering check/);
    await harness.plantCrashedRun();

    await panel.reload();
    await openMacros(panel);
    await expect(panel.locator('.run-panel')).toBeVisible({ timeout: 20_000 });

    // One card for one macro: while its run is on screen the macro's own card is gone, so the
    // controls sit with the thing they control instead of in a second card above the list.
    await expect.poll(() => macroNames(panel)).toEqual([]);
    await expect(panel.locator('.macro-row')).toHaveCount(0);

    await panel.locator('.run-panel').getByRole('button', { name: 'Dismiss' }).click();

    await expect(panel.locator('.run-panel')).toHaveCount(0);
    await expect.poll(() => macroNames(panel)).toEqual(['Harness — ordering check']);
  });

  test('a planted run does not block the next real run', async ({ harness, panel, context }) => {
    await harness.seedOrderingMacro();
    await openMacros(panel);
    await macroCard(panel, 'ordering check');
    await harness.selectMacro(/ordering check/);
    await harness.plantCrashedRun();

    await panel.reload();
    await openMacros(panel);
    await panel.locator('.run-panel').getByRole('button', { name: 'Dismiss' }).click();

    // A stale lock that outlived its worker must not wedge the feature permanently.
    const fresh = await macroCard(panel, 'ordering check');
    await fresh.getByRole('button', { name: 'Run', exact: true }).click();

    await expect
      .poll(() => context.pages().filter((p) => p.url().includes('/page-c')).length, {
        timeout: 60_000,
      })
      .toBe(1);
  });
});
