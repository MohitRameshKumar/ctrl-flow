import { expect, test } from './fixtures';

/**
 * Proves the harness itself works before any behavior is asserted on top of it.
 *
 * When extension loading, the service worker handle, or the pinned id breaks, every other spec
 * fails at once and for a misleading reason. This one fails first and says what actually went
 * wrong.
 */
test('the extension loads and its pages render', async ({ sw, debug, panel, server }) => {
  expect(sw.url()).toContain('background');
  await expect(debug.locator('h1')).toHaveText('Cadence Debug');
  await expect(debug.locator('.harness h2')).toHaveText('Test harness');
  await expect(panel.locator('body')).toContainText(/Macros|Rituals|Spaces/);

  const page = await debug.context().newPage();
  await page.goto(`${server.origin}/page-b`);
  await expect(page.locator('#searchInput')).toBeVisible();
});
