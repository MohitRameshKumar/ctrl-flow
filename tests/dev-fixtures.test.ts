import { describe, expect, it } from 'vitest';
import {
  attachClicks,
  deriveParams,
  detectBySequence,
  eventToAction,
  matchInProgress,
  sessionize,
} from '@/lib/macro-detection';
import {
  MACRO_INPROGRESS_MIN_MATCH,
  MACRO_MIN_RUNS,
  MACRO_SEQ_MIN_DAYS,
  SESSION_GAP_MS,
} from '@/lib/constants';
import {
  DEFAULT_PAGES,
  FIXTURE_PAGE_A,
  FIXTURE_PAGE_B,
  FIXTURE_PAGE_C,
  PARAM_FIXTURE_VALUES,
  fixtureDomains,
  orderingMacro,
  pagesFor,
  paramRoutineEvents,
} from '@/lib/dev-fixtures';
import type { ObservedAction } from '@/lib/types';
import { open } from './helpers';

/**
 * The harness fixtures exist to make states reachable during a manual test. If a threshold moves
 * and a fixture stops producing the state it advertises, a manual test would quietly pass for
 * the wrong reason — so the fixtures are asserted here against the real detector.
 */
const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();

function sessionsFromFixture(): ObservedAction[][] {
  const actions = paramRoutineEvents(NOW)
    .map(eventToAction)
    .filter((a): a is ObservedAction => a !== null);
  return sessionize(actions, SESSION_GAP_MS);
}

describe('paramRoutineEvents', () => {
  it('splits into one session per day', () => {
    const sessions = sessionsFromFixture();
    expect(sessions).toHaveLength(PARAM_FIXTURE_VALUES.length);
    for (const session of sessions) expect(session).toHaveLength(3);
  });

  it('clears the production thresholds, so demo mode is not required', () => {
    const sessions = sessionsFromFixture();
    expect(sessions.length).toBeGreaterThanOrEqual(MACRO_MIN_RUNS);

    const days = new Set(sessions.map((s) => new Date(s[0]!.ts).toDateString()));
    expect(days.size).toBeGreaterThanOrEqual(MACRO_SEQ_MIN_DAYS);
  });

  it('is detected as a repeated sequence', () => {
    const candidates = detectBySequence(sessionsFromFixture(), MACRO_MIN_RUNS, MACRO_SEQ_MIN_DAYS);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.occurrences).toBeGreaterThanOrEqual(MACRO_MIN_RUNS);
  });

  it('yields a {pull} parameter defaulting to the most recent ticket', () => {
    const sessions = sessionsFromFixture();
    const candidate = detectBySequence(sessions, MACRO_MIN_RUNS, MACRO_SEQ_MIN_DAYS)[0]!;
    const { steps, params } = deriveParams(candidate.steps, sessions);

    expect(params.map((p) => p.name)).toContain('pull');
    const pull = params.find((p) => p.name === 'pull')!;
    // Defaulting to the newest value is what makes "just press Run" do the useful thing.
    expect(pull.lastValue).toBe(PARAM_FIXTURE_VALUES.at(-1));
    expect(pull.examples).toEqual(expect.arrayContaining(PARAM_FIXTURE_VALUES));

    const templated = steps.filter((s) => s.url.includes('{pull}'));
    expect(templated.length).toBeGreaterThan(0);
  });

  it('asks for the ticket once, not once per page that mentions it', () => {
    // `/pull/812` and `/pull/812/files` vary at the same position with the same values. Naming
    // the second one `pull2` would make the run form demand the same number twice, which is the
    // difference between the feature feeling smart and feeling broken.
    const sessions = sessionsFromFixture();
    const candidate = detectBySequence(sessions, MACRO_MIN_RUNS, MACRO_SEQ_MIN_DAYS)[0]!;
    const { steps, params } = deriveParams(candidate.steps, sessions);

    expect(params).toHaveLength(1);
    const withPull = steps.filter((s) => s.url.includes('{pull}'));
    expect(withPull.length).toBe(2);
    for (const step of withPull) expect(step.url).not.toContain('pull2');
  });
});

describe('orderingMacro', () => {
  it('interleaves opens with the actions that depend on them', () => {
    // The v1 bug was an executor that ran every open before every click. A fixture that listed
    // its opens first could not tell a fixed executor from a broken one.
    const kinds = orderingMacro(NOW).steps.map((s) => s.kind);
    expect(kinds).toEqual(['open_url', 'click', 'open_url', 'wait_for', 'type', 'open_url']);
  });

  it('can actually produce a mid-flow offer', () => {
    // `matchInProgress` skips any macro with `openSteps.length < minMatch + 1`, so a two-page
    // fixture would make the live-offer test silently unrunnable rather than failing loudly.
    const macro = { ...orderingMacro(NOW), id: 1 };
    const visited = [
      open(NOW, FIXTURE_PAGE_A),
      open(NOW + 5_000, FIXTURE_PAGE_B),
    ];
    const match = matchInProgress(visited, [macro], {
      minMatch: MACRO_INPROGRESS_MIN_MATCH,
      openUrls: new Set<string>(),
    });

    expect(match?.matched).toBe(MACRO_INPROGRESS_MIN_MATCH);
    expect(match?.remaining.filter((s) => s.kind === 'open_url').map((s) => s.url)).toEqual([
      FIXTURE_PAGE_C,
    ]);
  });

  it('makes no offer once the last page is already open', () => {
    const macro = { ...orderingMacro(NOW), id: 1 };
    const visited = [open(NOW, FIXTURE_PAGE_A), open(NOW + 5_000, FIXTURE_PAGE_B)];
    const match = matchInProgress(visited, [macro], {
      minMatch: MACRO_INPROGRESS_MIN_MATCH,
      openUrls: new Set([FIXTURE_PAGE_C]),
    });
    expect(match).toBeNull();
  });

  it('is saved, not suggested, so Run is available immediately', () => {
    expect(orderingMacro(NOW).status).toBe('accepted');
  });

  it('keeps the name the harness gave it through a recompute', () => {
    expect(orderingMacro(NOW).nameIsUserSet).toBe(true);
  });

  it('carries text only on the step the user authored', () => {
    // Guards the privacy rule from the fixture side: nothing here may imply recorded keystrokes.
    const withText = orderingMacro(NOW).steps.filter((s) => s.text !== undefined);
    expect(withText.map((s) => s.kind)).toEqual(['type']);
  });
});

describe('pagesFor', () => {
  it('leaves the real pages alone when no origin is given', () => {
    expect(pagesFor(undefined)).toBe(DEFAULT_PAGES);
  });

  it('retargets every page at a local origin', () => {
    const pages = pagesFor('http://127.0.0.1:5319');
    expect(pages.a).toBe('http://127.0.0.1:5319/page-a');
    expect(pages.repo).toBe('http://127.0.0.1:5319/acme/web');
    expect(pages.dashboard).toBe('http://127.0.0.1:5319/dashboard');
  });

  it('tolerates a trailing slash', () => {
    expect(pagesFor('http://127.0.0.1:5319/').a).toBe('http://127.0.0.1:5319/page-a');
  });

  it('still produces a {pull} parameter against a local origin', () => {
    // The parameter is named after the path segment before the varying one, so an override that
    // flattened the route would quietly rename `{pull}` and the E2E assertion would be testing
    // something else.
    const pages = pagesFor('http://127.0.0.1:5319');
    const actions = paramRoutineEvents(NOW, pages)
      .map(eventToAction)
      .filter((a): a is ObservedAction => a !== null);
    const sessions = sessionize(actions, SESSION_GAP_MS);
    const candidate = detectBySequence(sessions, MACRO_MIN_RUNS, MACRO_SEQ_MIN_DAYS)[0]!;
    const { params } = deriveParams(candidate.steps, sessions);

    expect(params.map((p) => p.name)).toEqual(['pull']);
    expect(params[0]!.lastValue).toBe(PARAM_FIXTURE_VALUES.at(-1));
  });

  it('builds an ordering macro whose steps all point at the override', () => {
    const pages = pagesFor('http://127.0.0.1:5319');
    const urls = orderingMacro(NOW, pages).steps.map((s) => s.url);
    for (const url of urls) expect(url.startsWith('http://127.0.0.1:5319/')).toBe(true);
  });
});

describe('fixtureDomains', () => {
  it('names the hosts the harness seeds events onto, so cleanup can find them', () => {
    expect(fixtureDomains(DEFAULT_PAGES).sort()).toEqual(['app.example.com', 'github.com']);
    expect(fixtureDomains(pagesFor('http://127.0.0.1:5319'))).toEqual(['127.0.0.1']);
  });
});

describe('attachClicks on the fixture history', () => {
  it('does not invent clicks from a history that has none', () => {
    const sessions = sessionsFromFixture();
    const candidate = detectBySequence(sessions, MACRO_MIN_RUNS, MACRO_SEQ_MIN_DAYS)[0]!;
    const withClicks = attachClicks(candidate.steps, sessions);
    expect(withClicks.filter((s) => s.kind === 'click')).toHaveLength(0);
  });
});
