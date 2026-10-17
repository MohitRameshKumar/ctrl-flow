// Pure builders for the Standup draft and Coverage Doc. No chrome.* / Dexie here, so everything is
// unit-testable with plain `node --test`. What these functions return is exactly what leaves the
// device: titles, URLs, domains, durations, counts and event names. Never page content or typed text.
import { isBlocklisted } from './privacy.ts';
import type { BlocklistConfig, CadenceEvent, CalendarEvent, Ritual, Space, SpaceUrl } from './types.ts';

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;

/** A tab nobody touched is credited at most this long; with a click/typing in it, up to ACTIVE_CAP. */
export const IDLE_CAP_MS = 5 * MIN_MS;
export const ACTIVE_CAP_MS = 60 * MIN_MS;
const LATE_BURST_GRACE_MS = 8000; // typing_burst events arrive ~5 s after the last keystroke

export const MAX_SPACES = 10;
export const MAX_PAGES = 15;
export const MAX_TYPING_DOCS = 10;
export const MAX_GITHUB = 10;
export const MAX_MEETINGS = 15;
export const MAX_TITLE_CHARS = 120;
export const MAX_COVERAGE_SPACES = 8;
export const MAX_COVERAGE_TABS = 5;
export const MAX_DUTIES = 12;
export const MAX_RITUAL_DOCS = 6;
/** Hard ceiling on the serialized request body; the proxy rejects > 50 KB. */
export const MAX_BODY_CHARS = 45000;

export type StandupRangeKind = 'yesterday' | 'last24h' | 'sinceLast';

export interface TimeRange {
  from: number;
  to: number;
  label: string;
}

export interface StandupInput {
  range: { label: string; from: string; to: string };
  spaces: { name: string; minutes: number }[];
  pages: { title: string; domain: string; minutes: number }[];
  typing: { title: string; domain: string; bursts: number }[];
  github: { kind: string; title: string; url: string; minutes: number }[];
  meetings: { title: string; start: string; minutes: number; joinedCall: boolean }[];
  today: { meetings: { title: string; start: string; minutes: number }[]; lastSpace: string | null };
}

export interface StandupDraft {
  yesterday: string[];
  today: string[];
  blockers: string[];
}

export interface CoverageInput {
  range: { from: string; to: string; days: number };
  recurringMeetings: { title: string; cadence: string; occurrencesInRange: number; links: { title: string; url: string }[] }[];
  rituals: { title: string; status: string; docs: { title: string; url: string }[] }[];
  spaces: { name: string; topTabs: { title: string; url: string }[] }[];
  weeklyDuties: { domain: string; daysVisited: number; exampleTitle: string }[];
}

// ---- time helpers ---------------------------------------------------------------------------------

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Yesterday" = local midnight to local midnight; "since last standup" falls back to 24 h if there is none. */
export function resolveRange(kind: StandupRangeKind, now: number, lastStandupAt?: number | null): TimeRange {
  if (kind === 'yesterday') {
    const to = startOfLocalDay(now);
    const from = startOfLocalDay(to - 1);
    return { from, to, label: `yesterday (${dayLabel(from)})` };
  }
  if (kind === 'sinceLast' && lastStandupAt && lastStandupAt < now) {
    return { from: lastStandupAt, to: now, label: `since your last standup (${dayLabel(lastStandupAt)})` };
  }
  return { from: now - DAY_MS, to: now, label: 'the last 24 hours' };
}

// ---- active time -----------------------------------------------------------------------------------

export interface Segment {
  url: string;
  title?: string;
  domain: string;
  start: number;
  end: number;
}

function hostOf(e: Pick<CadenceEvent, 'domain' | 'url'>): string {
  if (e.domain) return e.domain;
  try {
    return new URL(e.url ?? '').hostname;
  } catch {
    return '';
  }
}

/** Events that are fit to summarize: not synthetic, not (any longer) blocklisted. */
export function usableEvents(events: CadenceEvent[], blocklist: BlocklistConfig): CadenceEvent[] {
  return events.filter((e) => {
    if (e.synthetic) return false;
    const host = hostOf(e);
    return !(host && isBlocklisted(host, blocklist));
  });
}

/**
 * Active time per visit, from tab_activated events. A visit runs until the next activation, but is
 * cut at the first loss of Chrome focus, and capped (5 min idle / 60 min if the tab saw a click or
 * typing) so a tab left open overnight doesn't count as work. Pass events starting a little before
 * `from` so a visit already in progress is included; it is clipped to the range.
 */
export function computeSegments(events: CadenceEvent[], from: number, to: number): Segment[] {
  const acts = events
    .filter((e) => e.kind === 'tab_activated' && e.url)
    .sort((a, b) => a.ts - b.ts);
  const blurs = events.filter((e) => e.kind === 'chrome_focus_lost').map((e) => e.ts).sort((a, b) => a - b);
  const activity = events.filter(
    (e) => e.url && (e.kind === 'click' || e.kind === 'typing_burst' || e.kind === 'field_changed'),
  );

  const segments: Segment[] = [];
  for (let i = 0; i < acts.length; i++) {
    const cur = acts[i]!;
    const next = acts[i + 1];
    const nextTs = next ? next.ts : Infinity;
    const touched = activity.some(
      (a) => a.url === cur.url && a.ts >= cur.ts && a.ts <= nextTs + LATE_BURST_GRACE_MS,
    );
    const blur = blurs.find((b) => b > cur.ts);
    const end = Math.min(nextTs, cur.ts + (touched ? ACTIVE_CAP_MS : IDLE_CAP_MS), blur ?? Infinity, to);
    const start = Math.max(cur.ts, from);
    if (end > start) {
      segments.push({ url: cur.url!, title: cur.title, domain: hostOf(cur), start, end });
    }
  }
  return segments;
}

function minutes(ms: number): number {
  return Math.round(ms / MIN_MS);
}

function trimTitle(title: string | undefined, fallback: string): string {
  const t = (title ?? '').trim().replace(/\s+/g, ' ');
  return (t || fallback).slice(0, MAX_TITLE_CHARS);
}

// ---- GitHub ----------------------------------------------------------------------------------------

export function classifyGithubUrl(url: string): { kind: string; repo: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  if (parts[2] === 'pull' || parts[2] === 'pulls') return { kind: parts[3] ? 'pull request' : 'pull requests', repo };
  if (parts[2] === 'issues') return { kind: parts[3] ? 'issue' : 'issues', repo };
  if (parts.length === 2) return { kind: 'repo', repo };
  return { kind: parts[2] === 'commit' || parts[2] === 'commits' ? 'commit' : 'repo page', repo };
}

// ---- Standup input ---------------------------------------------------------------------------------

export interface RawStandupData {
  /** Events from (range.from - ACTIVE_CAP_MS) to now, any kind. */
  events: CadenceEvent[];
  spaces: Space[];
  spaceUrls: SpaceUrl[];
  /** Calendar events overlapping [range.from, now + 1 day]. */
  calendar: CalendarEvent[];
  blocklist: BlocklistConfig;
  range: TimeRange;
  now: number;
}

const MEETING_JOIN_DOMAINS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com'];

function isMeetingHost(host: string): boolean {
  return MEETING_JOIN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export function buildStandupInput(raw: RawStandupData): StandupInput {
  const { range, now } = raw;
  const events = usableEvents(raw.events, raw.blocklist);
  const segments = computeSegments(events, range.from, range.to);

  const msByUrl = new Map<string, { ms: number; title?: string; domain: string }>();
  for (const s of segments) {
    const entry = msByUrl.get(s.url) ?? { ms: 0, title: s.title, domain: s.domain };
    entry.ms += s.end - s.start;
    entry.title = s.title ?? entry.title;
    msByUrl.set(s.url, entry);
  }

  const spaceNameById = new Map(raw.spaces.map((s) => [s.id, s.name]));
  const spaceByUrl = new Map(raw.spaceUrls.map((u) => [u.url, u.spaceId]));
  const msBySpace = new Map<string, number>();
  for (const [url, v] of msByUrl) {
    const name = spaceNameById.get(spaceByUrl.get(url));
    if (name) msBySpace.set(name, (msBySpace.get(name) ?? 0) + v.ms);
  }

  const spaces = [...msBySpace.entries()]
    .map(([name, ms]) => ({ name, minutes: minutes(ms) }))
    .filter((s) => s.minutes >= 1)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, MAX_SPACES);

  const pages = [...msByUrl.entries()]
    .map(([url, v]) => ({ title: trimTitle(v.title, v.domain || url), domain: v.domain, minutes: minutes(v.ms) }))
    .filter((p) => p.minutes >= 1)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, MAX_PAGES);

  const bursts = new Map<string, { bursts: number; title?: string; domain: string }>();
  for (const e of events) {
    if (e.kind !== 'typing_burst' || !e.url || e.ts < range.from || e.ts >= range.to) continue;
    const entry = bursts.get(e.url) ?? { bursts: 0, title: e.title, domain: hostOf(e) };
    entry.bursts++;
    entry.title = e.title ?? entry.title;
    bursts.set(e.url, entry);
  }
  const typing = [...bursts.entries()]
    .map(([url, v]) => ({ title: trimTitle(v.title, v.domain || url), domain: v.domain, bursts: v.bursts }))
    .sort((a, b) => b.bursts - a.bursts)
    .slice(0, MAX_TYPING_DOCS);

  const github = [...msByUrl.entries()]
    .flatMap(([url, v]) => {
      const c = classifyGithubUrl(url);
      return c ? [{ kind: c.kind, title: trimTitle(v.title, c.repo), url, minutes: minutes(v.ms) }] : [];
    })
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, MAX_GITHUB);

  const joinedWindows = segments.filter((s) => isMeetingHost(s.domain));
  const inRange = raw.calendar
    .filter((c) => c.start >= range.from && c.start < range.to)
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_MEETINGS);
  const meetings = inRange.map((c) => ({
    title: trimTitle(c.title, '(untitled)'),
    start: `${dayKey(c.start)} ${clock(c.start)}`,
    minutes: minutes(c.end - c.start),
    joinedCall: joinedWindows.some((s) => s.start < c.end && s.end > c.start - 5 * MIN_MS),
  }));

  const todayStart = startOfLocalDay(now);
  const todayMeetings = raw.calendar
    .filter((c) => c.start >= todayStart && c.start < todayStart + DAY_MS)
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_MEETINGS)
    .map((c) => ({ title: trimTitle(c.title, '(untitled)'), start: clock(c.start), minutes: minutes(c.end - c.start) }));

  // Last space the user was actually working in (their own switches, not Cadence's).
  const lastActive = events
    .filter((e) => e.kind === 'tab_activated' && e.url && !e.programmatic && spaceByUrl.has(e.url) && e.ts <= now)
    .sort((a, b) => b.ts - a.ts)[0];
  const lastSpace = lastActive ? (spaceNameById.get(spaceByUrl.get(lastActive.url!)) ?? null) : null;

  return {
    range: { label: range.label, from: dayKey(range.from), to: dayKey(range.to) },
    spaces,
    pages,
    typing,
    github,
    meetings,
    today: { meetings: todayMeetings, lastSpace },
  };
}

/** Drops the least important items until the serialized request fits the proxy's body limit. */
export function fitToBody<T extends object>(input: T, lists: (keyof T)[], maxChars = MAX_BODY_CHARS): T {
  const copy = structuredClone(input) as Record<string, unknown>;
  for (let guard = 0; guard < 500 && JSON.stringify({ task: 'x', input: copy }).length > maxChars; guard++) {
    const longest = lists
      .map((k) => copy[k as string] as unknown[])
      .filter((l) => Array.isArray(l) && l.length > 0)
      .sort((a, b) => b.length - a.length)[0];
    if (!longest) break;
    longest.pop();
  }
  return copy as T;
}

// ---- Standup fallback / markdown ------------------------------------------------------------------

export function standupFallback(input: StandupInput): StandupDraft {
  const yesterday: string[] = [];
  for (const s of input.spaces) yesterday.push(`${s.minutes} min in ${s.name}`);
  for (const p of input.pages.slice(0, 5)) yesterday.push(`${p.title} (${p.domain}) — ${p.minutes} min`);
  for (const t of input.typing) yesterday.push(`Wrote in ${t.title} (${t.domain}) — ${t.bursts} typing burst${t.bursts === 1 ? '' : 's'}`);
  for (const g of input.github) yesterday.push(`GitHub ${g.kind}: ${g.title}`);
  for (const m of input.meetings) yesterday.push(`Meeting: ${m.title} (${m.start}, ${m.minutes} min)`);

  const today: string[] = [];
  for (const m of input.today.meetings) today.push(`Meeting: ${m.title} at ${m.start}`);
  if (input.today.lastSpace) today.push(`Pick up where you left off in ${input.today.lastSpace}`);

  return { yesterday, today, blockers: [] };
}

export function standupToMarkdown(draft: StandupDraft): string {
  const section = (title: string, items: string[]) =>
    `## ${title}\n${items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '- (none)'}`;
  return [section('Yesterday', draft.yesterday), section('Today', draft.today), section('Blockers', draft.blockers)].join('\n\n') + '\n';
}

/** Textarea text -> items: one per non-empty line, leading bullets stripped. */
export function linesToItems(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
}

// ---- Coverage input --------------------------------------------------------------------------------

export interface RawCoverageData {
  /** Events from the last 7 days (any kind). */
  events: CadenceEvent[];
  /** Calendar events from (out.from - 14 days) to out.to, for cadence detection. */
  calendar: CalendarEvent[];
  rituals: Ritual[];
  spaces: Space[];
  spaceUrls: SpaceUrl[];
  blocklist: BlocklistConfig;
  out: { from: number; to: number };
  now: number;
}

export function cadenceOf(starts: number[]): string {
  if (starts.length < 2) return 'recurring';
  const sorted = [...starts].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((s, i) => s - sorted[i]!).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  if (median < 20 * 60 * MIN_MS) return 'several times a day';
  if (median < 36 * 60 * MIN_MS) return 'daily';
  if (median < 5 * DAY_MS) return 'a few times a week';
  if (median < 10 * DAY_MS) return 'weekly';
  if (median < 20 * DAY_MS) return 'every two weeks';
  return 'monthly';
}

export function buildCoverageInput(raw: RawCoverageData): CoverageInput {
  const { out, now } = raw;
  const events = usableEvents(raw.events, raw.blocklist);

  const bySeries = new Map<string, CalendarEvent[]>();
  for (const c of raw.calendar) {
    const list = bySeries.get(c.seriesKey) ?? [];
    list.push(c);
    bySeries.set(c.seriesKey, list);
  }
  const ritualBySeries = new Map(raw.rituals.map((r) => [r.seriesKey, r]));

  const recurringMeetings = [...bySeries.entries()]
    .flatMap(([seriesKey, list]) => {
      const inRange = list.filter((c) => c.start >= out.from && c.start < out.to);
      if (inRange.length === 0 || list.length < 2) return [];
      const ritual = ritualBySeries.get(seriesKey);
      return [
        {
          title: trimTitle(inRange[0]!.title, '(untitled)'),
          cadence: cadenceOf(list.map((c) => c.start)),
          occurrencesInRange: inRange.length,
          links: (ritual?.status === 'never' ? [] : (ritual?.urls ?? []))
            .slice(0, MAX_RITUAL_DOCS)
            .map((u) => ({ title: trimTitle(u.pageTitle, u.url), url: u.url })),
        },
      ];
    })
    .sort((a, b) => b.occurrencesInRange - a.occurrencesInRange)
    .slice(0, MAX_MEETINGS);

  const rituals = raw.rituals
    .filter((r) => (r.status === 'suggested' || r.status === 'accepted' || r.status === 'auto') && r.urls.length > 0)
    .slice(0, MAX_MEETINGS)
    .map((r) => ({
      title: trimTitle(r.title, '(untitled)'),
      status: r.status,
      docs: r.urls.slice(0, MAX_RITUAL_DOCS).map((u) => ({ title: trimTitle(u.pageTitle, u.url), url: u.url })),
    }));

  const weekStart = now - 7 * DAY_MS;
  const segments = computeSegments(events, weekStart, now);
  const msByUrl = new Map<string, number>();
  const titleByUrl = new Map<string, string | undefined>();
  for (const s of segments) {
    msByUrl.set(s.url, (msByUrl.get(s.url) ?? 0) + (s.end - s.start));
    titleByUrl.set(s.url, s.title ?? titleByUrl.get(s.url));
  }

  const spaceUrlsBySpace = new Map<number | undefined, SpaceUrl[]>();
  for (const u of raw.spaceUrls) {
    const list = spaceUrlsBySpace.get(u.spaceId) ?? [];
    list.push(u);
    spaceUrlsBySpace.set(u.spaceId, list);
  }
  const spaces = raw.spaces
    .map((s) => ({
      name: s.name,
      topTabs: (spaceUrlsBySpace.get(s.id) ?? [])
        .sort((a, b) => (msByUrl.get(b.url) ?? 0) - (msByUrl.get(a.url) ?? 0))
        .slice(0, MAX_COVERAGE_TABS)
        .map((u) => ({ title: trimTitle(u.title ?? titleByUrl.get(u.url), u.url), url: u.url })),
    }))
    .filter((s) => s.topTabs.length > 0)
    .slice(0, MAX_COVERAGE_SPACES);

  const daysByDomain = new Map<string, { days: Set<string>; title: string; ts: number }>();
  for (const e of events) {
    if ((e.kind !== 'tab_activated' && e.kind !== 'navigated') || !e.url || e.ts < weekStart || e.ts > now) continue;
    const host = hostOf(e);
    if (!host) continue;
    const entry = daysByDomain.get(host) ?? { days: new Set<string>(), title: '', ts: 0 };
    entry.days.add(dayKey(e.ts));
    if (e.title && e.ts >= entry.ts) {
      entry.title = e.title;
      entry.ts = e.ts;
    }
    daysByDomain.set(host, entry);
  }
  const weeklyDuties = [...daysByDomain.entries()]
    .filter(([, v]) => v.days.size >= 3)
    .map(([domain, v]) => ({ domain, daysVisited: v.days.size, exampleTitle: trimTitle(v.title, domain) }))
    .sort((a, b) => b.daysVisited - a.daysVisited || (a.domain < b.domain ? -1 : 1))
    .slice(0, MAX_DUTIES);

  return {
    range: { from: dayKey(out.from), to: dayKey(out.to), days: Math.max(1, Math.floor((out.to - out.from) / DAY_MS) + 1) },
    recurringMeetings,
    rituals,
    spaces,
    weeklyDuties,
  };
}

export function coverageFallbackMarkdown(input: CoverageInput): string {
  const lines: string[] = [`# Coverage doc: ${input.range.from} to ${input.range.to}`, ''];

  lines.push('## Duties');
  if (input.weeklyDuties.length === 0) lines.push('- (no sites visited on 3+ days this week)');
  for (const d of input.weeklyDuties) {
    lines.push(`- **${d.domain}**: visited on ${d.daysVisited} of the last 7 days (e.g. "${d.exampleTitle}")`);
  }

  lines.push('', '## Recurring meetings');
  if (input.recurringMeetings.length === 0) lines.push('- (none in this range)');
  for (const m of input.recurringMeetings) {
    const links = m.links.map((l) => `[${l.title}](${l.url})`).join(', ');
    lines.push(`- **${m.title}**: ${m.cadence}, ${m.occurrencesInRange} in range${links ? `. Prep: ${links}` : ''}`);
  }

  lines.push('', '## Active projects');
  if (input.spaces.length === 0) lines.push('- (no spaces yet)');
  for (const s of input.spaces) {
    lines.push(`- **${s.name}**: ${s.topTabs.map((t) => `[${t.title}](${t.url})`).join(', ')}`);
  }

  lines.push('', '## Key links');
  const seen = new Set<string>();
  const links: { title: string; url: string }[] = [];
  for (const group of [input.rituals.flatMap((r) => r.docs), input.spaces.flatMap((s) => s.topTabs)]) {
    for (const l of group) {
      if (!seen.has(l.url)) {
        seen.add(l.url);
        links.push(l);
      }
    }
  }
  if (links.length === 0) lines.push('- (none)');
  for (const l of links) lines.push(`- [${l.title}](${l.url})`);

  return lines.join('\n') + '\n';
}
