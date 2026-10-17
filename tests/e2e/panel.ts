import { expect, type Locator, type Page } from '@playwright/test';

/** Shared side-panel navigation and lookup helpers. */

export function openTab(panel: Page, name: string): Promise<void> {
  return panel.getByRole('button', { name, exact: true }).click();
}

export async function openMacros(panel: Page): Promise<void> {
  await openTab(panel, 'Macros');
  await expect(panel.locator('.macro-palette-input')).toBeVisible();
}

/**
 * Finds a macro card by the name it is displaying.
 *
 * A `hasText` filter cannot do this. The name is rendered into an `<input>` so it can be edited
 * in place, and a controlled React input reflects its content in the `value` *property* only —
 * not in `innerText`, and not in the `value` attribute. Reading the live property is the only
 * reliable match, and polling covers the panel's 5-second refresh.
 */
export async function macroCard(panel: Page, name: string | RegExp): Promise<Locator> {
  const cards = panel.locator('.macro-row');
  const matches = (value: string): boolean =>
    typeof name === 'string' ? value.includes(name) : name.test(value);

  let index = -1;
  await expect
    .poll(
      async () => {
        const names = await cards
          .locator('.space-name-input')
          .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
        index = names.findIndex(matches);
        return index;
      },
      { message: `waiting for a macro card named ${String(name)}`, timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(0);

  return cards.nth(index);
}

/** The names of every macro card currently rendered, in display order. */
export function macroNames(panel: Page): Promise<string[]> {
  return panel
    .locator('.macro-row .space-name-input')
    .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
}

/** Labels of a card's steps, in display order. */
export function stepLabels(card: Locator): Promise<string[]> {
  return card.locator('.tab-list li .tab-title').allTextContents();
}
