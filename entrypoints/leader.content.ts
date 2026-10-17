// Leader-key overlay (HOT-3). Lives in a closed-off shadow DOM so no page style leaks in or out,
// closes after 2 s or on Esc, and never lets its own keystrokes reach the collector: while open it
// sets a flag the main content script checks, and it swallows keys before the page sees them.
import { createContentGuard } from '@/lib/content-guard';
import type { LeaderRepeatPreviewMessage, LeaderShowMessage, MenuItem, SearchItem } from '@/lib/hotkeys';
import type { ContentMessage } from '@/lib/types';

const HOST_ID = 'cadence-leader-host';
const CLOSE_AFTER_MS = 2000;
const OPEN_FLAG = '__cadenceLeaderOpen';

const STYLE = `
  :host { all: initial; }
  .box { position: fixed; top: 16px; right: 16px; z-index: 2147483647; min-width: 240px; max-width: 340px;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #f5f5f5;
    background: rgba(24,24,27,0.96); border-radius: 10px; padding: 10px 12px; box-shadow: 0 8px 28px rgba(0,0,0,0.4); }
  .title { font-weight: 600; margin-bottom: 6px; opacity: 0.8; font-size: 12px; }
  .row { display: flex; gap: 10px; padding: 3px 0; align-items: baseline; }
  .row.soon { opacity: 0.45; }
  .row.sel { background: rgba(255,255,255,0.14); border-radius: 4px; }
  kbd { min-width: 20px; text-align: center; background: #3f3f46; border-radius: 4px; padding: 1px 6px; font: 600 12px monospace; }
  input { width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 5px 8px; border-radius: 6px; border: 1px solid #52525b;
    background: #27272a; color: #fff; font: inherit; outline: none; }
  .hint { opacity: 0.55; font-size: 11px; margin-top: 6px; }
`;

function setFlag(open: boolean): void {
  (globalThis as unknown as Record<string, boolean>)[OPEN_FLAG] = open;
}

const guard = createContentGuard();

function send(message: ContentMessage): void {
  if (!guard.alive()) return;
  try {
    chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    guard.teardown(); // "Extension context invalidated" is thrown synchronously
  }
}

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  // Top frame only: the overlay belongs to the page the user is looking at, not its iframes.
  allFrames: false,
  main() {
    let host: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function close(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
      previewMode = false;
      window.removeEventListener('keydown', onKey, true);
      host?.remove();
      host = null;
      setFlag(false);
    }

    function swallow(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    let items: MenuItem[] = [];
    /** R's "Repeat N steps?" preview is showing: Enter runs it, Esc cancels it. */
    let previewMode = false;
    let searchItems: SearchItem[] = [];
    let searchMode = false;
    let selected = 0;
    let query = '';
    let box: HTMLElement | null = null;

    function matches(): SearchItem[] {
      const q = query.trim().toLowerCase();
      return searchItems.filter((s) => !q || s.label.toLowerCase().includes(q)).slice(0, 8);
    }

    function renderMenu(): void {
      if (!box) return;
      box.innerHTML =
        `<div class="title">Cadence · press a letter</div>` +
        items
          .map(
            (i) =>
              `<div class="row"><kbd>${escapeText(i.letter.toUpperCase())}</kbd><span>${escapeText(i.label)}</span></div>`,
          )
          .join('') +
        `<div class="hint">Esc to close</div>`;
    }

    function renderSearch(): void {
      if (!box) return;
      const list = matches();
      selected = Math.min(selected, Math.max(0, list.length - 1));
      box.innerHTML =
        `<div class="title">Search spaces, rituals &amp; macros</div><input id="q" placeholder="Type to filter…" value="${escapeText(query)}" />` +
        (list.length === 0
          ? `<div class="row soon">No matches</div>`
          : list
              .map(
                (s, idx) =>
                  `<div class="row${idx === selected ? ' sel' : ''}"><kbd>${s.kind === 'space' ? 'S' : 'R'}</kbd><span>${escapeText(s.label)}</span></div>`,
              )
              .join('')) +
        `<div class="hint">↑↓ to move · Enter to open · Esc to close</div>`;
      const input = box.querySelector<HTMLInputElement>('#q');
      input?.addEventListener('input', () => {
        query = input.value;
        selected = 0;
        renderSearch();
      });
      input?.focus();
      input?.setSelectionRange(query.length, query.length);
    }

    function onKey(e: KeyboardEvent): void {
      // Letters here can run macros: a page script must not be able to press them for the user.
      if (!e.isTrusted) return;
      if (previewMode) {
        if (e.key === 'Enter') {
          swallow(e);
          send({ type: 'leader_repeat_confirm' });
          close();
        } else if (e.key === 'Escape') {
          swallow(e);
          send({ type: 'leader_repeat_cancel' });
          close();
        } else {
          swallow(e); // nothing else is a command while a preview is waiting
        }
        return;
      }

      if (e.key === 'Escape') {
        swallow(e);
        close();
        return;
      }

      if (searchMode) {
        // Typing happens in the overlay's own input; only intercept navigation keys.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          swallow(e);
          const n = matches().length;
          if (n > 0) selected = (selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
          renderSearch();
        } else if (e.key === 'Enter') {
          swallow(e);
          const pick = matches()[selected];
          if (pick) send({ type: 'leader_run_item', kind: pick.kind, id: pick.id });
          close();
        }
        // Everything else goes to the overlay's own input; its `input` event updates the filter.
        return;
      }

      swallow(e);
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      const item = items.find((i) => i.letter === e.key.toLowerCase());
      if (!item) return;
      if (item.id === 'search') {
        searchMode = true;
        if (timer) clearTimeout(timer); // searching: no auto-close
        timer = undefined;
        renderSearch();
        return;
      }
      if (item.id === 'open_panel') {
        // chrome.sidePanel.open() needs a user gesture, which a key press relayed through the
        // background does not carry. The toolbar icon is set to open the panel on click, so point there.
        showNotice('Click the Cadence icon in the toolbar to open the panel.');
        return;
      }
      send({ type: 'leader_run', letter: item.letter });
      if (item.id === 'macro-repeat') {
        // The background answers with a preview; keep the overlay up for it instead of closing.
        showNotice('Working out what to repeat…');
        timer = setTimeout(close, 6000);
        return;
      }
      close();
    }

    function showPreview(message: LeaderRepeatPreviewMessage): void {
      if (!box) return;
      box.innerHTML = `<div class="title">Cadence · repeat</div><div class="row">${escapeText(message.text)}</div>`;
      if (timer) clearTimeout(timer);
      if (message.runnable) {
        previewMode = true;
        // Left waiting long enough to read, then cancelled rather than run.
        timer = setTimeout(() => {
          send({ type: 'leader_repeat_cancel' });
          close();
        }, 20000);
      } else {
        timer = setTimeout(close, 3500);
      }
    }

    function showNotice(text: string): void {
      if (!box) return;
      box.innerHTML = `<div class="title">Cadence</div><div class="row">${escapeText(text)}</div>`;
      if (timer) clearTimeout(timer);
      timer = setTimeout(close, 3500);
    }

    function show(message: LeaderShowMessage): void {
      close();
      items = message.items;
      searchItems = message.search;
      searchMode = false;
      previewMode = false;
      query = '';
      selected = 0;

      host = document.createElement('div');
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = STYLE;
      box = document.createElement('div');
      box.className = 'box';
      root.append(style, box);
      renderMenu();
      document.documentElement.appendChild(host);

      setFlag(true);
      window.addEventListener('keydown', onKey, true);
      timer = setTimeout(close, CLOSE_AFTER_MS);
    }

    try {
      const onMessage = (message: unknown) => {
        if (!guard.alive()) return;
        const type = (message as { type?: string } | undefined)?.type;
        if (type === 'leader_show') show(message as LeaderShowMessage);
        else if (type === 'leader_repeat_preview') showPreview(message as LeaderRepeatPreviewMessage);
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
