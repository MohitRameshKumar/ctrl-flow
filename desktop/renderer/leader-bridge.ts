/**
 * Makes the native overlay window look like the page overlay to `lib/leader.ts`.
 *
 * The trick that keeps `lib/` untouched: `lib/leader.ts` shows the menu by calling
 * `chrome.tabs.sendMessage(tabId, { type: 'leader_show', ... })`, and `lib/macro-leaders.ts` sends
 * `leader_repeat_preview` the same way. Here `tabs.sendMessage` intercepts exactly those two and
 * forwards them to the overlay window instead of a page.
 *
 * Everything else falls out for free:
 *   - keys pressed in the overlay come back as `runtime.onMessage`, which `background.ts` already
 *     routes to `runLeaderLetter` / `runSearchItem` / `confirmRepeat` / `cancelRepeat`
 *   - `lib/hotkeys.ts` still owns letters, reservations and conflicts
 *   - the R preview still flows through `previewRepeat` -> `tabs.sendMessage`
 *
 * The one piece deliberately *not* reused is `handleLeaderCommand`. It decides between the overlay
 * and the side panel by testing `canHostOverlay(tab.url)`, because a content script cannot be
 * injected into `chrome://` pages or the new tab page. A native window has no such limit, and
 * routing through that check would send the user to the Settings tab whenever they pressed the
 * leader key on a new tab — one of the exact gaps this port set out to close. So the menu is built
 * here from the same `getMenu()` / `getSearchItems()` the extension uses, and shown directly.
 */

import type { CadenceNative } from '../preload';
import type { InstalledShim, ShimSender } from './chrome-shim';
import { deliverMessage, setRegisteredCommands } from './chrome-shim';
import { getTabBackend, setTabBackend, type TabBackend } from './chrome-shim/tabs';
import { getActiveTabSync } from './browser-bridge';

interface LeaderMessage {
  type?: string;
  text?: string;
  runnable?: boolean;
}

export function installLeaderBridge(native: CadenceNative, shim: InstalledShim): void {
  /* ---- outbound: lib/ -> the overlay window ---- */

  const inner = getTabBackend();
  setTabBackend({
    ...inner,
    async sendMessage(tabId: number, message: unknown) {
      const msg = message as LeaderMessage;

      if (msg?.type === 'leader_show') {
        await native.overlay.show(message);
        return undefined;
      }
      if (msg?.type === 'leader_repeat_preview') {
        await native.overlay.preview({ text: msg.text ?? '', runnable: msg.runnable === true });
        return undefined;
      }
      // Anything else genuinely has no receiving end: there is no content script on desktop.
      return inner.sendMessage(tabId, message);
    },
  } satisfies TabBackend);

  /* ---- inbound: the overlay window -> lib/ ---- */

  native.overlay.onMessage((message) => {
    // Attribute to the active tab so `runLeaderLetter` gets a usable LeaderContext — Repeat and
    // Keep are both relative to what the user was just looking at.
    const active = getActiveTabSync();
    const sender: ShimSender = active
      ? { tab: { id: active.id, url: active.url, windowId: active.windowId }, frameId: 0 }
      : { frameId: 0 };
    void deliverMessage(message, sender);
  });

  /* ---- the global hotkey ---- */

  native.onCommand((command) => {
    const active = getActiveTabSync();
    const tab = active
      ? { id: active.id, url: active.url, windowId: active.windowId, title: active.title }
      : undefined;

    if (command === 'leader-key') {
      void showLeaderMenu();
      return;
    }

    // Everything else (the macro palette) is handled by `background.ts`'s own listener, which
    // needs the tab to find a window to open the panel on.
    shim.events.commands.onCommand.emit(command, tab);
  });

  /** Builds the menu with the same code the extension uses, then shows the native overlay. */
  async function showLeaderMenu(): Promise<void> {
    try {
      const { getMenu, getSearchItems } = await import('@/lib/leader');
      const [items, search] = await Promise.all([getMenu(), getSearchItems()]);
      await native.overlay.show({ type: 'leader_show', items, search });
    } catch (err) {
      console.error('[cadence] could not show the leader overlay', err);
    }
  }

  /* ---- chrome.commands.getAll() ---- */

  void native.commands.getAll().then(setRegisteredCommands);
  native.commands.onRegistered(setRegisteredCommands);
}
