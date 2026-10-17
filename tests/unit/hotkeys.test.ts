import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  RESERVED_LETTERS,
  buildMenu,
  findMenuItem,
  listRegistrations,
  registerLeader,
  suggestLetter,
  unregisterLeader,
  validateLetter,
} from '../../lib/hotkeys.ts';

const noop = () => undefined;

beforeEach(() => {
  for (const r of listRegistrations()) unregisterLeader(r.id);
});

test('letters must be a single a–z / 0–9 character ("/" only where allowed), case-insensitive', () => {
  assert.deepEqual(validateLetter('E', 'x', []), { ok: true, letter: 'e' });
  assert.equal(validateLetter('ab', 'x', []).ok, false);
  assert.equal(validateLetter('', 'x', []).ok, false);
  assert.equal(validateLetter('!', 'x', []).ok, false);
  assert.equal(validateLetter('/', 'x', []).ok, true);
  assert.equal(validateLetter('/', 'x', [], { allowSlash: false }).ok, false);
});

test('conflicts are rejected, but re-assigning your own letter is fine', () => {
  const taken = [{ id: 'pause', letter: 'p' }];
  const clash = validateLetter('p', 'space:1', taken);
  assert.equal(clash.ok, false);
  assert.match((clash as { reason: string }).reason, /already used/);
  assert.equal(validateLetter('P', 'pause', taken).ok, true);
});

test('R, K and M are reserved for Repeat-to-Macro', () => {
  for (const l of ['r', 'k', 'm', 'R']) {
    const res = validateLetter(l, 'space:1', []);
    assert.equal(res.ok, false, l);
    assert.match((res as { reason: string }).reason, /reserved/i);
  }
  assert.equal(validateLetter('r', 'macro-record', [], { allowReserved: true }).ok, true);
  assert.deepEqual(Object.keys(RESERVED_LETTERS).sort(), ['k', 'm', 'r']);
});

test('registry: any feature can register; duplicates and reserved letters throw unless allowed', () => {
  registerLeader({ id: 'pause', letter: 'p', label: 'Pause', run: noop });
  assert.throws(() => registerLeader({ id: 'other', letter: 'p', label: 'x', run: noop }), /already used/);
  assert.throws(() => registerLeader({ id: 'macro', letter: 'r', label: 'x', run: noop }), /reserved/i);
  registerLeader({ id: 'macro', letter: 'r', label: 'Record macro', run: noop, allowReserved: true });
  assert.deepEqual(listRegistrations().map((r) => r.letter).sort(), ['p', 'r']);
  unregisterLeader('pause');
  registerLeader({ id: 'other', letter: 'P', label: 'now free', run: noop });
  assert.equal(listRegistrations().find((r) => r.id === 'other')?.letter, 'p');
});

test('suggestion: first free letter of the name, skipping taken and reserved ones', () => {
  assert.equal(suggestLetter('EE 242 homework', []), 'e');
  assert.equal(suggestLetter('EE 242 homework', ['e']), 'h'); // digits in the name are not preferred over letters
});

test('suggestion falls back through the name, then any free letter', () => {
  assert.equal(suggestLetter('Club website', ['c']), 'l');
  assert.equal(suggestLetter('Mark', []), 'a'); // M and R are reserved, K too
  assert.equal(suggestLetter('rkm', []), 'a'); // nothing usable in the name
  const all = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
  assert.equal(suggestLetter('anything', all), null);
});

test('menu: actions, then space letters, then macro letters; user overrides apply; no placeholders', () => {
  const regs = [
    { id: 'open_panel', letter: 'e', label: 'Open side panel', run: noop },
    { id: 'pause', letter: 'p', label: 'Pause', run: noop },
  ];
  const menu = buildMenu(
    regs,
    { pause: 'q' },
    [{ spaceId: 7, name: 'Club website', letter: 'c' }],
    [{ macroId: 3, name: 'Morning', letter: 'o' }],
  );
  assert.deepEqual(menu.map((i) => [i.letter, i.kind]), [
    ['e', 'action'],
    ['q', 'action'],
    ['c', 'space'],
    ['o', 'macro'],
  ]);
  assert.equal(findMenuItem(menu, 'Q')?.id, 'pause');
  assert.equal(findMenuItem(menu, 'o')?.id, '3');
  assert.equal(findMenuItem(menu, 'p'), undefined);
});

test('R, K and M appear as real actions once the macro feature registers them (nothing is "coming soon")', () => {
  const regs = ['r', 'k', 'm'].map((letter) => ({ id: `macro-${letter}`, letter, label: `Macro ${letter}`, run: noop, allowReserved: true }));
  const menu = buildMenu(regs, {}, []);
  assert.deepEqual(menu.map((i) => [i.letter, i.kind]), [['k', 'action'], ['m', 'action'], ['r', 'action']]);
  assert.equal(JSON.stringify(menu).includes('coming soon'), false);
});

test('a saved macro can take a free letter but not a reserved or taken one', () => {
  const taken = [{ id: 'pause', letter: 'p' }];
  assert.equal(validateLetter('o', 'macro:3', taken, { allowSlash: false }).ok, true);
  assert.equal(validateLetter('r', 'macro:3', taken, { allowSlash: false }).ok, false);
  assert.equal(validateLetter('p', 'macro:3', taken, { allowSlash: false }).ok, false);
});
