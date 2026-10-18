/**
 * The Chrome implementation of `RunHost`.
 *
 * This is the only execution file that touches `chrome.*`. Every reference is inside a method
 * body rather than at module scope, so importing the module from Node stays safe — the same
 * discipline the rest of `lib/` follows.
 *
 * The contract the engine relies on: **every method settles.** `chrome.scripting.executeScript`
 * against a tab Chrome has frozen neither resolves nor rejects, so every injection here is raced
 * against a timer.
 */

import { MACRO_COMMAND_POLL_MS, MACRO_INJECT_TIMEOUT_MS } from './constants';
import { clickBySelector, typeIntoSelector } from './macro-injected';
import type { OpenedTabInfo, RunHost, TabCondition } from './macro-executor';
import { checkTypedStep } from './macro-privacy';
import { writeRunState } from './macro-run-channel';
import { getBlocklist, isUrlBlockedForMacros } from './privacy';
import { findOpenTabIdForUrl, focusTab as focusTabById, waitForTabComplete } from './tabs';
import type { MacroRunState, RunCommandName } from './types';

/**
 * Resolves to `fallback` if the promise has not settled in time.
 *
 * The underlying promise is left dangling on purpose: a frozen tab's injection may settle much
 * later, or never, and there is nothing useful to do with it either way.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface ChromeHostOptions {
  /** Supplied by the run loop so commands can be consumed with the right run id. */
  nextCommand: () => Promise<RunCommandName | null>;
  /** True when a Stop is pending; polled during sleeps so Stop takes effect within ~250ms. */
  stopPending?: () => Promise<boolean>;
}

export function createChromeHost(opts: ChromeHostOptions): RunHost {
  return {
    now: () => Date.now(),
    async sleep(ms) {
      // Without a stop probe this is the plain timer. With one, a long wait (pace, `wait` step, the
      // 15s pause heartbeat) is cut short as soon as a Stop is pending; the engine then drains it.
      if (!opts.stopPending) return new Promise<void>((resolve) => setTimeout(resolve, ms));
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(MACRO_COMMAND_POLL_MS, end - Date.now())));
        if (await opts.stopPending()) return;
      }
    },

    async openTab(url, { active }) {
      try {
        let windowId: number | undefined;
        try {
          windowId = (await chrome.windows.getLastFocused()).id;
        } catch {
          windowId = undefined;
        }
        const tab = await chrome.tabs.create({ url, active, windowId });
        return { tabId: tab.id, created: true } satisfies OpenedTabInfo;
      } catch (err) {
        return {
          created: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies OpenedTabInfo;
      }
    },

    async focusTab(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        await focusTabById(tab);
      } catch {
        /* the tab went away; the next step will report the real failure */
      }
    },

    awaitLoad: (tabId, timeoutMs) => waitForTabComplete(tabId, timeoutMs),

    async tabCondition(tabId): Promise<TabCondition | null> {
      try {
        const tab = (await chrome.tabs.get(tabId)) as chrome.tabs.Tab & { frozen?: boolean };
        // `frozen` is Chrome 132+. Leaving it undefined is fine — the injection timeout is the
        // real backstop, so there is no need to branch on feature detection.
        return { discarded: tab.discarded, frozen: tab.frozen };
      } catch {
        return null;
      }
    },

    async reloadTab(tabId) {
      try {
        await chrome.tabs.reload(tabId);
      } catch {
        /* best-effort */
      }
    },

    async setAutoDiscardable(tabId, value) {
      try {
        await chrome.tabs.update(tabId, { autoDiscardable: value });
      } catch {
        /* not fatal; the tab may simply not support it */
      }
    },

    async groupTabs(tabIds, title, focusFirst) {
      const [head, ...rest] = tabIds;
      if (head === undefined) return;
      try {
        const groupId = await chrome.tabs.group({ tabIds: [head, ...rest] });
        await chrome.tabGroups.update(groupId, { title, collapsed: false });
      } catch (err) {
        // Grouping fails when the tabs span windows. The run is still perfectly usable
        // ungrouped, so this is logged and swallowed rather than failing the step.
        console.warn('[cadence] could not group macro tabs', err);
      }
      if (focusFirst) {
        try {
          await focusTabById(await chrome.tabs.get(head));
        } catch {
          /* best-effort */
        }
      }
    },

    findTabForUrl: (url) => findOpenTabIdForUrl(url),

    async closeTabs(tabIds) {
      if (tabIds.length === 0) return;
      try {
        await chrome.tabs.remove(tabIds);
      } catch {
        /* some may already be closed */
      }
    },

    async probe(tabId, selector) {
      const results = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: clickBySelector,
          args: [selector, true],
        }),
        MACRO_INJECT_TIMEOUT_MS,
        [],
      );
      return results.some((r) => (r?.result as { found?: boolean } | undefined)?.found === true);
    },

    async click(tabId, selector) {
      const results = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: clickBySelector,
          args: [selector, false],
        }),
        MACRO_INJECT_TIMEOUT_MS,
        [],
      );
      // The collector runs in all frames but reports the top-level tab URL, so a recorded click
      // may belong to an iframe. Inject everywhere and accept success from any frame.
      const clicked = results.some(
        (r) => (r?.result as { clicked?: boolean } | undefined)?.clicked === true,
      );
      return clicked ? { clicked: true } : { clicked: false, reason: 'element not found' };
    },

    async isUrlBlocked(url) {
      return isUrlBlockedForMacros(url, await getBlocklist());
    },

    async type(tabId, selector, text) {
      // Replay-time half of the typed-value gate (the store-time half is db.addMacroStep).
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      const check = checkTypedStep({ text, url: tab?.url, selector }, await getBlocklist());
      if (!check.ok) return { ok: false, reason: `refused: ${check.reason}` };
      const results = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: typeIntoSelector,
          args: [selector, text],
        }),
        MACRO_INJECT_TIMEOUT_MS,
        [],
      );
      const outcomes = results
        .map((r) => r?.result as { ok?: boolean; reason?: string } | undefined)
        .filter((r): r is { ok?: boolean; reason?: string } => r !== undefined);

      if (outcomes.some((r) => r.ok === true)) return { ok: true };
      // Surface a real refusal (a password field) rather than a generic miss, so the engine
      // knows not to retry it.
      const refusal = outcomes.find((r) => r.reason && r.reason !== 'element not found');
      return { ok: false, reason: refusal?.reason ?? 'element not found' };
    },

    publish: (state: MacroRunState) => writeRunState(state),
    nextCommand: opts.nextCommand,
  };
}
