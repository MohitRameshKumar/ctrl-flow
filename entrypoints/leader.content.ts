// Leader-key pie menu (HOT-3). The UI is lib/pie-menu.ts, in a closed shadow root. It stays open until
// you choose, press Esc or click outside (10 s safety timeout). It never lets its own keystrokes or
// clicks reach the collector: while open it sets a flag the main content script checks.
import { createContentGuard } from '@/lib/content-guard';
import type { LeaderRepeatPreviewMessage, LeaderShowMessage } from '@/lib/hotkeys';
import type { LeaderToastMessage } from '@/lib/keep-feedback';
import { showToast } from '@/lib/toast';
import { mountPie, type PieController } from '@/lib/pie-menu';
import type { ContentMessage } from '@/lib/types';

const guard = createContentGuard();

function send(message: ContentMessage): void {
  if (!guard.alive()) return;
  try {
    chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    guard.teardown(); // "Extension context invalidated" is thrown synchronously
  }
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  // Top frame only: the overlay belongs to the page the user is looking at, not its iframes.
  allFrames: false,
  main() {
    let pie: PieController | null = null;

    function close(): void {
      pie?.destroy();
      pie = null;
    }

    function show(message: LeaderShowMessage): void {
      close();
      pie = mountPie(
        message.items,
        message.search,
        {
          runLetter: (letter, selection) => send({ type: 'leader_run', letter, ...(selection ? { selection } : {}) }),
          runSearchItem: (kind, id) => send({ type: 'leader_run_item', kind, id }),
          confirmRepeat: () => send({ type: 'leader_repeat_confirm' }),
          cancelRepeat: () => send({ type: 'leader_repeat_cancel' }),
        },
        () => {
          pie = null;
        },
      );
    }

    try {
      const onMessage = (message: unknown) => {
        if (!guard.alive()) return;
        const type = (message as { type?: string } | undefined)?.type;
        if (type === 'leader_show') show(message as LeaderShowMessage);
        else if (type === 'leader_toast') {
          const m = message as LeaderToastMessage;
          close();
          showToast({
            title: m.title,
            message: m.message,
            action: m.assign
              ? { label: `Assign ${m.assign.letter.toUpperCase()}`, run: () => send({ type: 'leader_assign_letter', macroId: m.assign!.macroId, letter: m.assign!.letter }) }
              : undefined,
          });
        } else if (type === 'leader_repeat_preview') {
          const m = message as LeaderRepeatPreviewMessage;
          pie?.setPreview(m.text, m.runnable);
        }
      };
      chrome.runtime.onMessage.addListener(onMessage);
      guard.onTeardown(() => {
        chrome.runtime.onMessage.removeListener(onMessage);
        close();
      });
    } catch {
      guard.teardown();
    }
  },
});
