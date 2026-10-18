/**
 * The leader overlay, as a native window.
 *
 * A port of `entrypoints/leader.content.ts`'s behaviour — same letters, same search mode, same
 * repeat preview, same auto-close — but rendered in a frameless always-on-top Electron window
 * rather than injected into the page.
 *
 * This is strictly better than the content-script version and removes code rather than adding it:
 *   - it works on `chrome://` pages and the new tab page, the extension's documented dead zone
 *   - it works when Chrome is not the focused app
 *   - no injection, no re-injection fallback, no "Leader key unavailable on this page"
 *   - page scripts cannot reach an OS window, so the `isTrusted` check it replaces is moot
 *
 * The *decisions* still live in `lib/hotkeys.ts` and `lib/leader.ts`; this file only renders what
 * it is given and reports back which letter was pressed.
 */

import type { LeaderShowMessage, MenuItem, SearchItem } from '@/lib/hotkeys';

const CLOSE_AFTER_MS = 2500;
const PREVIEW_WAIT_MS = 20_000;
const NOTICE_MS = 3500;

interface OverlayApi {
  onShow(cb: (payload: LeaderShowMessage) => void): void;
  onPreview(cb: (payload: { text: string; runnable: boolean }) => void): void;
  onNotice(cb: (text: string) => void): void;
  send(message: unknown): void;
  close(): void;
  resize(height: number): void;
}

const api = (window as unknown as { cadenceOverlay: OverlayApi }).cadenceOverlay;
const box = document.getElementById('box')!;

let items: MenuItem[] = [];
let searchItems: SearchItem[] = [];
let searchMode = false;
let previewMode = false;
let selected = 0;
let query = '';
let timer: ReturnType<typeof setTimeout> | undefined;

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** The window is sized to its content so the panel never floats in dead space. */
function fit(): void {
  api.resize(Math.ceil(box.getBoundingClientRect().height) + 20);
}

function armClose(ms = CLOSE_AFTER_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => close(), ms);
}

function close(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  searchMode = false;
  previewMode = false;
  query = '';
  selected = 0;
  api.close();
}

function matches(): SearchItem[] {
  const q = query.trim().toLowerCase();
  return searchItems.filter((s) => !q || s.label.toLowerCase().includes(q)).slice(0, 8);
}

function renderMenu(): void {
  box.innerHTML =
    `<div class="title">Cadence · press a letter</div>` +
    items
      .map(
        (i) =>
          `<div class="row"><kbd>${escapeText(i.letter.toUpperCase())}</kbd><span>${escapeText(i.label)}</span></div>`,
      )
      .join('') +
    `<div class="hint">Esc to close</div>`;
  fit();
}

function renderSearch(): void {
  const list = matches();
  selected = Math.min(selected, Math.max(0, list.length - 1));
  box.innerHTML =
    `<div class="title">Search spaces, rituals &amp; macros</div>` +
    `<input id="q" placeholder="Type to filter…" value="${escapeText(query)}" />` +
    (list.length === 0
      ? `<div class="empty">No matches</div>`
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
  fit();
}

function showNotice(text: string, ms = NOTICE_MS): void {
  box.innerHTML = `<div class="title">Cadence</div><div class="row"><span>${escapeText(text)}</span></div>`;
  fit();
  armClose(ms);
}

function onKey(e: KeyboardEvent): void {
  if (previewMode) {
    if (e.key === 'Enter') {
      e.preventDefault();
      api.send({ type: 'leader_repeat_confirm' });
      close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      api.send({ type: 'leader_repeat_cancel' });
      close();
    } else {
      e.preventDefault(); // nothing else is a command while a preview is waiting
    }
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }

  if (searchMode) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = matches().length;
      if (n > 0) selected = (selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = matches()[selected];
      if (pick) api.send({ type: 'leader_run_item', kind: pick.kind, id: pick.id });
      close();
    }
    // Everything else belongs to the input; its `input` handler refilters.
    return;
  }

  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();

  const item = items.find((i) => i.letter === e.key.toLowerCase());
  if (!item) return;

  if (item.id === 'search') {
    searchMode = true;
    if (timer) clearTimeout(timer); // searching: no auto-close
    timer = undefined;
    renderSearch();
    return;
  }

  api.send({ type: 'leader_run', letter: item.letter });

  if (item.id === 'macro-repeat') {
    // R answers asynchronously with a preview; hold the overlay open for it.
    showNotice('Working out what to repeat…', 6000);
    return;
  }
  close();
}

api.onShow((payload) => {
  items = payload.items ?? [];
  searchItems = payload.search ?? [];
  searchMode = false;
  previewMode = false;
  query = '';
  selected = 0;
  renderMenu();
  armClose();
});

api.onPreview(({ text, runnable }) => {
  box.innerHTML = `<div class="title">Cadence · repeat</div><div class="row"><span>${escapeText(text)}</span></div>`;
  fit();
  if (timer) clearTimeout(timer);
  if (runnable) {
    previewMode = true;
    // Long enough to read, then cancelled rather than run — never run something unattended.
    timer = setTimeout(() => {
      api.send({ type: 'leader_repeat_cancel' });
      close();
    }, PREVIEW_WAIT_MS);
  } else {
    armClose(NOTICE_MS);
  }
});

api.onNotice((text) => showNotice(text));

window.addEventListener('keydown', onKey, true);
// Clicking away dismisses, matching the content-script overlay's "gets out of the way" feel.
window.addEventListener('blur', () => {
  if (!previewMode && !searchMode) close();
});
