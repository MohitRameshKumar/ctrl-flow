import { describe, expect, it } from 'vitest';
import {
  canonForNgram,
  detectBySequence,
  detectByTimeOfDay,
  eventToAction,
  isUsableSession,
  itemKey,
  openUrlSet,
  sessionize,
} from '@/lib/macro-detection';
import { A, B, C, D, activate, at, click, event, open } from './helpers';

const MINUTE = 60_000;
const GAP = 3 * MINUTE;

describe('eventToAction', () => {
  it('marks opens and navigations deliberate but activations not', () => {
    expect(eventToAction(event({ ts: 1, kind: 'tab_opened', url: A }))?.deliberate).toBe(true);
    expect(eventToAction(event({ ts: 1, kind: 'navigated', url: A }))?.deliberate).toBe(true);
    expect(eventToAction(event({ ts: 1, kind: 'tab_activated', url: A }))?.deliberate).toBe(false);
  });

  it('drops events that cannot be replayed', () => {
    expect(eventToAction(event({ ts: 1, kind: 'tab_closed' }))).toBeNull();
    expect(eventToAction(event({ ts: 1, kind: 'typing_burst', url: A, keyCount: 9 }))).toBeNull();
    expect(eventToAction(event({ ts: 1, kind: 'field_changed', url: A, fieldName: 'q' }))).toBeNull();
    // A click with no selector is not replayable.
    expect(eventToAction(event({ ts: 1, kind: 'click', url: A }))).toBeNull();
  });

  it('never carries typed text or field values onto an action', () => {
    const action = eventToAction(event({ ts: 1, kind: 'click', url: A, selector: '#go', label: 'Go' }));
    expect(Object.keys(action ?? {}).sort()).toEqual(
      ['contextId', 'deliberate', 'kind', 'label', 'selector', 'target', 'title', 'ts'].sort(),
    );
  });
});

describe('itemKey', () => {
  it('separates clicks on the same page by selector', () => {
    expect(itemKey(click(1, A, '#one'))).not.toBe(itemKey(click(1, A, '#two')));
    expect(itemKey(open(1, A))).toBe(`open:${A}`);
  });
});

describe('sessionize', () => {
  it('splits on a gap longer than the threshold', () => {
    const sessions = sessionize(
      [open(at(1, 9, 0), A), open(at(1, 9, 1), B), open(at(1, 14, 0), C), open(at(1, 14, 1), D)],
      GAP,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toHaveLength(2);
    expect(sessions[1]).toHaveLength(2);
  });

  it('keeps one session when every gap is short', () => {
    const sessions = sessionize([open(at(1, 9, 0), A), open(at(1, 9, 1), B), open(at(1, 9, 2), C)], GAP);
    expect(sessions).toHaveLength(1);
  });

  it('collapses consecutive duplicates from tab churn', () => {
    const sessions = sessionize(
      [open(at(1, 9, 0), A), activate(at(1, 9, 1), A), activate(at(1, 9, 2), A), open(at(1, 9, 3), B)],
      GAP,
    );
    expect(sessions[0]?.map((a) => a.target)).toEqual([A, B]);
  });

  it('sorts unsorted input before splitting', () => {
    const sessions = sessionize([open(at(1, 9, 2), B), open(at(1, 9, 0), A)], GAP);
    expect(sessions[0]?.map((a) => a.target)).toEqual([A, B]);
  });

  it('caps a session so n-gram enumeration stays bounded', () => {
    const actions = Array.from({ length: 80 }, (_, i) => open(at(1, 9, 0, i), `https://x.test/${i}`));
    expect(sessionize(actions, GAP)[0]?.length).toBe(40);
  });
});

describe('isUsableSession', () => {
  it('rejects a session that is only tab switching', () => {
    expect(isUsableSession([activate(1, A), activate(2, B)])).toBe(false);
  });

  it('rejects a session that never leaves one page', () => {
    expect(isUsableSession([open(1, A), click(2, A, '#go')])).toBe(false);
  });

  it('accepts a deliberate multi-page session', () => {
    expect(isUsableSession([open(1, A), open(2, B)])).toBe(true);
  });
});

describe('canonForNgram', () => {
  it('folds numeric and hash path segments so per-ticket URLs collide', () => {
    expect(canonForNgram('https://github.com/org/repo/pull/812')).toBe(
      canonForNgram('https://github.com/org/repo/pull/904'),
    );
    expect(canonForNgram('https://x.test/a/deadbeefcafe/b')).toBe('https://x.test/a/*/b');
  });

  it('leaves meaningful segments alone', () => {
    expect(canonForNgram('https://github.com/org/repo/pulls')).toBe('https://github.com/org/repo/pulls');
  });
});

/** Three mornings of the same three pages. */
function threeMornings(extraOnDayOne: string[] = []): ReturnType<typeof sessionize> {
  const actions = [1, 2, 3].flatMap((day) => [
    open(at(day, 9, 0), A),
    open(at(day, 9, 1), B),
    open(at(day, 9, 2), C),
    ...(day === 1 ? extraOnDayOne.map((url, i) => open(at(day, 9, 3 + i), url)) : []),
  ]);
  return sessionize(actions, GAP);
}

describe('detectByTimeOfDay', () => {
  it('finds a routine repeated on three days at the same hour', () => {
    const [candidate, ...rest] = detectByTimeOfDay(threeMornings(), 3);
    expect(rest).toHaveLength(0);
    expect(candidate?.occurrences).toBe(3);
    expect(candidate?.typicalHour).toBe(9);
    expect(candidate?.steps.map((s) => s.url)).toEqual([A, B, C]);
  });

  it('needs three days normally but two in demo mode', () => {
    const twoDays = sessionize(
      [1, 2].flatMap((day) => [open(at(day, 9, 0), A), open(at(day, 9, 1), B), open(at(day, 9, 2), C)]),
      GAP,
    );
    expect(detectByTimeOfDay(twoDays, 3)).toHaveLength(0);
    expect(detectByTimeOfDay(twoDays, 2)).toHaveLength(1);
  });

  it('still groups a session with one extra page but drops the page itself', () => {
    const [candidate] = detectByTimeOfDay(threeMornings([D]), 3);
    expect(openUrlSet(candidate!.steps)).toEqual(new Set([A, B, C]));
  });

  it('does not merge sessions hours apart', () => {
    const sessions = sessionize(
      [
        ...[1, 2].flatMap((day) => [open(at(day, 9, 0), A), open(at(day, 9, 1), B), open(at(day, 9, 2), C)]),
        open(at(3, 15, 0), A),
        open(at(3, 15, 1), B),
        open(at(3, 15, 2), C),
      ],
      GAP,
    );
    // Two days at 9am and one at 3pm: neither group reaches three days.
    expect(detectByTimeOfDay(sessions, 3)).toHaveLength(0);
  });

  it('attaches a click the user makes on most runs, switched off by default', () => {
    const actions = [1, 2, 3].flatMap((day) => [
      open(at(day, 9, 0), A),
      click(at(day, 9, 1), A, '#new-pr'),
      open(at(day, 9, 2), B),
    ]);
    const [candidate] = detectByTimeOfDay(sessionize(actions, GAP), 3);
    const clickStep = candidate?.steps.find((s) => s.kind === 'click');
    expect(clickStep?.selector).toBe('#new-pr');
    expect(clickStep?.enabled).toBe(false);
    // It sits right after the page it happens on.
    expect(candidate?.steps.map((s) => s.kind)).toEqual(['open_url', 'click', 'open_url']);
  });

  it('ignores a click made on only one of three runs', () => {
    const actions = [1, 2, 3].flatMap((day) => [
      open(at(day, 9, 0), A),
      ...(day === 1 ? [click(at(day, 9, 1), A, '#rare')] : []),
      open(at(day, 9, 2), B),
    ]);
    const [candidate] = detectByTimeOfDay(sessionize(actions, GAP), 3);
    expect(candidate?.steps.some((s) => s.kind === 'click')).toBe(false);
  });
});

describe('detectBySequence', () => {
  it('finds a repeated ordered run and suppresses its nested prefixes', () => {
    const actions = [1, 2, 3].flatMap((day) => [
      open(at(day, 8 + day, 0), A),
      open(at(day, 8 + day, 1), B),
      open(at(day, 8 + day, 2), C),
    ]);
    const candidates = detectBySequence(sessionize(actions, GAP), 3, 2);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.steps.map((s) => s.url)).toEqual([A, B, C]);
    expect(candidates[0]?.typicalHour).toBeNull();
  });

  it('counts support per session, not per occurrence', () => {
    // Each session walks A,B twice. That is two occurrences but one session's worth of evidence.
    const actions = [1, 2].flatMap((day) => [
      open(at(day, 9, 0), A),
      open(at(day, 9, 1), B),
      open(at(day, 9, 2), A),
      open(at(day, 9, 3), B),
    ]);
    const candidates = detectBySequence(sessionize(actions, GAP), 2, 1);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) expect(candidate.occurrences).toBe(2);
  });

  it('requires the sequence to span more than one day outside demo mode', () => {
    const sameDay = sessionize(
      [0, 1, 2].flatMap((n) => [open(at(1, 9 + n * 3, 0), A), open(at(1, 9 + n * 3, 1), B)]),
      GAP,
    );
    expect(detectBySequence(sameDay, 3, 2)).toHaveLength(0);
    expect(detectBySequence(sameDay, 3, 1)).toHaveLength(1);
  });

  it('folds per-ticket URLs into a parameter instead of pinning one arbitrary ticket', () => {
    // v1 emitted whichever concrete URL happened to be most recent, so the macro always
    // reopened that one ticket. The varying segment is now a parameter, which also gives the
    // step a key that survives the next ticket being visited.
    const actions = [1, 2, 3].flatMap((day) => [
      open(at(day, 9, 0), `https://github.com/org/repo/pull/${day}`),
      open(at(day, 9, 1), B),
    ]);
    const [candidate] = detectBySequence(sessionize(actions, GAP), 3, 2);

    expect(candidate?.steps.map((s) => s.url)).toEqual([
      'https://github.com/org/repo/pull/{pull}',
      B,
    ]);
    expect(candidate?.params).toEqual([
      { name: 'pull', examples: ['1', '2', '3'], lastValue: '3' },
    ]);
  });

  it('rejects a sequence that never leaves one page', () => {
    const actions = [1, 2, 3].flatMap((day) => [open(at(day, 9, 0), A), activate(at(day, 9, 1), A)]);
    expect(detectBySequence(sessionize(actions, GAP), 3, 2)).toHaveLength(0);
  });

  it('finds nothing below the support threshold', () => {
    const actions = [1, 2].flatMap((day) => [open(at(day, 9, 0), A), open(at(day, 9, 1), B)]);
    expect(detectBySequence(sessionize(actions, GAP), 3, 2)).toHaveLength(0);
  });
});
