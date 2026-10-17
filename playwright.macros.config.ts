import { defineConfig } from '@playwright/test';

/**
 * End-to-end suite for the macro executor, run against the built extension.
 *
 * These cover what the vitest suite structurally cannot: the pure detectors and the executor
 * loop are already tested against fakes, but nothing there proves a real MV3 service worker
 * drives real tabs, or that the side panel and the worker agree over session storage.
 *
 * Requires `npm run build` first — the suite loads `.output/chrome-mv3`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Rebuilds first: the suite loads `.output/chrome-mv3`, and testing a stale build produces
  // failures that look like product bugs.
  globalSetup: './tests/e2e/global-setup.ts',
  // Extensions need a real browser profile and a service worker; running several at once makes
  // tab-count and focus assertions race each other.
  workers: 1,
  fullyParallel: false,
  // A run opens tabs and waits on page loads, so the default 30s is tight.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? 'line' : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
