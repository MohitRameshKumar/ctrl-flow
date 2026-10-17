/**
 * Synthetic histories and macros used only by the debug page's test harness.
 *
 * Pure by the same rule as `macro-detection.ts`: no `chrome.*`, no Dexie, no `import.meta`, so
 * `tests/dev-fixtures.test.ts` can run the real detector over this data and prove the harness
 * still reaches the states it claims to. A fixture that silently stops producing a parameterized
 * macro would make a manual test pass for the wrong reason, which is worse than no fixture.
 */

import type { CadenceEvent, Macro, MacroStep } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The pages a seeded macro acts on, and the selectors it acts with.
 *
 * Parameterized because the two callers need different targets and neither should compromise.
 * A human following the runbook wants real pages they recognize; the Playwright suite wants a
 * local server it fully controls, on a port that changes every run. Pinning either one would
 * make the other unreliable.
 */
export interface FixturePages {
  /** Page carrying the click target. */
  a: string;
  /** Page carrying the text field. */
  b: string;
  /** Third page, needed only so the macro is long enough to offer. */
  c: string;
  /** Click target on page A. Following it must navigate, so the click is observable. */
  link: string;
  /** Text field on page B. */
  search: string;
  /** Repo root for the parameterized routine; `/pull/<id>` is appended. */
  repo: string;
  /** Constant page at the end of the parameterized routine. */
  dashboard: string;
}

/** Real pages: fast, no login, and stable enough to assert against by hand. */
export const DEFAULT_PAGES: FixturePages = {
  a: 'https://example.com/',
  b: 'https://www.wikipedia.org/',
  c: 'https://example.org/',
  // example.com's only link; following it lands on iana.org.
  link: 'a',
  search: '#searchInput',
  repo: 'https://github.com/acme/web',
  dashboard: 'https://app.example.com/dashboard',
};

export const FIXTURE_PAGE_A = DEFAULT_PAGES.a;
export const FIXTURE_PAGE_B = DEFAULT_PAGES.b;
/**
 * A third page exists for one reason: `matchInProgress` requires a macro to have more open steps
 * than the match minimum, so a two-page macro can never produce a mid-flow offer. Without this
 * the harness could not exercise the live-offer path at all.
 */
export const FIXTURE_PAGE_C = DEFAULT_PAGES.c;

/**
 * Points every fixture at a local server instead of the public web.
 *
 * Path shapes are kept parallel to the real ones on purpose — in particular the parameterized
 * route stays `/<repo>/pull/<id>`, because the parameter is named after the path segment before
 * the varying one and a different shape would silently rename `{pull}`.
 */
export function pagesFor(origin: string | undefined): FixturePages {
  if (!origin) return DEFAULT_PAGES;
  const base = origin.replace(/\/+$/, '');
  return {
    a: `${base}/page-a`,
    b: `${base}/page-b`,
    c: `${base}/page-c`,
    link: '#more',
    search: '#searchInput',
    repo: `${base}/acme/web`,
    dashboard: `${base}/dashboard`,
  };
}

function step(partial: Omit<MacroStep, 'enabled' | 'support'> & Partial<MacroStep>): MacroStep {
  return { enabled: true, support: 3, ...partial };
}

/**
 * A macro whose correct execution is visible to the naked eye.
 *
 * Deliberately interleaved open → click → open → type: that exact shape is what v1's executor
 * destroyed by batching all opens ahead of all clicks, so running this is the regression test
 * for the original complaint. The click target navigates the page it is on, which makes "did the
 * click happen" observable without opening devtools.
 */
export function orderingMacro(now: number, pages: FixturePages = DEFAULT_PAGES): Macro {
  return {
    macroKey: 'm:harness-ordering',
    name: 'Harness — ordering check',
    nameIsUserSet: true,
    source: 'chrome',
    detector: 'sequence',
    steps: [
      step({ key: 'open:a', kind: 'open_url', url: pages.a, title: 'Harness page A' }),
      step({
        key: 'click:a',
        kind: 'click',
        url: pages.a,
        selector: pages.link,
        label: 'More information...',
      }),
      step({ key: 'open:b', kind: 'open_url', url: pages.b, title: 'Harness page B' }),
      step({
        key: 'waitfor:b',
        kind: 'wait_for',
        url: pages.b,
        selector: pages.search,
        label: 'search box',
      }),
      step({
        key: 'type:b',
        kind: 'type',
        url: pages.b,
        selector: pages.search,
        label: 'search box',
        text: 'cadence harness',
      }),
      step({ key: 'open:c', kind: 'open_url', url: pages.c, title: 'Harness page C' }),
    ],
    removedStepKeys: [],
    pinnedStepKeys: [],
    status: 'accepted',
    occurrences: 3,
    typicalHour: null,
    createdAt: now,
    updatedAt: now,
  };
}

interface SessionSpec {
  /** Whole days before `now`. Three distinct days clears MACRO_SEQ_MIN_DAYS without demo mode. */
  daysAgo: number;
  pull: string;
}

const PARAM_SESSIONS: SessionSpec[] = [
  { daysAgo: 4, pull: '812' },
  { daysAgo: 2, pull: '904' },
  { daysAgo: 0, pull: '977' },
];

/**
 * A per-ticket routine performed three times on three different tickets.
 *
 * Three runs across three days is what `detectBySequence` needs with the production thresholds,
 * so this seed does not require demo mode. Three distinct ids at the same path position is what
 * turns the fold `canonForNgram` already does into a surfaced `{pull}` parameter.
 */
export function paramRoutineEvents(
  now: number,
  pages: FixturePages = DEFAULT_PAGES,
): CadenceEvent[] {
  const events: CadenceEvent[] = [];
  let tabId = 9000;

  for (const { daysAgo, pull } of PARAM_SESSIONS) {
    // Anchored to 10:00 local so the sessions also agree on a typical hour.
    const base = new Date(now - daysAgo * DAY_MS).setHours(10, 0, 0, 0);
    const urls = [
      `${pages.repo}/pull/${pull}`,
      `${pages.repo}/pull/${pull}/files`,
      pages.dashboard,
    ];

    urls.forEach((url, index) => {
      events.push({
        // 20s apart: comfortably inside SESSION_GAP_MS so the three stay one session.
        ts: base + index * 20_000,
        kind: 'navigated',
        tabId: tabId + index,
        url,
        domain: new URL(url).hostname,
        title: url.includes('/files') ? `Files changed · #${pull}` : `#${pull}`,
      });
    });
    tabId += 10;
  }

  return events;
}

/** The ids `paramRoutineEvents` varies, for assertions and for telling the tester what to expect. */
export const PARAM_FIXTURE_VALUES = PARAM_SESSIONS.map((s) => s.pull);

/** Domains the harness seeds into `events`, so cleanup removes exactly what it created. */
export function fixtureDomains(pages: FixturePages): string[] {
  const hosts = new Set<string>();
  for (const url of [pages.repo, pages.dashboard]) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      /* a malformed override should not break cleanup */
    }
  }
  return [...hosts];
}
