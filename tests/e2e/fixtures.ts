import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { startTestServer, type TestServer } from './server';

/**
 * Deterministic because `wxt.config.ts` pins a `key`, which is what the id is derived from.
 * Hardcoded rather than discovered so a change to that key fails one clear assertion instead of
 * every test at once for an unrelated-looking reason.
 */
export const EXTENSION_ID = 'likggcapbkekeffagciamplbcmcobfcd';

const BUILD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../.output/chrome-mv3');

export interface CadenceFixtures {
  context: BrowserContext;
  /** The MV3 background service worker, for driving `chrome.*` directly. */
  sw: Worker;
  server: TestServer;
  /**
   * The side panel, opened as an ordinary tab.
   *
   * `chrome.sidePanel` UI is browser chrome and cannot be driven by Playwright, but
   * `sidepanel.html` is a normal extension page and the React app runs identically in a tab.
   *
   * One real consequence, asserted rather than hidden: `isSidePanelOpen()` checks for a
   * `SIDE_PANEL` context type, so a tab-hosted panel reads as *closed* and the notification
   * branch fires alongside the card. The offer is written to session storage before that branch,
   * so the banner still renders — which is the surface these tests care about.
   */
  panel: Page;
  debug: Page;
  /** Seeds and state-forcing, driven through the same debug-page buttons a human uses. */
  harness: Harness;
}

export class Harness {
  constructor(
    private page: Page,
    private readonly sw: Worker,
    private readonly context: BrowserContext,
  ) {}

  /**
   * Returns a live debug page, re-opening it if it was destroyed.
   *
   * `chrome.runtime.reload()` tears down every extension page, and the capture tests use
   * exactly that to force a cold worker start. Without this the reload silently breaks every
   * later read and the failure points at the reader rather than the reload.
   */
  private async debugPage(): Promise<Page> {
    if (!this.page.isClosed()) return this.page;

    const page = await this.context.newPage();
    // While the extension is restarting, its pages answer ERR_BLOCKED_BY_CLIENT rather than
    // simply being slow, so this retries instead of waiting on a load that will never come.
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await page.goto(`chrome-extension://${EXTENSION_ID}/debug.html`);
        this.page = page;
        return page;
      } catch (err) {
        lastError = err;
        await page.waitForTimeout(250);
      }
    }
    throw new Error(`Extension pages never came back after reload: ${String(lastError)}`);
  }

  /** Points `lib/dev-fixtures` at the local server before anything is seeded. */
  async useOrigin(origin: string): Promise<void> {
    await this.sw.evaluate(
      (value) => chrome.storage.local.set({ harnessOrigin: value }),
      origin,
    );
  }

  private async click(label: string): Promise<string> {
    const page = await this.debugPage();
    await page.getByRole('button', { name: label }).click();
    const note = page.locator('.harness-note');
    await expect(note).toBeVisible({ timeout: 20_000 });
    return (await note.textContent()) ?? '';
  }

  seedOrderingMacro(): Promise<string> {
    return this.click('1 · Seed ordering macro');
  }

  seedParamHistory(): Promise<string> {
    return this.click('2 · Seed {pull} history + rescan');
  }

  async selectMacro(name: string | RegExp): Promise<void> {
    const page = await this.debugPage();
    const select = page.locator('.harness select');
    const option = select.locator('option', { hasText: name }).first();
    await select.selectOption((await option.getAttribute('value')) ?? '');
  }

  makeAuto(): Promise<string> {
    return this.click('3 · Make it auto (5 clean runs)');
  }

  plantCrashedRun(): Promise<string> {
    return this.click('4 · Plant a crashed run');
  }

  clearStuck(): Promise<string> {
    return this.click('Clear stuck run / replay flag');
  }

  /** Reads back whatever the run channel is holding. */
  async runChannel(): Promise<Record<string, unknown>> {
    return this.sw.evaluate(() =>
      chrome.storage.session.get(['macroRun', 'macroReplayInProgress', 'pendingMacroOffer']),
    );
  }

  /**
   * Reads a Dexie table straight out of IndexedDB from an extension page.
   *
   * Deliberately not through the debug UI's table: that renders only the most recent 50 rows,
   * which would make a privacy assertion pass simply by not looking at the older ones.
   */
  private async table(name: string): Promise<Array<Record<string, unknown>>> {
    const page = await this.debugPage();
    return page.evaluate(async (store) => {
      const db = await new Promise<IDBDatabase>((ok, fail) => {
        const req = indexedDB.open('cadence');
        req.onsuccess = () => ok(req.result);
        req.onerror = () => fail(req.error);
      });
      return new Promise<Array<Record<string, unknown>>>((ok, fail) => {
        const tx = db.transaction(store, 'readonly').objectStore(store).getAll();
        tx.onsuccess = () => ok(tx.result as Array<Record<string, unknown>>);
        tx.onerror = () => fail(tx.error);
      });
    }, name);
  }

  events(): Promise<Array<Record<string, unknown>>> {
    return this.table('events');
  }

  macros(): Promise<Array<Record<string, unknown>>> {
    return this.table('macros');
  }
}

/**
 * Kills the extension's service worker so the next event starts a fresh one.
 *
 * `chrome.runtime.reload()` is the obvious approach and is wrong here: on an extension loaded
 * with `--load-extension` it unloads for good, and every extension page then answers
 * ERR_BLOCKED_BY_CLIENT. Closing the worker's CDP target instead reproduces what Chrome itself
 * does at the 30-second idle kill, leaving the extension installed and session storage intact.
 */
export async function killServiceWorker(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const { targetInfos } = (await cdp.send('Target.getTargets')) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  };
  const worker = targetInfos.find(
    (t) => t.type === 'service_worker' && t.url.includes(EXTENSION_ID),
  );
  if (!worker) throw new Error('No extension service worker target to stop');
  await cdp.send('Target.closeTarget', { targetId: worker.targetId });
  await cdp.detach();
}

export const test = base.extend<CadenceFixtures>({
  // A fresh profile per test. Slower than sharing one, but IndexedDB and session storage carry
  // macro state, and a test that inherited another's macros would be untrustworthy. It also
  // makes every test a genuine browser start, which is what T9 needs.
  context: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'cadence-e2e-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: process.env.E2E_HEADED !== '1',
      args: [
        `--disable-extensions-except=${BUILD_DIR}`,
        `--load-extension=${BUILD_DIR}`,
        '--no-first-run',
      ],
    });
    await use(context);
    await context.close();
    await rm(profile, { recursive: true, force: true });
  },

  sw: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    expect(
      id,
      'Extension id changed — update EXTENSION_ID, or restore the `key` in wxt.config.ts',
    ).toBe(EXTENSION_ID);
    await use(worker);
  },

  server: async ({}, use) => {
    const server = await startTestServer();
    await use(server);
    await server.close();
  },

  debug: async ({ context, sw }, use) => {
    void sw;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/debug.html`);
    await use(page);
  },

  panel: async ({ context, sw }, use) => {
    void sw;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
    await use(page);
  },

  harness: async ({ context, debug, sw, server }, use) => {
    const harness = new Harness(debug, sw, context);
    await harness.useOrigin(server.origin);
    await use(harness);
  },
});

export { expect } from '@playwright/test';
