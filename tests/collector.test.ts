import { describe, expect, it } from 'vitest';
import { computeDwellBySpace } from '@/lib/switch-detection';
import { DEFAULT_BLOCKLIST, isBlocklisted, isSensitiveField } from '@/lib/privacy';
import { applyPacing, eventToAction, itemKey, mintStepKey } from '@/lib/macro-detection';
import { A, B, click, event, open } from './helpers';

const MINUTE = 60_000;

describe('computeDwellBySpace', () => {
  const urlToSpace = new Map([
    [A, 1],
    [B, 2],
  ]);

  it('credits the gap between activations to the earlier one', () => {
    const now = 10 * MINUTE;
    const dwell = computeDwellBySpace(
      [
        { url: A, ts: 0 },
        { url: B, ts: 4 * MINUTE },
      ],
      urlToSpace,
      now,
      60 * MINUTE,
    );

    expect(dwell.get(1)).toBe(4 * MINUTE);
    expect(dwell.get(2)).toBe(6 * MINUTE);
  });

  it('stops counting when Chrome loses focus', () => {
    // The user alt-tabbed to another app at minute 2 and never came back. Before focus breaks
    // were read, the full ten minutes was credited to space 1.
    const now = 10 * MINUTE;
    const dwell = computeDwellBySpace([{ url: A, ts: 0 }], urlToSpace, now, 60 * MINUTE, [
      { ts: 2 * MINUTE },
    ]);

    expect(dwell.get(1)).toBe(2 * MINUTE);
  });

  it('ignores a focus break that happened before the segment started', () => {
    const now = 10 * MINUTE;
    const dwell = computeDwellBySpace([{ url: A, ts: 5 * MINUTE }], urlToSpace, now, 60 * MINUTE, [
      { ts: 1 * MINUTE },
    ]);

    expect(dwell.get(1)).toBe(5 * MINUTE);
  });

  it('clips a segment that starts before the window', () => {
    const now = 10 * MINUTE;
    const dwell = computeDwellBySpace([{ url: A, ts: 0 }], urlToSpace, now, 4 * MINUTE);
    expect(dwell.get(1)).toBe(4 * MINUTE);
  });

  it('ignores activations on untracked URLs', () => {
    const dwell = computeDwellBySpace(
      [{ url: 'https://example.com/x', ts: 0 }],
      urlToSpace,
      MINUTE,
      60 * MINUTE,
    );
    expect(dwell.size).toBe(0);
  });
});

describe('blocklist', () => {
  it('matches a domain exactly and by suffix', () => {
    expect(isBlocklisted('mail.google.com', DEFAULT_BLOCKLIST)).toBe(true);
    expect(isBlocklisted('subdomain.chase.com', DEFAULT_BLOCKLIST)).toBe(true);
    expect(isBlocklisted('github.com', DEFAULT_BLOCKLIST)).toBe(false);
  });

  it('matches the substring rule', () => {
    expect(isBlocklisted('mychart.hospital.org', DEFAULT_BLOCKLIST)).toBe(true);
  });

  it('does not match a lookalike domain', () => {
    // Suffix matching must not let "notchase.com" through as "chase.com".
    expect(isBlocklisted('notchase.com', DEFAULT_BLOCKLIST)).toBe(false);
  });
});

describe('isSensitiveField', () => {
  it('refuses credential and payment fields', () => {
    expect(isSensitiveField('password', null, 'pw')).toBe(true);
    expect(isSensitiveField('text', 'cc-number', 'num')).toBe(true);
    expect(isSensitiveField('text', null, 'cardNumber')).toBe(true);
    expect(isSensitiveField('text', null, 'ssn')).toBe(true);
    expect(isSensitiveField('hidden', null, 'token')).toBe(true);
  });

  it('allows an ordinary field', () => {
    expect(isSensitiveField('text', null, 'search')).toBe(false);
  });
});

describe('eventToAction', () => {
  it('drops an event with no URL', () => {
    expect(eventToAction(event({ ts: 1, kind: 'navigated' }))).toBeNull();
  });

  it('drops a click with no selector', () => {
    expect(eventToAction(event({ ts: 1, kind: 'click', url: A }))).toBeNull();
  });

  it('marks a plain tab switch as non-deliberate', () => {
    const action = eventToAction(event({ ts: 1, kind: 'tab_activated', url: A }));
    expect(action?.deliberate).toBe(false);
  });

  it('marks a navigation as deliberate', () => {
    expect(eventToAction(event({ ts: 1, kind: 'navigated', url: A }))?.deliberate).toBe(true);
  });

  it('ignores event kinds that are not replayable', () => {
    expect(eventToAction(event({ ts: 1, kind: 'typing_burst', url: A }))).toBeNull();
    expect(eventToAction(event({ ts: 1, kind: 'field_changed', url: A }))).toBeNull();
  });
});

describe('applyPacing', () => {
  it('fills delayBeforeMs from the median observed gap', () => {
    const sessions = [
      [open(0, A), open(1000, B)],
      [open(10_000, A), open(11_500, B)],
      [open(20_000, A), open(14_000_000, B)],
    ];
    const steps = [
      { key: `open:${A}`, kind: 'open_url' as const, url: A, enabled: true, support: 3 },
      { key: `open:${B}`, kind: 'open_url' as const, url: B, enabled: true, support: 3 },
    ];

    const paced = applyPacing(steps, sessions);

    // The median ignores the one session where the user wandered off for four hours.
    expect(paced.find((s) => s.url === B)?.delayBeforeMs).toBe(1500);
  });

  it('leaves a step alone when nothing was observed for it', () => {
    const steps = [{ key: `open:${A}`, kind: 'open_url' as const, url: A, enabled: true, support: 1 }];
    expect(applyPacing(steps, [])[0]?.delayBeforeMs).toBeUndefined();
  });

  it('paces a click by its own gap, not the step before it', () => {
    const sessions = [[open(0, A), click(2500, A, '#go')]];
    const steps = [
      { key: `open:${A}`, kind: 'open_url' as const, url: A, enabled: true, support: 1 },
      {
        key: itemKey(click(0, A, '#go')),
        kind: 'click' as const,
        url: A,
        selector: '#go',
        enabled: true,
        support: 1,
      },
    ];

    const paced = applyPacing(steps, sessions);
    expect(paced[1]?.delayBeforeMs).toBe(2500);
  });
});

describe('mintStepKey', () => {
  it('never collides, so two identical hand-made steps stay independent', () => {
    // removedStepKeys and pinnedStepKeys are keyed on this, so a collision would make editing
    // one step silently affect the other.
    const keys = new Set(Array.from({ length: 200 }, () => mintStepKey('wait')));
    expect(keys.size).toBe(200);
  });

  it('is recognizable as hand-authored', () => {
    expect(mintStepKey('type').startsWith('type:~')).toBe(true);
  });
});
