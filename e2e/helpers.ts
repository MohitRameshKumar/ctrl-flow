import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
export const FIXTURES_ORIGIN = `http://localhost:${process.env.FIXTURES_PORT ?? 4412}`;
export const MOCK_PROXY_ORIGIN = `http://localhost:${process.env.MOCK_PROXY_PORT ?? 4411}`;

export interface ExtensionHandle {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  profileDir: string;
}

/** Launches Playwright's bundled Chromium (never the system's Google Chrome, which no
 * longer supports --load-extension) with a fresh, isolated temp profile. */
export async function launchExtension(): Promise<ExtensionHandle> {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-e2e-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = sw.url().split('/')[2] ?? '';

  return { context, sw, extensionId, profileDir };
}

export async function closeExtension(handle: ExtensionHandle): Promise<void> {
  await handle.context.close();
  fs.rmSync(handle.profileDir, { recursive: true, force: true });
}

/** Calls a method on globalThis.__cadenceTest inside the service worker. */
export async function callHook<T = unknown>(sw: Worker, method: string, ...args: unknown[]): Promise<T> {
  return sw.evaluate(
    ({ method, args }) => {
      // @ts-expect-error -- test-only global, not declared in this isolated evaluate context
      return globalThis.__cadenceTest[method](...args);
    },
    { method, args },
  );
}

export function sidePanelUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/sidepanel.html`;
}

export function debugPageUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/debug.html`;
}
