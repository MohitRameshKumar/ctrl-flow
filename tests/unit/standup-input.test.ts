import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVE_CAP_MS,
  IDLE_CAP_MS,
  MAX_BODY_CHARS,
  MAX_PAGES,
  buildCoverageInput,
  buildStandupInput,
  cadenceOf,
  classifyGithubUrl,
  computeSegments,
  coverageFallbackMarkdown,
  dayKey,
  fitToBody,
  linesToItems,
  resolveRange,
  standupFallback,
  standupToMarkdown,
  startOfLocalDay,
  type RawStandupData,
} from '../../lib/standup-input.ts';
import type { BlocklistConfig, CadenceEvent, CalendarEvent, Ritual, Space, SpaceUrl } from '../../lib/types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BLOCKLIST: BlocklistConfig = { domains: ['bank.test'], substrings: ['mychart'] };

// A fixed "now": local noon, so "yesterday" is a clean local-midnight window.
const NOW = startOfLocalDay(Date.now()) + 12 * HOUR;
const YESTERDAY = startOfLocalDay(NOW) - DAY;

function act(url: string, title: string, ts: number, extra: Partial<CadenceEvent> = {}): CadenceEvent {
  return { ts, kind: 'tab_activated', url, domain: new URL(url).hostname, title, ...extra };
}
function ev(kind: CadenceEvent['kind'], url: string, ts: number, extra: Partial<CadenceEvent> = {}): CadenceEvent {
  return { ts, kind, url, domain: new URL(url).hostname, ...extra };
}
function raw(events: CadenceEvent[], extra: Partial<RawStandupData> = {}): RawStandupData {
  return {
    events,
    spaces: [],
    spaceUrls: [],
    calendar: [],
    blocklist: BLOCKLIST,
    range: resolveRange('yesterday', NOW),
    now: NOW,
    ...extra,
  };
}

test('ranges: yesterday is local midnight to midnight; last 24 h; since-last falls back to 24 h', () => {
  const y = resolveRange('yesterday', NOW);
  assert.equal(y.from, YESTERDAY);
  assert.equal(y.to, startOfLocalDay(NOW));
  assert.match(y.label, /^yesterday/);
  const d = resolveRange('last24h', NOW);
  assert.deepEqual([d.from, d.to], [NOW - DAY, NOW]);
  assert.deepEqual(
    [resolveRange('sinceLast', NOW, null).from, resolveRange('sinceLast', NOW, undefined).from],
    [NOW - DAY, NOW - DAY],
  );
  const since = resolveRange('sinceLast', NOW, NOW - 3 * HOUR);
  assert.deepEqual([since.from, since.to], [NOW - 3 * HOUR, NOW]);
});

test('segments: a visit runs to the next activation and is clipped to the range', () => {
  const t = YESTERDAY + 9 * HOUR;
  const events = [act('https://a.test/', 'A', t), act('https://b.test/', 'B', t + 4 * MIN)];
  const segs = computeSegments(events, YESTERDAY, startOfLocalDay(NOW));
  assert.equal(segs[0]!.end - segs[0]!.start, 4 * MIN);
  // A visit that began before the range only counts from the range start.
  const before = computeSegments([act('https://a.test/', 'A', YESTERDAY - 2 * MIN), act('https://b.test/', 'B', YESTERDAY + 3 * MIN)], YESTERDAY, YESTERDAY + DAY);
  assert.equal(before[0]!.end - before[0]!.start, 3 * MIN);
});

test('segments: idle tabs are capped at 5 min, tabs with a click/typing at 60 min, focus loss cuts a visit', () => {
  const t = YESTERDAY + 9 * HOUR;
  const idle = computeSegments([act('https://a.test/', 'A', t), act('https://b.test/', 'B', t + 5 * HOUR)], YESTERDAY, YESTERDAY + DAY);
  assert.equal(idle[0]!.end - idle[0]!.start, IDLE_CAP_MS);

  const active = computeSegments(
    [act('https://a.test/', 'A', t), ev('typing_burst', 'https://a.test/', t + MIN), act('https://b.test/', 'B', t + 5 * HOUR)],
    YESTERDAY,
    YESTERDAY + DAY,
  );
  assert.equal(active[0]!.end - active[0]!.start, ACTIVE_CAP_MS);

  const blurred = computeSegments(
    [act('https://a.test/', 'A', t), ev('chrome_focus_lost', 'https://a.test/', t + 2 * MIN), act('https://b.test/', 'B', t + HOUR)],
    YESTERDAY,
    YESTERDAY + DAY,
  );
  assert.equal(blurred[0]!.end - blurred[0]!.start, 2 * MIN);
});

test('input: minutes per space and top pages come from active time, sorted', () => {
  const t = YESTERDAY + 9 * HOUR;
  const spaces: Space[] = [{ id: 1, name: 'EE 242 homework', status: 'ai', createdAt: 0, updatedAt: 0 }];
  const spaceUrls: SpaceUrl[] = [{ id: 1, spaceId: 1, url: 'https://docs.test/hw', source: 'ai', alwaysOpen: false }];
  const input = buildStandupInput(
    raw(
      [
        act('https://docs.test/hw', 'HW 3', t),
        act('https://news.test/x', 'An article', t + 4 * MIN),
        act('https://docs.test/hw', 'HW 3', t + 6 * MIN),
        act('https://other.test/', 'Other', t + 10 * MIN),
      ],
      { spaces, spaceUrls },
    ),
  );
  assert.deepEqual(input.spaces, [{ name: 'EE 242 homework', minutes: 8 }]);
  assert.equal(input.pages[0]!.title, 'HW 3');
  assert.equal(input.pages[0]!.minutes, 8);
  assert.ok(input.pages.every((p, i) => i === 0 || input.pages[i - 1]!.minutes >= p.minutes));
});

test('input: synthetic events and blocklisted domains are excluded everywhere', () => {
  const t = YESTERDAY + 9 * HOUR;
  const input = buildStandupInput(
    raw([
      act('https://good.test/', 'Good', t),
      act('https://bank.test/account', 'My bank', t + 5 * MIN, {}),
      act('https://mychart.hospital.test/', 'Results', t + 6 * MIN),
      act('https://fake.test/', 'Synthetic', t + 7 * MIN, { synthetic: true }),
      ev('typing_burst', 'https://bank.test/account', t + 5 * MIN),
      ev('typing_burst', 'https://fake.test/', t + 7 * MIN, { synthetic: true, title: 'Synthetic' }),
      act('https://good.test/', 'Good', t + 30 * MIN),
    ]),
  );
  const text = JSON.stringify(input);
  assert.ok(!text.includes('bank.test'));
  assert.ok(!text.includes('mychart'));
  assert.ok(!text.includes('fake.test'));
  assert.ok(text.includes('good.test'));
  assert.deepEqual(input.typing, []);
});

test('input: typing docs are counts of bursts only, never key counts or text', () => {
  const t = YESTERDAY + 9 * HOUR;
  const input = buildStandupInput(
    raw([
      act('https://docs.test/notes', 'Notes', t),
      ev('typing_burst', 'https://docs.test/notes', t + MIN, { title: 'Notes', keyCount: 41 }),
      ev('typing_burst', 'https://docs.test/notes', t + 2 * MIN, { title: 'Notes', keyCount: 12 }),
    ]),
  );
  assert.deepEqual(input.typing, [{ title: 'Notes', domain: 'docs.test', bursts: 2 }]);
  assert.ok(!JSON.stringify(input).includes('41'));
});

test('input: GitHub repo / issue / PR pages are classified from URLs', () => {
  assert.deepEqual(classifyGithubUrl('https://github.com/acme/web/pull/12'), { kind: 'pull request', repo: 'acme/web' });
  assert.deepEqual(classifyGithubUrl('https://github.com/acme/web/issues/3'), { kind: 'issue', repo: 'acme/web' });
  assert.deepEqual(classifyGithubUrl('https://github.com/acme/web'), { kind: 'repo', repo: 'acme/web' });
  assert.equal(classifyGithubUrl('https://example.com/acme/web'), null);
  const t = YESTERDAY + 9 * HOUR;
  const input = buildStandupInput(
    raw([act('https://github.com/acme/web/pull/12', 'Fix login by x · PR #12', t), act('https://x.test/', 'x', t + 6 * MIN)]),
  );
  assert.equal(input.github[0]!.kind, 'pull request');
  assert.equal(input.github[0]!.title, 'Fix login by x · PR #12');
});

test('input: meetings come from the calendar in range, flagged if a call tab was open; today lists today only', () => {
  const t = YESTERDAY + 10 * HOUR;
  const calendar: CalendarEvent[] = [
    { id: '1', seriesKey: 's', title: 'Team sync', start: t, end: t + 30 * MIN },
    { id: '2', seriesKey: 's', title: 'Team sync', start: t + 2 * HOUR, end: t + 2 * HOUR + 30 * MIN },
    { id: '3', seriesKey: 't', title: 'Standup today', start: startOfLocalDay(NOW) + 9 * HOUR, end: startOfLocalDay(NOW) + 10 * HOUR },
  ];
  const input = buildStandupInput(
    raw([act('https://meet.google.com/abc', 'Meet', t + MIN), act('https://x.test/', 'x', t + 25 * MIN)], { calendar }),
  );
  assert.deepEqual(input.meetings.map((m) => [m.title, m.joinedCall]), [['Team sync', true], ['Team sync', false]]);
  assert.deepEqual(input.today.meetings.map((m) => m.title), ['Standup today']);
});

test('input: last space ignores Cadence-initiated switches', () => {
  const spaces: Space[] = [
    { id: 1, name: 'Writing', status: 'ai', createdAt: 0, updatedAt: 0 },
    { id: 2, name: 'Reading', status: 'ai', createdAt: 0, updatedAt: 0 },
  ];
  const spaceUrls: SpaceUrl[] = [
    { id: 1, spaceId: 1, url: 'https://w.test/', source: 'ai', alwaysOpen: false },
    { id: 2, spaceId: 2, url: 'https://r.test/', source: 'ai', alwaysOpen: false },
  ];
  const input = buildStandupInput(
    raw([act('https://w.test/', 'W', NOW - 20 * MIN), act('https://r.test/', 'R', NOW - 10 * MIN, { programmatic: true })], { spaces, spaceUrls }),
  );
  assert.equal(input.today.lastSpace, 'Writing');
});

test('caps: lists are capped and the body is trimmed under the 50 KB limit', () => {
  const t = YESTERDAY + 9 * HOUR;
  const events: CadenceEvent[] = [];
  for (let i = 0; i < 80; i++) events.push(act(`https://site${i}.test/page`, 'T'.repeat(300), t + i * 10 * MIN));
  const input = buildStandupInput(raw(events));
  assert.ok(input.pages.length <= MAX_PAGES);
  assert.ok(input.pages.every((p) => p.title.length <= 120));
  const big = { pages: Array.from({ length: 400 }, (_, i) => ({ title: 'x'.repeat(200), domain: `d${i}.test`, minutes: 1 })), spaces: [] };
  const fitted = fitToBody(big, ['pages', 'spaces']);
  assert.ok(JSON.stringify({ task: 'x', input: fitted }).length <= MAX_BODY_CHARS);
  assert.ok(fitted.pages.length > 0);
  assert.equal(big.pages.length, 400); // input not mutated
});

test('fallback: raw activity grouped under the same three headings, blockers never invented', () => {
  const t = YESTERDAY + 9 * HOUR;
  const calendar: CalendarEvent[] = [{ id: '3', seriesKey: 't', title: 'Standup today', start: startOfLocalDay(NOW) + 9 * HOUR, end: startOfLocalDay(NOW) + 10 * HOUR }];
  const spaces: Space[] = [{ id: 1, name: 'Club website', status: 'ai', createdAt: 0, updatedAt: 0 }];
  const spaceUrls: SpaceUrl[] = [{ id: 1, spaceId: 1, url: 'https://github.com/acme/web/issues/3', source: 'ai', alwaysOpen: false }];
  const input = buildStandupInput(
    raw([act('https://github.com/acme/web/issues/3', 'Bug: nav broken', t), act('https://x.test/', 'x', t + 12 * MIN)], { calendar, spaces, spaceUrls }),
  );
  const draft = standupFallback(input);
  assert.ok(draft.yesterday.some((l) => l.includes('Club website')));
  assert.ok(draft.yesterday.some((l) => l.includes('GitHub issue: Bug: nav broken')));
  assert.ok(draft.today.some((l) => l.includes('Standup today')));
  assert.deepEqual(draft.blockers, []);
  const md = standupToMarkdown(draft);
  assert.match(md, /## Yesterday[\s\S]*## Today[\s\S]*## Blockers\n- \(none\)/);
  assert.deepEqual(linesToItems('- one\n  * two\n\n three '), ['one', 'two', 'three']);
});

test('coverage: recurring meetings (cadence, ritual links), weekly duties need 3+ distinct days, blocklist and synthetic excluded', () => {
  const out = { from: NOW + 6 * DAY, to: NOW + 8 * DAY }; // contains the weekly series' occurrence at NOW + 7d
  const weekly = (n: number, title: string, seriesKey: string): CalendarEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `${seriesKey}${i}`,
      seriesKey,
      title,
      start: NOW - 14 * DAY + i * 7 * DAY,
      end: NOW - 14 * DAY + i * 7 * DAY + HOUR,
    }));
  const calendar = [...weekly(5, 'Weekly review', 'wr'), { id: 'one', seriesKey: 'solo', title: 'One-off', start: out.from + HOUR, end: out.from + 2 * HOUR }];
  const rituals: Ritual[] = [
    { id: 1, seriesKey: 'wr', title: 'Weekly review', status: 'accepted', removedUrls: [], updatedAt: 0, urls: [{ url: 'https://docs.test/review', pageTitle: 'Review notes', occurrences: 2 }] },
    { id: 2, seriesKey: 'n', title: 'Dropped', status: 'never', removedUrls: [], updatedAt: 0, urls: [{ url: 'https://docs.test/no', occurrences: 2 }] },
  ];
  const events: CadenceEvent[] = [];
  for (let d = 1; d <= 4; d++) events.push(act('https://canvas.test/inbox', 'Inbox', NOW - d * DAY));
  for (let d = 1; d <= 2; d++) events.push(act('https://rare.test/', 'Rare', NOW - d * DAY));
  for (let d = 1; d <= 5; d++) events.push(act('https://bank.test/', 'Bank', NOW - d * DAY));
  for (let d = 1; d <= 5; d++) events.push(act('https://fake.test/', 'Fake', NOW - d * DAY, { synthetic: true }));

  const input = buildCoverageInput({ events, calendar, rituals, spaces: [], spaceUrls: [], blocklist: BLOCKLIST, out, now: NOW });
  assert.deepEqual(input.weeklyDuties.map((d) => d.domain), ['canvas.test']);
  assert.equal(input.weeklyDuties[0]!.daysVisited, 4);
  const review = input.recurringMeetings.find((m) => m.title === 'Weekly review');
  assert.ok(review);
  assert.equal(review.cadence, 'weekly');
  assert.deepEqual(review.links, [{ title: 'Review notes', url: 'https://docs.test/review' }]);
  assert.ok(!input.recurringMeetings.some((m) => m.title === 'One-off'));
  assert.deepEqual(input.rituals.map((r) => r.title), ['Weekly review']);
  assert.equal(input.range.from, dayKey(out.from));
  assert.equal(input.range.days, 3); // inclusive: out.from .. out.to is 2 days apart
});

test('coverage: spaces list top tabs by active time; fallback markdown has all four sections', () => {
  const t = NOW - 2 * DAY;
  const spaces: Space[] = [{ id: 1, name: 'Club website', status: 'ai', createdAt: 0, updatedAt: 0 }];
  const spaceUrls: SpaceUrl[] = [
    { id: 1, spaceId: 1, url: 'https://github.com/acme/web', title: 'acme/web', source: 'ai', alwaysOpen: false },
    { id: 2, spaceId: 1, url: 'https://docs.test/plan', title: 'Plan', source: 'ai', alwaysOpen: false },
  ];
  const events = [act('https://docs.test/plan', 'Plan', t), act('https://x.test/', 'x', t + 4 * MIN)];
  const input = buildCoverageInput({ events, calendar: [], rituals: [], spaces, spaceUrls, blocklist: BLOCKLIST, out: { from: NOW + DAY, to: NOW + 3 * DAY }, now: NOW });
  assert.equal(input.spaces[0]!.topTabs[0]!.title, 'Plan');
  const md = coverageFallbackMarkdown(input);
  for (const h of ['# Coverage doc', '## Duties', '## Recurring meetings', '## Active projects', '## Key links']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('[Plan](https://docs.test/plan)'));
});

test('cadence labels', () => {
  assert.equal(cadenceOf([0, 3 * HOUR, 6 * HOUR]), 'several times a day');
  assert.equal(cadenceOf([0, DAY, 2 * DAY]), 'daily');
  assert.equal(cadenceOf([0, 7 * DAY, 14 * DAY]), 'weekly');
  assert.equal(cadenceOf([0]), 'recurring');
  assert.equal(dayKey(new Date(2026, 9, 5).getTime()), '2026-10-05');
});
