import { describe, expect, it } from 'vitest';
import {
  applyCandidate,
  candidateFromSession,
  hourBucket,
  isUsableCandidate,
  jaccard,
  matchExistingMacro,
  mintMacroKey,
  nameMacro,
  unionCandidates,
} from '@/lib/macro-detection';
import { A, B, C, D, candidate, click, clickStep, macro, open, openStep } from './helpers';

describe('jaccard', () => {
  it('scores overlap', () => {
    expect(jaccard(new Set([A, B, C]), new Set([A, B, D]))).toBeCloseTo(0.5);
    expect(jaccard(new Set([A, B, C]), new Set([A, B, C, D]))).toBeCloseTo(0.75);
    expect(jaccard(new Set([A]), new Set([B]))).toBe(0);
  });

  it('treats two empty sets as identical and one empty set as disjoint', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set([A]), new Set())).toBe(0);
  });
});

describe('isUsableCandidate', () => {
  it('rejects a single-page candidate', () => {
    expect(isUsableCandidate(candidate([openStep(A)]))).toBe(false);
  });

  it('rejects two pages on one domain but accepts three', () => {
    const two = ['https://x.test/a', 'https://x.test/b'];
    const three = [...two, 'https://x.test/c'];
    expect(isUsableCandidate(candidate(two.map((u) => openStep(u))))).toBe(false);
    expect(isUsableCandidate(candidate(three.map((u) => openStep(u))))).toBe(true);
  });

  it('accepts two pages across two domains', () => {
    expect(isUsableCandidate(candidate([openStep(A), openStep(B)]))).toBe(true);
  });
});

describe('unionCandidates', () => {
  it('merges the two detectors views of one routine, taking order from the sequence', () => {
    const timeOfDay = candidate([openStep(C), openStep(A), openStep(B)], {
      detector: 'time_of_day',
      occurrences: 5,
      typicalHour: 9,
    });
    const sequence = candidate([openStep(A), openStep(B), openStep(C)], {
      detector: 'sequence',
      occurrences: 3,
    });

    const [merged, ...rest] = unionCandidates([timeOfDay, sequence]);
    expect(rest).toHaveLength(0);
    expect(merged?.detector).toBe('both');
    expect(merged?.occurrences).toBe(5);
    expect(merged?.typicalHour).toBe(9);
    expect(merged?.steps.map((s) => s.url)).toEqual([A, B, C]);
  });

  it('keeps candidates that do not overlap enough apart', () => {
    const one = candidate([openStep(A), openStep(B), openStep(C)]);
    const two = candidate([openStep(A), openStep(B), openStep(D)]);
    // jaccard is 0.5, below the 0.6 threshold.
    expect(unionCandidates([one, two])).toHaveLength(2);
  });

  it('drops candidates too thin to be useful', () => {
    expect(unionCandidates([candidate([openStep(A)])])).toHaveLength(0);
  });

  it('ranks by how often and how broadly a routine recurs', () => {
    const small = candidate([openStep(A), openStep(B)], { occurrences: 3 });
    const big = candidate([openStep(C), openStep(D), openStep('https://x.test/e')], {
      occurrences: 10,
    });
    expect(unionCandidates([small, big])[0]?.steps[0]?.url).toBe(C);
  });
});

describe('matchExistingMacro and mintMacroKey', () => {
  it('is insensitive to step order', () => {
    expect(mintMacroKey(candidate([openStep(A), openStep(B)]))).toBe(
      mintMacroKey(candidate([openStep(B), openStep(A)])),
    );
  });

  it('matches a stored macro that gained a step, rather than forking a duplicate', () => {
    const stored = macro({ steps: [openStep(A), openStep(B), openStep(C)] });
    const grown = candidate([openStep(A), openStep(B), openStep(C), openStep(D)]);
    expect(matchExistingMacro([stored], grown)).toBe(stored);
  });

  it('does not match an unrelated macro', () => {
    const stored = macro({ steps: [openStep(A), openStep(B)] });
    expect(matchExistingMacro([stored], candidate([openStep(C), openStep(D)]))).toBeNull();
  });

  it('prefers the closest match when several are similar', () => {
    const close = macro({ id: 1, macroKey: 'm:close', steps: [openStep(A), openStep(B), openStep(C)] });
    const looser = macro({ id: 2, macroKey: 'm:loose', steps: [openStep(A), openStep(B), openStep(D)] });
    const target = candidate([openStep(A), openStep(B), openStep(C)]);
    expect(matchExistingMacro([looser, close], target)).toBe(close);
  });
});

describe('applyCandidate', () => {
  const fresh = candidate([openStep(A), clickStep(A, '#go'), openStep(B)], { occurrences: 4 });

  it('creates a suggested macro with clicks off and opens on', () => {
    const created = applyCandidate(null, fresh, 'Morning GitHub', 'm:key', 1000);
    expect(created.status).toBe('suggested');
    expect(created.nameIsUserSet).toBe(false);
    expect(created.steps.filter((s) => s.kind === 'open_url').every((s) => s.enabled)).toBe(true);
    expect(created.steps.filter((s) => s.kind === 'click').every((s) => !s.enabled)).toBe(true);
  });

  it('never overwrites a status the user chose', () => {
    for (const status of ['accepted', 'auto', 'never'] as const) {
      const existing = macro({ status, steps: [openStep(A)] });
      expect(applyCandidate(existing, fresh, 'New name', 'm:key', 1).status).toBe(status);
    }
  });

  it('never resurrects a step the user removed', () => {
    const existing = macro({ steps: [openStep(A)], removedStepKeys: [`open:${B}`] });
    const result = applyCandidate(existing, fresh, 'n', 'm:key', 1);
    expect(result.steps.some((s) => s.url === B)).toBe(false);
  });

  it('keeps a click the user switched on', () => {
    const key = `click:${A}|#go`;
    const existing = macro({
      steps: [openStep(A), clickStep(A, '#go', { enabled: true })],
      pinnedStepKeys: [key],
    });
    const result = applyCandidate(existing, fresh, 'n', 'm:key', 1);
    expect(result.steps.find((s) => s.key === key)?.enabled).toBe(true);
  });

  it('keeps a pinned step that this scan did not happen to see', () => {
    const key = `click:${A}|#go`;
    const existing = macro({
      steps: [openStep(A), clickStep(A, '#go', { enabled: true })],
      pinnedStepKeys: [key],
    });
    const withoutTheClick = candidate([openStep(A), openStep(B)]);
    const result = applyCandidate(existing, withoutTheClick, 'n', 'm:key', 1);
    expect(result.steps.find((s) => s.key === key)?.enabled).toBe(true);
  });

  it('switches a step off again when the user unpinned it to off', () => {
    const key = `click:${A}|#go`;
    const existing = macro({
      steps: [openStep(A), clickStep(A, '#go', { enabled: false })],
      pinnedStepKeys: [key],
    });
    expect(applyCandidate(existing, fresh, 'n', 'm:key', 1).steps.find((s) => s.key === key)?.enabled).toBe(
      false,
    );
  });

  it('keeps a name the user set but refreshes a generated one', () => {
    const userNamed = macro({ name: 'My thing', nameIsUserSet: true, steps: [openStep(A)] });
    expect(applyCandidate(userNamed, fresh, 'Generated', 'm:key', 1).name).toBe('My thing');

    const generated = macro({ name: 'Old', nameIsUserSet: false, steps: [openStep(A)] });
    expect(applyCandidate(generated, fresh, 'Generated', 'm:key', 1).name).toBe('Generated');
  });

  it('preserves an order the user arranged and appends unseen steps', () => {
    const existing = macro({ steps: [openStep(B), openStep(A)] });
    const result = applyCandidate(existing, fresh, 'n', 'm:key', 1);
    expect(result.steps.map((s) => s.key)).toEqual([`open:${B}`, `open:${A}`, `click:${A}|#go`]);
  });

  it('keeps the stored identity and takes the higher run count', () => {
    const existing = macro({ macroKey: 'm:original', occurrences: 9, steps: [openStep(A)] });
    const result = applyCandidate(existing, fresh, 'n', 'm:different', 1);
    expect(result.macroKey).toBe('m:original');
    expect(result.occurrences).toBe(9);
  });
});

describe('candidateFromSession', () => {
  it('turns a recording into a candidate, deduped and with clicks attached', () => {
    const result = candidateFromSession([
      open(1, A),
      click(2, A, '#go'),
      open(3, B),
      open(4, A),
    ]);
    expect(result?.steps.map((s) => s.key)).toEqual([`open:${A}`, `click:${A}|#go`, `open:${B}`]);
  });

  it('refuses a recording that never left one page', () => {
    expect(candidateFromSession([open(1, A), click(2, A, '#go')])).toBeNull();
  });
});

describe('nameMacro', () => {
  it('names one domain, two domains, and many', () => {
    expect(nameMacro(candidate([openStep(A), openStep('https://github.com/org/repo/issues')]), 0)).toBe(
      'GitHub routine',
    );
    expect(nameMacro(candidate([openStep(A), openStep(B)]), 0)).toBe('GitHub + Linear');
    const many = candidate([openStep(A), openStep(B), openStep(C), openStep(D)]);
    expect(nameMacro(many, 0)).toBe('GitHub + Linear +2 more');
  });

  it('prefixes the time of day when there is one', () => {
    expect(nameMacro(candidate([openStep(A), openStep(B)], { typicalHour: 9 }), 0)).toBe(
      'Morning GitHub + Linear',
    );
    expect(nameMacro(candidate([openStep(A), openStep(B)], { typicalHour: 20 }), 0)).toBe(
      'Evening GitHub + Linear',
    );
  });

  it('buckets hours', () => {
    expect([8, 12, 15, 22].map(hourBucket)).toEqual(['Morning', 'Midday', 'Afternoon', 'Evening']);
  });

  it('uses friendly names for known hosts', () => {
    expect(nameMacro(candidate([openStep(C), openStep('https://mail.google.com/u/0')]), 0)).toBe(
      'Google Docs + Gmail',
    );
  });

  it('falls back when no domain resolves', () => {
    expect(nameMacro(candidate([openStep('not a url'), openStep('also not')]), 2)).toBe('Routine 3');
  });

  it('disambiguates against names already in use', () => {
    const taken = new Set(['GitHub + Linear', 'GitHub + Linear 2']);
    expect(nameMacro(candidate([openStep(A), openStep(B)]), 0, taken)).toBe('GitHub + Linear 3');
  });
});
