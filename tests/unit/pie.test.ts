import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planLetterCleanup, type MenuItem } from '../../lib/hotkeys.ts';
import { PIE_MAX_SLICES, pieLayout, pointerTarget, sliceAtOffset } from '../../lib/pie-layout.ts';

const action = (letter: string, id: string): MenuItem => ({ letter, id, label: id, kind: 'action' });
const macro = (letter: string, id: string): MenuItem => ({ letter, id, label: `Macro: ${id}`, kind: 'macro', short: id });
const space = (letter: string, id: string): MenuItem => ({ letter, id, label: `Project: ${id}`, kind: 'space', short: id });

const defaults = [
  action('p', 'pause'),
  action('s', 'stop'),
  action('/', 'search'),
  action('m', 'macro-mark'),
  action('r', 'macro-repeat'),
  action('k', 'macro-keep'),
];

test('pie: defaults lead in a fixed order (R K M S P /), then macros, then spaces', () => {
  const { slices, overflow } = pieLayout([space('w', '7'), macro('g', '3'), ...defaults]);
  assert.deepEqual(slices.map((s) => s.letter), ['r', 'k', 'm', 's', 'p', '/', 'g', 'w']);
  assert.deepEqual(slices.map((s) => s.icon), ['repeat', 'keep', 'mark', 'stop', 'pause', 'search', 'play', 'folder']);
  assert.equal(overflow.length, 0);
  assert.equal(slices.length, PIE_MAX_SLICES);
});

test('pie: exactly 8 items get 8 slices and no "More…"; 9 items get 7 slices plus "More…"', () => {
  const eight = pieLayout([...defaults, macro('g', '1'), macro('h', '2')]);
  assert.equal(eight.slices.length, 8);
  assert.ok(eight.slices.every((s) => s.kind === 'item'));

  const nine = pieLayout([...defaults, macro('g', '1'), macro('h', '2'), macro('j', '3')]);
  assert.equal(nine.slices.length, 8);
  assert.equal(nine.slices[7]!.kind, 'more');
  assert.equal(nine.slices[7]!.label, 'More…');
  assert.deepEqual(nine.slices.slice(0, 7).map((s) => s.letter), ['r', 'k', 'm', 's', 'p', '/', 'g']);
  assert.deepEqual(nine.overflow.map((i) => i.letter), ['h', 'j']);
});

test('pie: macros sort by letter within their group, and other actions (E) come last', () => {
  const { slices } = pieLayout([action('e', 'open_panel'), macro('z', '1'), macro('b', '2'), ...defaults.slice(0, 2)]);
  assert.deepEqual(slices.map((s) => s.letter), ['s', 'p', 'b', 'z', 'e']);
});

test('aiming: slice 0 is straight up and slices run clockwise', () => {
  assert.equal(sliceAtOffset(0, -100, 8), 0); // up
  assert.equal(sliceAtOffset(100, 0, 8), 2); // right
  assert.equal(sliceAtOffset(0, 100, 8), 4); // down
  assert.equal(sliceAtOffset(-100, 0, 8), 6); // left
  assert.equal(sliceAtOffset(70, -70, 8), 1); // up-right
  assert.equal(sliceAtOffset(-1, -100, 8), 0); // just left of up still slice 0 (wraps correctly)
  assert.equal(sliceAtOffset(0, -100, 6), 0);
  assert.equal(sliceAtOffset(0, 100, 6), 3);
});

test('aiming: center is a dead zone, far away dismisses, in between picks by direction even past the ring', () => {
  assert.deepEqual(pointerTarget(5, 5, 8, 40, 250), { kind: 'center' });
  assert.deepEqual(pointerTarget(0, -300, 8, 40, 250), { kind: 'outside' });
  assert.deepEqual(pointerTarget(0, -200, 8, 40, 250), { kind: 'slice', index: 0 });
  assert.deepEqual(pointerTarget(160, 0, 8, 40, 250), { kind: 'slice', index: 2 });
});

test('letters: invalid, reserved, action-owned and duplicate letters are cleared; first claimant wins', () => {
  const plan = planLetterCleanup(
    ['e', 's', 'p', '/', 'r', 'k', 'm'],
    [{ id: 1, letter: 'g' }, { id: 2, letter: 'g' }, { id: 3, letter: 'p' }, { id: 4, letter: undefined }],
    [{ id: 10, letter: 'g' }, { id: 11, letter: 'h' }, { id: 12, letter: 'R' }, { id: 13, letter: '!' }],
  );
  assert.deepEqual(plan.clearSpaces, [2, 3]); // space 1 keeps G; 2 duplicates it; 3 collides with Pause
  assert.deepEqual(plan.clearMacros, [10, 12, 13]); // G is already space 1's, R is reserved, "!" is invalid
});

test('letters: a clean, non-conflicting set is left alone (idempotent across worker restarts)', () => {
  const rows = { spaces: [{ id: 1, letter: 'w' }], macros: [{ id: 2, letter: 'g' }] };
  const plan = planLetterCleanup(['e', 's', 'p', '/', 'r', 'k', 'm'], rows.spaces, rows.macros);
  assert.deepEqual(plan, { clearSpaces: [], clearMacros: [] });
});
