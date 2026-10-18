// Pie menu: which items become slices, and which slice a pointer is aiming at. Pure (no DOM, no
// chrome.*), so ordering, the "More…" overflow and direction selection are unit-testable.
import type { MenuItem } from './hotkeys';

export const PIE_MAX_SLICES = 8;

/** Built-in actions that always lead the ring, in this order. Matched by registration id. */
export const DEFAULT_PIE_ORDER = ['macro-repeat', 'macro-keep', 'macro-mark', 'stop', 'pause', 'search'] as const;

export type PieIcon = 'repeat' | 'keep' | 'mark' | 'stop' | 'pause' | 'search' | 'play' | 'folder' | 'panel' | 'more';

export interface PieSlice {
  /** "item" runs a menu entry; "more" opens the search list. */
  kind: 'item' | 'more';
  item?: MenuItem;
  letter: string;
  label: string;
  description: string;
  icon: PieIcon;
}

export function iconFor(item: MenuItem): PieIcon {
  if (item.kind === 'macro') return 'play';
  if (item.kind === 'space') return 'folder';
  switch (item.id) {
    case 'macro-repeat':
      return 'repeat';
    case 'macro-keep':
      return 'keep';
    case 'macro-mark':
      return 'mark';
    case 'stop':
      return 'stop';
    case 'pause':
      return 'pause';
    case 'search':
      return 'search';
    default:
      return 'panel';
  }
}

function toSlice(item: MenuItem): PieSlice {
  return {
    kind: 'item',
    item,
    letter: item.letter,
    label: item.short ?? item.label,
    description: item.description ?? item.label,
    icon: iconFor(item),
  };
}

/**
 * Orders the menu for the ring: the defaults first, then the user's macros, then spaces, then any other
 * action. Up to 8 items all get a slice; with more, the first 7 do and the 8th slice is "More…".
 * `overflow` is every item that did not get a slice (still reachable by its letter and the search list).
 */
export function pieLayout(items: MenuItem[]): { slices: PieSlice[]; overflow: MenuItem[] } {
  const rank = (i: MenuItem): number => {
    const d = (DEFAULT_PIE_ORDER as readonly string[]).indexOf(i.id);
    if (i.kind === 'action' && d >= 0) return d;
    if (i.kind === 'macro') return 100;
    if (i.kind === 'space') return 200;
    return 300;
  };
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.item.letter.localeCompare(b.item.letter) || a.index - b.index)
    .map((x) => x.item);

  if (ordered.length <= PIE_MAX_SLICES) return { slices: ordered.map(toSlice), overflow: [] };

  const shown = ordered.slice(0, PIE_MAX_SLICES - 1);
  const more: PieSlice = {
    kind: 'more',
    letter: '',
    label: 'More…',
    description: `${ordered.length - shown.length} more — search all`,
    icon: 'more',
  };
  return { slices: [...shown.map(toSlice), more], overflow: ordered.slice(PIE_MAX_SLICES - 1) };
}

/** Slice 0 is centered straight up; slices run clockwise. */
export function sliceAngles(n: number, index: number): { start: number; mid: number; end: number } {
  const step = (2 * Math.PI) / n;
  const mid = index * step;
  return { start: mid - step / 2, mid, end: mid + step / 2 };
}

/** Which slice a pointer offset (dx right, dy down, from the pie's center) is aiming at. */
export function sliceAtOffset(dx: number, dy: number, n: number): number {
  const angle = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
  const step = (2 * Math.PI) / n;
  return Math.round(angle / step) % n;
}

export type PointerTarget = { kind: 'slice'; index: number } | { kind: 'center' } | { kind: 'outside' };

/**
 * Aiming works by direction, so a click just beyond the ring still picks the slice you moved toward.
 * Inside `deadzone` is the center (nothing selected); beyond `reach` is "outside" (dismiss).
 */
export function pointerTarget(dx: number, dy: number, n: number, deadzone: number, reach: number): PointerTarget {
  const dist = Math.hypot(dx, dy);
  if (dist < deadzone) return { kind: 'center' };
  if (dist > reach) return { kind: 'outside' };
  return { kind: 'slice', index: sliceAtOffset(dx, dy, n) };
}
