import { describe, expect, it } from 'vitest';
import {
  applyParams,
  deriveParams,
  describeParams,
  detectBySequence,
  isTemplateUrl,
  sessionize,
} from '@/lib/macro-detection';
import type { MacroParam } from '@/lib/types';
import { A, B, at, clickStep, macro, open, openStep } from './helpers';

const GAP = 3 * 60 * 1000;
const PR = (n: number | string) => `https://github.com/org/repo/pull/${n}`;

function sessionsFor(values: (number | string)[]) {
  return values.map((v, i) => [open(at(i + 1, 9, 0), PR(v)), open(at(i + 1, 9, 1), B)]);
}

describe('deriveParams', () => {
  it('promotes a segment that varied into a named parameter', () => {
    const steps = [openStep(PR(3)), openStep(B)];
    const { steps: rewritten, params } = deriveParams(steps, sessionsFor([1, 2, 3]));

    expect(rewritten[0]?.url).toBe(PR('{pull}'));
    expect(params).toEqual([{ name: 'pull', examples: ['1', '2', '3'], lastValue: '3' }]);
  });

  it('leaves a segment alone when only one value was ever seen', () => {
    // One value is part of the path, not a variable.
    const steps = [openStep(PR(7)), openStep(B)];
    const { steps: rewritten, params } = deriveParams(steps, sessionsFor([7, 7, 7]));

    expect(rewritten[0]?.url).toBe(PR(7));
    expect(params).toEqual([]);
  });

  it('gives the step a key that survives the next ticket', () => {
    // The whole point: v1 keyed on the concrete URL, so visiting PR 900 tomorrow produced a
    // different key and the macro could fork.
    const first = deriveParams([openStep(PR(3))], sessionsFor([1, 2, 3]));
    const later = deriveParams([openStep(PR(900))], sessionsFor([1, 2, 900]));

    expect(first.steps[0]?.key).toBe(later.steps[0]?.key);
  });

  it('rewrites a click on a parameterized page to match', () => {
    const steps = [openStep(PR(3)), clickStep(PR(3), '#merge')];
    const { steps: rewritten } = deriveParams(steps, sessionsFor([1, 2, 3]));

    expect(rewritten[1]?.url).toBe(PR('{pull}'));
    expect(rewritten[1]?.key).toBe(`click:${PR('{pull}')}|#merge`);
  });

  it('names a second parameter without colliding', () => {
    const url = (a: number, b: number) => `https://x.test/team/${a}/issue/${b}`;
    const sessions = [
      [open(at(1, 9), url(1, 10))],
      [open(at(2, 9), url(2, 20))],
      [open(at(3, 9), url(3, 30))],
    ];
    const { params } = deriveParams([openStep(url(3, 30))], sessions);

    expect(params.map((p) => p.name)).toEqual(['team', 'issue']);
  });

  it('falls back to a usable name when the preceding segment is not one', () => {
    const sessions = [
      [open(at(1, 9), 'https://x.test/1')],
      [open(at(2, 9), 'https://x.test/2')],
    ];
    const { params } = deriveParams([openStep('https://x.test/2')], sessions);
    expect(params[0]?.name).toBe('id');
  });

  it('does nothing when there is no wildcard at all', () => {
    const result = deriveParams([openStep(A), openStep(B)], [[open(at(1, 9), A), open(at(1, 9, 1), B)]]);
    expect(result.params).toEqual([]);
    expect(result.steps[0]?.url).toBe(A);
  });
});

describe('applyParams', () => {
  const parameterized = macro({
    steps: [openStep(PR('{pull}')), openStep(B)],
    params: [{ name: 'pull', examples: ['1', '2'], lastValue: '2' }],
  });

  it('substitutes a supplied value', () => {
    const resolved = applyParams(parameterized, { pull: '847' });
    expect(resolved.steps[0]?.url).toBe(PR(847));
  });

  it('falls back to the last seen value so a macro is always runnable', () => {
    expect(applyParams(parameterized, {}).steps[0]?.url).toBe(PR(2));
    expect(applyParams(parameterized).steps[0]?.url).toBe(PR(2));
  });

  it('treats blank input as absent rather than substituting nothing', () => {
    expect(applyParams(parameterized, { pull: '   ' }).steps[0]?.url).toBe(PR(2));
  });

  it('leaves step keys untouched, so outcomes still line up', () => {
    const resolved = applyParams(parameterized, { pull: '847' });
    expect(resolved.steps.map((s) => s.key)).toEqual(parameterized.steps.map((s) => s.key));
  });

  it('leaves non-parameterized URLs alone', () => {
    expect(applyParams(parameterized, { pull: '847' }).steps[1]?.url).toBe(B);
  });

  it('escapes a value so it cannot break out of the path', () => {
    const resolved = applyParams(parameterized, { pull: '../../admin' });
    expect(resolved.steps[0]?.url).toBe(PR('..%2F..%2Fadmin'));
  });

  it('is a no-op for a macro with no params', () => {
    const plain = macro({ steps: [openStep(A)] });
    expect(applyParams(plain, { pull: '1' })).toBe(plain);
  });
});

describe('isTemplateUrl', () => {
  it('recognizes a template', () => {
    expect(isTemplateUrl(PR('{pull}'))).toBe(true);
    expect(isTemplateUrl(PR(3))).toBe(false);
  });

  it('is not confused by repeated calls', () => {
    // A module-level regex with /g carries lastIndex between calls if not reset.
    expect(isTemplateUrl(PR('{pull}'))).toBe(true);
    expect(isTemplateUrl(PR('{pull}'))).toBe(true);
  });
});

describe('describeParams', () => {
  it('renders nothing for an unparameterized macro', () => {
    expect(describeParams([])).toBe('');
  });

  it('lists the parameter names', () => {
    const params: MacroParam[] = [
      { name: 'pull', examples: [], lastValue: '1' },
      { name: 'team', examples: [], lastValue: 'x' },
    ];
    expect(describeParams(params)).toBe('{pull} {team}');
  });
});

describe('end to end through the sequence detector', () => {
  it('turns a per-ticket routine into a parameterized macro', () => {
    const actions = [1, 2, 3].flatMap((day) => [
      open(at(day, 9, 0), PR(800 + day)),
      open(at(day, 9, 1), B),
    ]);

    const [candidate] = detectBySequence(sessionize(actions, GAP), 3, 2);

    expect(candidate?.steps.map((s) => s.url)).toEqual([PR('{pull}'), B]);
    expect(candidate?.params?.[0]?.lastValue).toBe('803');
  });
});
