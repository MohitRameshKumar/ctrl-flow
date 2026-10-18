// Leader R, "repeat the last action": pure selection logic (no chrome.*, no Dexie) so it is unit-testable.
// It decides *which window of activity* to repeat and how to describe it; building and running go
// through the macro feature's own functions (`recordMacroFromRecentActivity`, `runMacro`), the same
// ones Leader K uses, and both pass `refineSegment` so they cut the same segment the same way.
import { appLabel, candidateFromSession, isUsableSession, sessionize } from './macro-detection';
import { samePage } from './sites';
import type { Macro, MacroCandidate, ObservedAction } from './types';

/** Idle gap that ends a segment. Much shorter than detection's 3 minutes: R means "what I just did". */
export const SEGMENT_GAP_MS = 20 * 1000;
/** How far back a segment may start. */
export const SEGMENT_MAX_AGE_MS = 10 * 60 * 1000;
/** Same-tab loads this close together are one navigation chain (redirects), not separate pages. */
export const REDIRECT_CHAIN_MS = 4 * 1000;
/** An in-page (history API) navigation only counts if the user clicked in that tab this recently. */
export const SPA_CLICK_WINDOW_MS = 5 * 1000;
/**
 * The same page opened twice in a row is one step, however it got there: a new tab plus the redirect
 * inside it, `/u/0/h` then `/h`, or a sign-in hop that ended where it started. Wider than the
 * same-tab chain because Google's account redirects take several seconds and can change the tab.
 */
export const SAME_PAGE_COLLAPSE_MS = 60 * 1000;
export const PREVIEW_MAX_STEPS = 10;
/** Page loads from a replay's tabs can land just after the run is recorded as finished. */
export const REPLAY_TAIL_MS = 5 * 1000;
export const NAME_MAX_SITES = 4;

/**
 * Turns the raw action log into what the user deliberately did:
 *  - drops activations of tabs that were already open (they are not "opening" anything),
 *  - drops in-page navigations unless a click in the same tab just preceded them,
 *  - collapses each tab's redirect / navigation chain to its final URL.
 * Programmatic and synthetic events never get here: `eventToAction` already returns null for them.
 */
export function refineSegment(actions: ObservedAction[]): ObservedAction[] {
  const sorted = [...actions].sort((a, b) => a.ts - b.ts);

  const kept: ObservedAction[] = [];
  for (const a of sorted) {
    if (a.kind === 'open_url') {
      if (!a.deliberate) continue; // tab_activated: switching back to an existing tab
      if (a.spa) {
        const clicked = sorted.some(
          (c) => c.kind === 'click' && c.contextId === a.contextId && c.ts <= a.ts && a.ts - c.ts <= SPA_CLICK_WINDOW_MS,
        );
        if (!clicked) continue;
      }
    }
    kept.push(a);
  }

  const out: ObservedAction[] = [];
  const lastOpenIndexByContext = new Map<number, number>();
  for (const a of kept) {
    if (a.kind !== 'open_url' || a.contextId === undefined) {
      out.push(a);
      continue;
    }
    const prevIndex = lastOpenIndexByContext.get(a.contextId);
    const prev = prevIndex === undefined ? undefined : out[prevIndex];
    // A click-driven in-page navigation is something the user did, not a redirect: it stays its own step.
    if (prev && !a.spa && a.ts - prev.ts <= REDIRECT_CHAIN_MS) {
      out[prevIndex!] = a; // same chain: the later URL is where the tab ended up
      continue;
    }
    lastOpenIndexByContext.set(a.contextId, out.length);
    out.push(a);
  }

  // Second pass: the same page twice in a row, across tabs or after a slow hop, is one step.
  const collapsed: ObservedAction[] = [];
  let lastOpen: ObservedAction | undefined;
  let lastOpenAt = -1;
  for (const a of out) {
    if (a.kind !== 'open_url') {
      collapsed.push(a);
      continue;
    }
    if (lastOpen && lastOpenAt >= 0 && !a.spa && samePage(lastOpen.target, a.target) && a.ts - lastOpen.ts <= SAME_PAGE_COLLAPSE_MS) {
      collapsed[lastOpenAt] = a; // keep the later URL: it is where the page ended up
      lastOpen = a;
      continue;
    }
    lastOpen = a;
    lastOpenAt = collapsed.length;
    collapsed.push(a);
  }
  return collapsed;
}

export interface RepeatBoundaries {
  /** Latest end of any macro replay. */
  lastRunEnd?: number;
  /** Latest K / R / M-end: the log before this has already been consumed. */
  lastConsumed?: number;
  /** A pending M mark: the segment starts there. */
  markStart?: number;
}

/** Segment start = the most recent of: the age limit, a replay end, a previous K/R/M, or an M mark. */
export function segmentStart(now: number, b: RepeatBoundaries): number {
  const afterReplay = b.lastRunEnd ? b.lastRunEnd + REPLAY_TAIL_MS : 0;
  return Math.max(now - SEGMENT_MAX_AGE_MS, afterReplay, b.lastConsumed ?? 0, b.markStart ?? 0);
}

export interface RepeatSegment {
  window: { fromTs: number; toTs: number };
  candidate: MacroCandidate;
}

/** The latest idle-gap-bounded segment after `since`, if it is a usable routine. Never an older one. */
export function lastSegment(actions: ObservedAction[], since: number, now: number): RepeatSegment | null {
  const recent = refineSegment(actions.filter((a) => a.ts > since && a.ts <= now));
  const sessions = sessionize(recent, SEGMENT_GAP_MS);
  const last = sessions[sessions.length - 1];
  if (!last || !isUsableSession(last)) return null;
  const candidate = candidateFromSession(last);
  if (!candidate) return null;
  return { window: { fromTs: last[0]!.ts, toTs: last[last.length - 1]!.ts + 1 }, candidate };
}

export type RepeatPlan =
  | { via: 'segment'; segment: RepeatSegment }
  | { via: 'last-macro'; macro: Macro }
  | { via: 'none' };

/** Recent action first; otherwise the last-run macro; otherwise nothing. */
export function planRepeat(segment: RepeatSegment | null, macros: Macro[]): RepeatPlan {
  if (segment) return { via: 'segment', segment };
  const last = macros
    .filter((m) => m.id !== undefined && m.status !== 'never' && m.lastRunAt !== undefined)
    .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))[0];
  return last ? { via: 'last-macro', macro: last } : { via: 'none' };
}

/** Short names people say out loud, on top of `prettyDomain`. */
const SITE_ALIASES: Record<string, string> = { nytimes: 'NYT', wsj: 'WSJ', bbc: 'BBC', cnn: 'CNN' };

export function siteName(url: string): string {
  const pretty = appLabel(url);
  return SITE_ALIASES[pretty.toLowerCase()] ?? pretty;
}

/** "Open Wikipedia, NYT, GitHub": the auto-name for a macro that opens pages. Unique among `taken`. */
export function nameOpenMacro(urls: string[], taken: Set<string> = new Set()): string {
  const sites = [...new Set(urls.map(siteName))];
  const shown = sites.slice(0, NAME_MAX_SITES).join(', ');
  const base = `Open ${shown}${sites.length > NAME_MAX_SITES ? ` +${sites.length - NAME_MAX_SITES} more` : ''}` || 'Open pages';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
}

/** "Open Wikipedia → Open NYT → Open GitHub", capped, with "+N more". Only enabled open steps (clicks are opt-in). */
export function describeSteps(urls: string[]): { count: number; text: string } {
  const names = urls.map((u) => `Open ${siteName(u)}`);
  const shown = names.slice(0, PREVIEW_MAX_STEPS).join(' → ');
  const extra = names.length - PREVIEW_MAX_STEPS;
  return { count: names.length, text: extra > 0 ? `${shown} → +${extra} more` : shown };
}

export function previewText(plan: RepeatPlan): { runnable: boolean; text: string } {
  if (plan.via === 'none') {
    return { runnable: false, text: 'Nothing to repeat yet. Press K to keep what you do as a macro.' };
  }
  const urls =
    plan.via === 'segment'
      ? plan.segment.candidate.steps.filter((s) => s.kind === 'open_url' && s.enabled).map((s) => s.url)
      : plan.macro.steps.filter((s) => s.kind === 'open_url' && s.enabled).map((s) => s.url);
  const { count, text } = describeSteps(urls);
  const steps = `${count} step${count === 1 ? '' : 's'}`;
  return {
    runnable: true,
    text:
      plan.via === 'segment'
        ? `Repeat ${steps}: ${text}. Enter run & save · Esc cancel`
        : `No recent action. Repeat last macro "${plan.macro.name}" (${steps}: ${text})? Enter run · Esc cancel`,
  };
}
