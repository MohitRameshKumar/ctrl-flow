// The leader-key pie menu, rendered into a closed shadow root so no page style leaks in or out.
// SVG-based, so it stays crisp at any zoom. Layout and aiming math live in pie-layout.ts.
import type { MenuItem, SearchItem } from './hotkeys';
import { pieLayout, pointerTarget, sliceAngles, type PieIcon, type PieSlice } from './pie-layout';

const FLAG = '__cadenceLeaderOpen';
/** Closes by itself if nothing happens (reset by any key or pointer movement). */
export const PIE_SAFETY_MS = 10_000;
const PREVIEW_MS = 20_000;
const NOTICE_MS = 4_000;

// viewBox is 340 x 340 centered on 0,0.
const INNER = 80;
const OUTER = 152;
const LABEL_R = 116;
const DEADZONE = 40;
/** Pointer farther than this from the center dismisses (in viewBox units; scaled to pixels at runtime). */
const REACH = 250;

const ICONS: Record<PieIcon, string> = {
  repeat: 'M17 1l4 4-4 4V6H8a4 4 0 0 0-4 4v1H2v-1a6 6 0 0 1 6-6h9V1zM7 23l-4-4 4-4v3h9a4 4 0 0 0 4-4v-1h2v1a6 6 0 0 1-6 6H7v3z',
  keep: 'M6 2h12a1 1 0 0 1 1 1v19l-7-4-7 4V3a1 1 0 0 1 1-1z',
  mark: 'M5 2v20h2v-8h11l-2-4 2-4H7V2H5z',
  stop: 'M6 6h12v12H6z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  search: 'M10 2a8 8 0 1 0 5 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z',
  play: 'M8 5v14l11-7z',
  folder: 'M3 5h7l2 2h9v13H3z',
  panel: 'M3 4h18v16H3V4zm11 2v12h5V6h-5z',
  more: 'M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
};

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .root {
    --bg: rgba(255,255,255,0.97); --slice: #eef0f4; --slice-hover: #2563eb; --ink: #14161b; --ink-dim: #5b6372;
    --on-accent: #ffffff; --ring: rgba(20,22,27,0.16); --scrim: rgba(15,17,22,0.22); --badge: #ffffff; --badge-ink: #14161b;
    position: fixed; inset: 0; z-index: 2147483647; font: 12px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--ink);
  }
  @media (prefers-color-scheme: dark) {
    .root { --bg: rgba(24,26,32,0.97); --slice: #2a2e38; --slice-hover: #3b82f6; --ink: #f2f4f8; --ink-dim: #a3abba;
      --ring: rgba(255,255,255,0.14); --scrim: rgba(0,0,0,0.38); --badge: #14161b; --badge-ink: #f2f4f8; }
  }
  .scrim { position: absolute; inset: 0; background: var(--scrim); }
  .pie { position: absolute; left: 50%; bottom: max(14px, 3vh); width: var(--s); height: var(--s);
    --s: min(340px, 92vw, 80vh); transform: translateX(-50%); }
  .rise { width: 100%; height: 100%; animation: rise 170ms cubic-bezier(0.16, 0.84, 0.3, 1) both; }
  @keyframes rise { from { transform: translateY(56px) scale(0.93); opacity: 0; } to { transform: none; opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .rise { animation: none; } }
  svg { width: 100%; height: 100%; display: block; overflow: visible; filter: drop-shadow(0 10px 26px rgba(0,0,0,0.32)); }
  .slice path.bg { fill: var(--slice); stroke: var(--ring); stroke-width: 1; transition: fill 90ms; }
  .slice.hover path.bg { fill: var(--slice-hover); }
  .slice .ico { fill: var(--ink); transition: fill 90ms; }
  .slice text { fill: var(--ink); font: 600 11.5px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; text-anchor: middle; pointer-events: none; }
  .slice.hover .ico, .slice.hover text { fill: var(--on-accent); }
  .badge circle { fill: var(--badge); stroke: var(--ring); stroke-width: 1; }
  .badge text { fill: var(--badge-ink); font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-anchor: middle; }
  .hub { fill: var(--bg); stroke: var(--ring); stroke-width: 1; }
  .center { position: absolute; left: 50%; top: 50%; width: 41%; transform: translate(-50%, -50%); text-align: center; pointer-events: none; }
  .c-title { font-weight: 700; font-size: 12.5px; margin-bottom: 3px; }
  .c-text { color: var(--ink-dim); font-size: 11px; display: -webkit-box; -webkit-line-clamp: 7; -webkit-box-orient: vertical; overflow: hidden; }
  .c-key { margin-top: 5px; font-size: 10px; color: var(--ink-dim); }
  .panel { position: absolute; left: 50%; bottom: max(14px, 3vh); transform: translateX(-50%); width: min(360px, 94vw);
    background: var(--bg); border: 1px solid var(--ring); border-radius: 14px; padding: 10px; box-shadow: 0 12px 34px rgba(0,0,0,0.34);
    animation: rise 170ms cubic-bezier(0.16, 0.84, 0.3, 1) both; }
  @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
  .panel input { width: 100%; padding: 7px 10px; margin-bottom: 6px; border-radius: 8px; border: 1px solid var(--ring);
    background: var(--slice); color: var(--ink); font: inherit; font-size: 13px; outline: none; }
  .panel input:focus { border-color: var(--slice-hover); }
  .row { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 7px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row.sel, .row:hover { background: var(--slice-hover); color: var(--on-accent); }
  .row .k { color: inherit; opacity: 0.7; font-size: 10px; text-transform: uppercase; min-width: 44px; }
  .empty { color: var(--ink-dim); padding: 6px 8px; }
  .hint { color: var(--ink-dim); font-size: 10.5px; margin-top: 6px; }
`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function pt(r: number, a: number): [number, number] {
  return [r * Math.sin(a), -r * Math.cos(a)];
}

function sectorPath(a0: number, a1: number): string {
  const gap = 0.018;
  const [s, e] = [a0 + gap, a1 - gap];
  const [ox0, oy0] = pt(OUTER, s);
  const [ox1, oy1] = pt(OUTER, e);
  const [ix1, iy1] = pt(INNER, e);
  const [ix0, iy0] = pt(INNER, s);
  return `M${ox0},${oy0} A${OUTER},${OUTER} 0 0 1 ${ox1},${oy1} L${ix1},${iy1} A${INNER},${INNER} 0 0 0 ${ix0},${iy0} Z`;
}

function sliceSvg(slice: PieSlice, index: number, n: number): string {
  const { start, mid, end } = sliceAngles(n, index);
  const [lx, ly] = pt(LABEL_R, mid);
  // The badge sits on the icon's top-right corner, so it can never collide with the label below it.
  const [bx, by] = [lx + 17, ly - 21];
  const scale = 1.05;
  const iconX = lx - 12 * scale;
  const iconY = ly - 19;
  return (
    `<g class="slice" data-i="${index}">` +
    `<path class="bg" d="${sectorPath(start, end)}"/>` +
    `<g class="ico" transform="translate(${iconX},${iconY}) scale(${scale})"><path d="${ICONS[slice.icon]}" fill-rule="evenodd"/></g>` +
    `<text x="${lx}" y="${ly + 17}">${esc(truncate(slice.label, 9))}</text>` +
    (slice.letter
      ? `<g class="badge" transform="translate(${bx},${by})"><circle r="9"/><text y="3.5">${esc(slice.letter.toUpperCase())}</text></g>`
      : '') +
    `</g>`
  );
}

export interface PieHandlers {
  /** Run the entry on this letter (background `leader_run`). */
  runLetter(letter: string): void;
  runSearchItem(kind: SearchItem['kind'], id: number): void;
  confirmRepeat(): void;
  cancelRepeat(): void;
}

export interface PieController {
  setPreview(text: string, runnable: boolean): void;
  destroy(): void;
}

type Mode = 'pie' | 'search' | 'preview' | 'notice';

export function mountPie(
  items: MenuItem[],
  search: SearchItem[],
  handlers: PieHandlers,
  onClosed: () => void,
): PieController {
  const { slices } = pieLayout(items);
  const letterToItem = new Map(items.map((i) => [i.letter, i] as const));

  const host = document.createElement('div');
  host.id = 'cadence-leader-host';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const wrap = document.createElement('div');
  wrap.className = 'root';
  root.append(style, wrap);

  let mode: Mode = 'pie';
  let hovered = -1;
  let centerTitle = 'Cadence';
  let centerText = 'Press a letter, or aim and click.';
  let centerKey = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let query = '';
  let selected = 0;
  let destroyed = false;

  (globalThis as unknown as Record<string, boolean>)[FLAG] = true;

  function arm(ms = PIE_SAFETY_MS): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (mode === 'preview') handlers.cancelRepeat();
      destroy();
    }, ms);
  }

  function matches(): SearchItem[] {
    const q = query.trim().toLowerCase();
    // Overflow items (macros / spaces without a slice) are already in the search list.
    return search.filter((s) => !q || s.label.toLowerCase().includes(q)).slice(0, 8);
  }

  function renderPie(): void {
    const n = slices.length;
    wrap.innerHTML =
      `<div class="scrim"></div><div class="pie"><div class="rise">` +
      `<svg viewBox="-170 -170 340 340" role="menu" aria-label="Cadence leader menu">` +
      slices.map((s, i) => sliceSvg(s, i, n)).join('') +
      `<circle class="hub" r="${INNER - 4}"/></svg>` +
      `<div class="center"><div class="c-title"></div><div class="c-text"></div><div class="c-key"></div></div>` +
      `</div></div>`;
    paintCenter();
    paintHover();
  }

  function paintCenter(): void {
    const t = wrap.querySelector('.c-title');
    const x = wrap.querySelector('.c-text');
    const k = wrap.querySelector('.c-key');
    if (t) t.textContent = centerTitle;
    if (x) {
      x.textContent = centerText;
      x.setAttribute('title', centerText);
    }
    if (k) k.textContent = centerKey;
  }

  function paintHover(): void {
    wrap.querySelectorAll('.slice').forEach((el) => {
      el.classList.toggle('hover', Number((el as HTMLElement).dataset.i) === hovered);
    });
  }

  function setCenter(title: string, text: string, key = ''): void {
    centerTitle = title;
    centerText = text;
    centerKey = key;
    paintCenter();
  }

  function showHover(index: number): void {
    if (mode !== 'pie' || index === hovered) return;
    hovered = index;
    paintHover();
    const s = slices[index];
    if (s) setCenter(s.label, s.description, s.letter ? s.letter.toUpperCase() : '');
    else setCenter('Cadence', 'Press a letter, or aim and click.');
  }

  function renderSearch(): void {
    mode = 'search';
    const list = matches();
    selected = Math.min(selected, Math.max(0, list.length - 1));
    wrap.innerHTML =
      `<div class="scrim"></div><div class="panel"><input id="q" placeholder="Search spaces, rituals & macros…" value="${esc(query)}"/>` +
      (list.length === 0
        ? `<div class="empty">No matches</div>`
        : list
            .map((s, i) => `<div class="row${i === selected ? ' sel' : ''}" data-s="${i}"><span class="k">${esc(s.kind)}</span>${esc(s.label)}</div>`)
            .join('')) +
      `<div class="hint">↑↓ choose · Enter run · Esc close</div></div>`;
    const input = wrap.querySelector<HTMLInputElement>('#q');
    input?.addEventListener('input', () => {
      query = input.value;
      selected = 0;
      renderSearch();
    });
    input?.focus();
    input?.setSelectionRange(query.length, query.length);
    wrap.querySelectorAll<HTMLElement>('.row[data-s]').forEach((row) => {
      row.addEventListener('click', () => pick(Number(row.dataset.s)));
    });
    wrap.querySelector('.scrim')?.addEventListener('click', () => destroy());
    arm();
  }

  function pick(i: number): void {
    const s = matches()[i];
    if (s) handlers.runSearchItem(s.kind, s.id);
    destroy();
  }

  function activate(slice: PieSlice): void {
    if (slice.kind === 'more') {
      renderSearch();
      return;
    }
    const item = slice.item!;
    runItem(item);
  }

  function runItem(item: MenuItem): void {
    if (item.id === 'search') {
      renderSearch();
      return;
    }
    if (item.id === 'open_panel') {
      // chrome.sidePanel.open() needs a user gesture that a relayed key press does not carry.
      notice('Open the panel', 'Click the Cadence icon in the toolbar to open the panel.');
      return;
    }
    handlers.runLetter(item.letter);
    if (item.id === 'macro-repeat') {
      mode = 'notice';
      setCenter('Repeat', 'Working out what to repeat…');
      arm();
      return;
    }
    destroy();
  }

  function notice(title: string, text: string): void {
    mode = 'notice';
    setCenter(title, text);
    arm(NOTICE_MS);
  }

  function pieCenterOffset(e: MouseEvent): { dx: number; dy: number; scale: number } | null {
    const svg = wrap.querySelector('svg');
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const scale = r.width / 340; // pixels per viewBox unit
    return { dx: (e.clientX - (r.left + r.width / 2)) / scale, dy: (e.clientY - (r.top + r.height / 2)) / scale, scale };
  }

  function onMove(e: MouseEvent): void {
    if (mode !== 'pie') return;
    arm();
    const o = pieCenterOffset(e);
    if (!o) return;
    const t = pointerTarget(o.dx, o.dy, slices.length, DEADZONE, REACH);
    if (t.kind === 'slice') showHover(t.index);
    else showHover(-1);
  }

  function onClick(e: MouseEvent): void {
    if (mode === 'search') return;
    const o = pieCenterOffset(e);
    if (!o || mode !== 'pie') {
      if (mode === 'notice') destroy();
      return;
    }
    const t = pointerTarget(o.dx, o.dy, slices.length, DEADZONE, REACH);
    if (t.kind === 'outside') destroy();
    else if (t.kind === 'slice') {
      const s = slices[t.index];
      if (s) activate(s);
    }
  }

  function swallow(e: Event): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onKey(e: KeyboardEvent): void {
    // Letters here can run macros: a page script must not be able to press them for the user.
    if (!e.isTrusted) return;
    arm(mode === 'preview' ? PREVIEW_MS : PIE_SAFETY_MS);

    if (e.key === 'Escape') {
      swallow(e);
      if (mode === 'preview') handlers.cancelRepeat();
      destroy();
      return;
    }

    if (mode === 'preview') {
      swallow(e);
      if (e.key === 'Enter') {
        handlers.confirmRepeat();
        destroy();
      }
      return;
    }

    if (mode === 'search') {
      const list = matches();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        swallow(e);
        if (list.length > 0) selected = (selected + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
        renderSearch();
      } else if (e.key === 'Enter') {
        swallow(e);
        pick(selected);
      }
      return; // typing goes to the overlay's own input
    }

    swallow(e);
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (mode !== 'pie') return;
    const item = letterToItem.get(e.key.toLowerCase());
    if (item) runItem(item);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    (globalThis as unknown as Record<string, boolean>)[FLAG] = false;
    onClosed();
  }

  wrap.addEventListener('mousemove', onMove);
  wrap.addEventListener('click', onClick);
  window.addEventListener('keydown', onKey, true);
  renderPie();
  document.documentElement.appendChild(host);
  arm();

  return {
    setPreview(text, runnable) {
      if (destroyed) return;
      if (mode === 'search') return;
      if (runnable) {
        mode = 'preview';
        setCenter('Repeat', text);
        arm(PREVIEW_MS);
      } else {
        notice('Repeat', text);
      }
    },
    destroy,
  };
}
