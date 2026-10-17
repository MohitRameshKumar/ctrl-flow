import { expect, test, type Harness } from './fixtures';
import { macroCard, openMacros, stepLabels } from './panel';
import type { Locator, Page } from '@playwright/test';

/** T4, T5, T11 — step authoring, parameterization, and the edit contract. */

async function seedOrdering(harness: Harness, panel: Page): Promise<Locator> {
  await harness.seedOrderingMacro();
  await openMacros(panel);
  return macroCard(panel, 'ordering check');
}

test.describe('T4 — authoring the step kinds detection never records', () => {
  test('a hand-added wait step is stored, labeled, and reorderable', async ({ harness, panel }) => {
    const card = await seedOrdering(harness, panel);

    await card.getByRole('button', { name: '+ Add step' }).click();
    await card.locator('.add-step select').first().selectOption('wait');
    await card.locator('.add-step-field input').first().fill('3');
    await card.getByRole('button', { name: 'Add', exact: true }).click();

    await expect
      .poll(async () => (await stepLabels(card)).filter((l) => l.includes('Wait 3s')).length)
      .toBe(1);

    // Added at the end, then walked up. Reordering across kinds only started mattering once the
    // executor stopped batching every open ahead of everything else.
    const before = (await stepLabels(card)).findIndex((l) => l.includes('Wait 3s'));
    await card
      .locator('.tab-list li', { hasText: 'Wait 3s' })
      .getByTitle('Move up')
      .click();
    await expect
      .poll(async () => (await stepLabels(card)).findIndex((l) => l.includes('Wait 3s')))
      .toBe(before - 1);
  });

  test('a type step carries its text and is marked experimental', async ({ harness, panel }) => {
    const card = await seedOrdering(harness, panel);

    const typeStep = card.locator('.tab-list li', { hasText: 'Type into' });
    await expect(typeStep).toHaveCount(1);
    // Clicks and typing are the unreliable half of replay; the UI has to say so rather than
    // implying parity with opening a tab.
    await expect(typeStep.locator('.macro-chip')).toHaveText('experimental');
  });
});

test.describe('T5 — parameterized macros', () => {
  test('mines one {pull} parameter, not one per page that mentions it', async ({
    harness,
    panel,
  }) => {
    const note = await harness.seedParamHistory();
    expect(note).toContain('{pull}');
    expect(note).toContain('812, 904, 977');

    await openMacros(panel);
    await panel.getByRole('button', { name: 'Save macro' }).first().click();

    const card = await macroCard(panel, /.+/);
    const params = card.locator('.macro-params .add-step-field');

    // The regression that matters: `/pull/812` and `/pull/812/files` vary at the same position
    // over the same values, so naming the second `pull2` would make the form demand the same
    // ticket twice.
    await expect(params).toHaveCount(1);
    await expect(params.locator('span')).toHaveText('pull');
    await expect(card.locator('.macro-params input')).toHaveValue('977');
    await expect(card.locator('.macro-params')).toContainText('812, 904, 977');
  });

  test('running with an override opens that ticket', async ({ harness, panel, context }) => {
    await harness.seedParamHistory();
    await openMacros(panel);
    await panel.getByRole('button', { name: 'Save macro' }).first().click();

    const card = await macroCard(panel, /.+/);
    await card.locator('.macro-params input').fill('1234');
    await card.getByRole('button', { name: 'Run', exact: true }).click();

    await expect
      .poll(() => context.pages().filter((p) => p.url().includes('/pull/1234')).length, {
        timeout: 45_000,
      })
      .toBeGreaterThan(0);
  });
});

test.describe('T11 — the edit contract survives a rescan', () => {
  test('rename, untick and remove all stick through Scan now', async ({ harness, panel }) => {
    // Seeded history gives `Scan now` something real to re-mine, which is the only way the
    // detector could clobber an edit.
    await harness.seedParamHistory();
    const card = await seedOrdering(harness, panel);

    await card.locator('.space-name-input').fill('My renamed routine');
    await card.locator('.space-name-input').blur();

    const labelsBefore = await stepLabels(card);
    const removed = labelsBefore[1]!;
    await card.locator('.tab-list li').nth(1).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(async () => (await stepLabels(card)).length).toBe(labelsBefore.length - 1);

    // `.uncheck()` rather than `.click()` would fail here, and the reason is worth recording:
    // the checkbox is controlled by `step.enabled` with no optimistic update, so it springs
    // back to checked until the Dexie write and the refresh land. Harmless in practice, but it
    // means the UI briefly shows the opposite of what the user just chose.
    const toggle = card.locator('.tab-list li').first().locator('input[type="checkbox"]');
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    await panel.getByRole('button', { name: 'Scan now' }).click();
    await expect(panel.getByRole('button', { name: 'Working…' })).toHaveCount(0);

    const renamed = await macroCard(panel, 'My renamed routine');
    await expect(
      renamed.locator('.tab-list li').first().locator('input[type="checkbox"]'),
    ).not.toBeChecked();
    await expect
      .poll(async () => (await stepLabels(renamed)).filter((l) => l === removed).length)
      .toBe(0);
  });
});
