import { defineConfig } from '@playwright/test';

// Opt-in config: exercises the REAL deployed proxy. Run with `npm run test:e2e:live` and
//   WXT_PROXY_URL=https://... WXT_PROXY_TOKEN=... (the token is never printed).
// If either variable is missing, every test skips with a clear message instead of failing.
// Spec files use the `.live.ts` suffix so the default config (`*.spec.ts`) never picks them up.
export default defineConfig({
  testDir: './e2e/live',
  testMatch: '*.live.ts',
  timeout: 90000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
