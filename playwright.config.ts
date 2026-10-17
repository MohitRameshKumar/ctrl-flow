import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  timeout: 60000,
  // One worker: extension tests launch real Chromium instances, and this suite prioritizes
  // deterministic, reproducible results over speed.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  webServer: [
    {
      command: 'node e2e/mock-proxy.mjs',
      url: 'http://localhost:4411/health',
      reuseExistingServer: false,
      env: { MOCK_PROXY_PORT: '4411', MOCK_PROXY_TOKEN: 'test-token' },
    },
    {
      command: 'node e2e/fixtures-server.mjs',
      url: 'http://localhost:4412/health',
      reuseExistingServer: false,
      env: { FIXTURES_PORT: '4412' },
    },
  ],
});
