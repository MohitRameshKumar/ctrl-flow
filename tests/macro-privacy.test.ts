import { expect, test } from 'vitest';
import { looksSensitiveText } from '../lib/privacy';
import { eventToAction } from '../lib/macro-detection';
import type { CadenceEvent } from '../lib/types';

test('typed-text guard: card numbers (Luhn), SSNs, tokens and password assignments are refused', () => {
  for (const s of ['4242 4242 4242 4242', '4111-1111-1111-1111', '078-05-1120', 'sk-live_abcdefghijklmnop1234', 'ghp_abcdefghijklmnop', 'password: hunter2', 'Bearer abcdefghijklmnopqrstuv', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6']) {
    expect(looksSensitiveText(s)).toBe(true);
  }
});

test('typed-text guard: ordinary text passes (and a non-Luhn digit run is not a card)', () => {
  for (const s of ['standup notes', 'weekly report', 'hello world', '1234 5678 9012 3456', 'order 12345']) {
    expect(looksSensitiveText(s)).toBe(false);
  }
});

test('macro detection ignores synthetic and Cadence-initiated (programmatic) events', () => {
  const base: CadenceEvent = { ts: 1, kind: 'tab_activated', url: 'https://a.com/x', domain: 'a.com' };
  expect(eventToAction(base)).toBeTruthy();
  expect(eventToAction({ ...base, synthetic: true })).toBeNull();
  expect(eventToAction({ ...base, programmatic: true })).toBeNull();
});
