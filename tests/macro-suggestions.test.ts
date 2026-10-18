import { describe, expect, it } from 'vitest';
import { MACRO_DISMISS_STOP } from '@/lib/constants';
import { detectBySequence, isUsableSession, openUrlSet, sessionize } from '@/lib/macro-detection';
import { refineSegment } from '@/lib/macro-repeat';
import { MAX_SUGGESTIONS, dedupeSuggestions, dominatedSuggestions, savedMacros, visibleSuggestions } from '@/lib/macro-suggestions';
import { requiredRuns, snoozeMs } from '@/lib/macro-thresholds';
import type { Macro, ObservedAction } from '@/lib/types';
import { A, B, activate, at, macro, open, openStep } from './helpers';

const C = 'https://c.example.com/';
const D = 'https://d.example.com/';

describe('duration-based repetition thresholds', () => {
  it('under 30 s -> 3, 30 s to 5 min -> 2, over 5 min -> 1', () => {
    expect(requiredRuns(5_000)).toBe(3);
    expect(requiredRuns(29_999)).toBe(3);
    expect(requiredRuns(30_000)).toBe(2);
    expect(requiredRuns(5 * 60_000)).toBe(2);
    expect(requiredRuns(5 * 60_000 + 1)).toBe(1);
  });

  /** One session on `day`: A then B, `gapSec` apart. */
  const session = (day: number, gapSec: number): ObservedAction[] => [open(at(day, 9, 0, 0), A), open(at(day, 9, 0, gapSec), B)];
  const detect = (sessions: ObservedAction[][], minRuns = 3, minDays = 2) =>
    detectBySequence(sessions, minRuns, minDays, { durationThresholds: true });

  it('a 10 s routine needs 3 repetitions', () => {
    expect(detect([session(1, 10), session(2, 10)])).toHaveLength(0);
    expect(detect([session(1, 10), session(2, 10), session(3, 10)])).toHaveLength(1);
  });

  it('a 2 min routine needs 2', () => {
    expect(detect([session(1, 120)])).toHaveLength(0);
    expect(detect([session(1, 120), session(2, 120)])).toHaveLength(1);
  });

  it('a 10 min routine needs only 1, even though it cannot have recurred on 2 days', () => {
    expect(detect([session(1, 600)])).toHaveLength(1);
  });

  it('without the option the flat thresholds still apply (teammate behavior unchanged)', () => {
    expect(detectBySequence([session(1, 600)], 3, 2)).toHaveLength(0);
  });

  it('demo mode only lowers the bar: min(required, minRuns)', () => {
    expect(detect([session(1, 10), session(2, 10)], 2, 1)).toHaveLength(1);
  });
});

describe('pure tab switching is not a macro', () => {
  const activations = (day: number): ObservedAction[] => [
    activate(at(day, 9, 0, 0), A),
    activate(at(day, 9, 0, 10), B),
    activate(at(day, 9, 0, 20), A),
    activate(at(day, 9, 0, 30), B),
  ];

  it('a session of only activations of already-open tabs is dropped before detection', () => {
    const sessions = sessionize(activations(1), 180_000).map(refineSegment).filter(isUsableSession);
    expect(sessions).toHaveLength(0);
  });

  it('switching repeated on several days yields no suggestion', () => {
    const all = [1, 2, 3, 4].flatMap(activations);
    const sessions = sessionize(all, 90_000).map(refineSegment).filter(isUsableSession);
    expect(detectBySequence(sessions, 3, 2, { durationThresholds: true })).toHaveLength(0);
  });

  it('opening pages in a consistent order still suggests', () => {
    const task = (day: number) => [open(at(day, 9, 0, 0), A, { contextId: 1 }), open(at(day, 9, 0, 20), B, { contextId: 2 }), open(at(day, 9, 0, 40), C, { contextId: 3 })];
    const sessions = sessionize([1, 2, 3].flatMap(task), 90_000).map(refineSegment).filter(isUsableSession);
    const found = detectBySequence(sessions, 3, 2, { durationThresholds: true });
    expect(found.length).toBeGreaterThan(0);
    expect(openUrlSet(found[0]!.steps).size).toBe(3);
  });

  it('a recurring session needs at least 2 distinct opened pages', () => {
    const one = (day: number) => [open(at(day, 9, 0, 0), A, { contextId: 1 }), open(at(day, 9, 0, 30), A, { contextId: 1 })];
    expect(detectBySequence([1, 2, 3].map(one), 3, 2, { durationThresholds: true })).toHaveLength(0);
  });
});

function suggestion(id: number, urls: string[], over: Partial<Macro> = {}): Macro {
  return { ...macro({ steps: urls.map((u) => openStep(u)), status: 'suggested', occurrences: 3, updatedAt: id }), id, name: `S${id}`, ...over };
}

describe('suggestion merging, limits and back-off', () => {
  it('overlapping suggestions collapse to the longest', () => {
    const short = suggestion(1, [A, B]);
    const long = suggestion(2, [A, B, C]);
    const other = suggestion(3, [D, 'https://e.example.com/']);
    expect(dedupeSuggestions([short, long, other]).map((m) => m.id).sort()).toEqual([2, 3]);
    expect(dominatedSuggestions([short, long, other]).map((m) => m.id)).toEqual([1]);
  });

  it('shows at most 2 at once, best first', () => {
    const many = [suggestion(1, [A, B], { occurrences: 3 }), suggestion(2, [C, D], { occurrences: 9 }), suggestion(3, ['https://x.com/', 'https://y.com/'], { occurrences: 5 })];
    const shown = visibleSuggestions(many, Date.now());
    expect(shown).toHaveLength(MAX_SUGGESTIONS);
    expect(shown.map((m) => m.id)).toEqual([2, 3]);
  });

  it('"Not now" snoozes with growing back-off, and 5 dismissals hide it for good', () => {
    const now = 1_000_000;
    const snoozed = suggestion(1, [A, B], { snoozedUntil: now + 1000 });
    expect(visibleSuggestions([snoozed], now)).toHaveLength(0);
    expect(visibleSuggestions([snoozed], now + 2000)).toHaveLength(1);
    expect(snoozeMs(1)).toBeLessThan(snoozeMs(2));
    expect(snoozeMs(2)).toBeLessThan(snoozeMs(3));
    const dead = suggestion(2, [C, D], { stats: { runs: 0, successes: 0, failures: 0, undos: 0, offersShown: 5, offersDismissed: MACRO_DISMISS_STOP, cleanStreak: 0 } });
    expect(visibleSuggestions([dead], now)).toHaveLength(0);
  });

  it('"Never" is permanent: a never macro is not a suggestion and is not shown', () => {
    const never = suggestion(1, [A, B], { status: 'never' });
    expect(visibleSuggestions([never], Date.now())).toHaveLength(0);
    expect(dominatedSuggestions([never, suggestion(2, [A, B, C])])).toHaveLength(0);
  });

  it('saved macros are listed separately and are never merged away', () => {
    const saved = suggestion(1, [A, B], { status: 'accepted' });
    const sug = suggestion(2, [A, B, C]);
    expect(savedMacros([sug, saved]).map((m) => m.id)).toEqual([1]);
    expect(dominatedSuggestions([saved, sug])).toHaveLength(0);
  });
});
