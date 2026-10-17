// Gathers local data for the Standup draft and Coverage Doc, calls the proxy, and falls back to a
// local-only version if the AI is unavailable (timeout, error, offline, bad shape). The pure
// builders live in standup-input.ts.
import { runTask } from './ai';
import { createCalendarSource } from './calendar';
import { getEvents, getRituals, getSpaceUrls, getSpaces } from './db';
import { getBlocklist } from './privacy';
import {
  ACTIVE_CAP_MS,
  buildCoverageInput,
  buildStandupInput,
  coverageFallbackMarkdown,
  fitToBody,
  resolveRange,
  standupFallback,
  startOfLocalDay,
  type CoverageInput,
  type StandupDraft,
  type StandupInput,
  type StandupRangeKind,
} from './standup-input';

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_STANDUP_KEY = 'lastStandupAt';
const STANDUP_TIMEOUT_MS = 30000;
const COVERAGE_TIMEOUT_MS = 60000;

export type DraftSource = 'ai' | 'fallback';

export interface StandupResult {
  draft: StandupDraft;
  source: DraftSource;
  rangeLabel: string;
  error?: string;
}

export interface CoverageResult {
  markdown: string;
  source: DraftSource;
  error?: string;
}

async function getCalendarEvents(from: number, to: number) {
  const { calendarSource = 'demo' } = await chrome.storage.local.get<{ calendarSource?: 'demo' | 'google' }>('calendarSource');
  return createCalendarSource(calendarSource).getEvents(from, to);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Defensive shape check on the proxy's reply; anything odd falls back to the local draft. */
function parseDraft(data: unknown): StandupDraft | null {
  if (typeof data !== 'object' || data === null) return null;
  const { yesterday, today, blockers } = data as Record<string, unknown>;
  if (!isStringArray(yesterday) || !isStringArray(today)) return null;
  return { yesterday, today, blockers: isStringArray(blockers) ? blockers : [] };
}

export async function generateStandup(kind: StandupRangeKind): Promise<StandupResult> {
  const now = Date.now();
  const { [LAST_STANDUP_KEY]: lastStandupAt } = await chrome.storage.local.get<Record<string, number | undefined>>(LAST_STANDUP_KEY);
  const range = resolveRange(kind, now, lastStandupAt);

  const [events, spaces, spaceUrls, calendar, blocklist] = await Promise.all([
    getEvents(range.from - ACTIVE_CAP_MS, now),
    getSpaces(),
    getSpaceUrls(),
    getCalendarEvents(Math.min(range.from, startOfLocalDay(now)), startOfLocalDay(now) + DAY_MS),
    getBlocklist(),
  ]);
  const input: StandupInput = fitToBody(
    buildStandupInput({ events, spaces, spaceUrls, calendar, blocklist, range, now }),
    ['pages', 'typing', 'github', 'meetings', 'spaces'],
  );

  const result = await runTask<unknown>('standup', input, STANDUP_TIMEOUT_MS);
  await chrome.storage.local.set({ [LAST_STANDUP_KEY]: now });

  const draft = result.ok ? parseDraft(result.data) : null;
  if (draft) return { draft, source: 'ai', rangeLabel: range.label };
  return {
    draft: standupFallback(input),
    source: 'fallback',
    rangeLabel: range.label,
    error: result.ok ? 'The AI returned an unexpected reply.' : result.error,
  };
}

/** `from`/`to` are inclusive local dates ("YYYY-MM-DD"). */
export async function generateCoverage(fromDate: string, toDate: string): Promise<CoverageResult> {
  const now = Date.now();
  const from = startOfLocalDay(new Date(`${fromDate}T00:00:00`).getTime());
  const to = startOfLocalDay(new Date(`${toDate}T00:00:00`).getTime()) + DAY_MS - 1;

  const [events, calendar, rituals, spaces, spaceUrls, blocklist] = await Promise.all([
    getEvents(now - 7 * DAY_MS - ACTIVE_CAP_MS, now),
    getCalendarEvents(from - 14 * DAY_MS, to),
    getRituals(),
    getSpaces(),
    getSpaceUrls(),
    getBlocklist(),
  ]);
  const input: CoverageInput = fitToBody(
    buildCoverageInput({ events, calendar, rituals, spaces, spaceUrls, blocklist, out: { from, to }, now }),
    ['weeklyDuties', 'recurringMeetings', 'rituals', 'spaces'],
  );

  const result = await runTask<{ markdown?: unknown }>('coverage_doc', input, COVERAGE_TIMEOUT_MS);
  if (result.ok && typeof result.data?.markdown === 'string' && result.data.markdown.trim()) {
    return { markdown: result.data.markdown, source: 'ai' };
  }
  return {
    markdown: coverageFallbackMarkdown(input),
    source: 'fallback',
    error: result.ok ? 'The AI returned an unexpected reply.' : result.error,
  };
}
