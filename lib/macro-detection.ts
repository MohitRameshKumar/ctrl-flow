/**
 * Macro detection. Pure — no `chrome.*`, no Dexie, no `import.meta`.
 *
 * Everything here operates on `ObservedAction[]`, which the Chrome collector produces today and
 * a desktop recorder could produce later. Keeping this file free of I/O is what makes it
 * directly unit-testable from Node, the same way `switch-detection.ts` is.
 */

import {
  MACRO_CLICK_SUPPORT,
  MACRO_HOUR_TOLERANCE,
  MACRO_MAX_CANDIDATES,
  MACRO_MAX_CLICKS_PER_URL,
  MACRO_MAX_SEQUENCE_CANDIDATES,
  MACRO_MAX_SESSION_ACTIONS,
  MACRO_MAXIMALITY_RATIO,
  MACRO_NGRAM_MAX,
  MACRO_NGRAM_MIN,
  MACRO_SIMILARITY,
  MACRO_URL_FLOOR,
} from './constants';
import type {
  CadenceEvent,
  Macro,
  MacroCandidate,
  MacroDetector,
  MacroParam,
  MacroStep,
  MacroStepKind,
  ObservedAction,
} from './types';

/* ---------------------------------------------------------------- *
 * Chrome event to ObservedAction
 * ---------------------------------------------------------------- */

/**
 * Maps one collected Chrome event onto the source-agnostic action shape, or null if the event
 * isn't replayable. Pure, so it is covered by the same Node tests as the detectors.
 *
 * `tab_activated` is included because returning to an open tab is a real part of a routine, but
 * it is marked non-deliberate: a session made only of activations is tab churn, not a routine.
 */
export function eventToAction(e: CadenceEvent): ObservedAction | null {
  if (!e.url) return null;
  // Cadence-side filters. `synthetic` is simulated data; `programmatic` is a switch Cadence itself
  // made (ritual docs, space restore, Focus Flip, macro replay). Neither is the user's behaviour,
  // so neither may be learned as a routine.
  if (e.synthetic || e.programmatic) return null;

  if (e.kind === 'click') {
    if (!e.selector) return null;
    return {
      ts: e.ts,
      kind: 'click',
      target: e.url,
      title: e.title,
      selector: e.selector,
      label: e.label,
      contextId: e.tabId,
      deliberate: true,
    };
  }

  if (e.kind === 'tab_opened' || e.kind === 'navigated' || e.kind === 'tab_activated') {
    return {
      ts: e.ts,
      kind: 'open_url',
      target: e.url,
      title: e.title,
      contextId: e.tabId,
      deliberate: e.kind !== 'tab_activated',
      ...(e.spa ? { spa: true } : {}),
    };
  }

  return null;
}

/* ---------------------------------------------------------------- *
 * Primitives
 * ---------------------------------------------------------------- */

/** Stable per-action identity. Two clicks on the same page differ only by selector. */
export function itemKey(a: ObservedAction): string {
  return a.kind === 'click' ? `click:${a.target}|${a.selector ?? ''}` : `open:${a.target}`;
}

/**
 * Key for a step the user added by hand.
 *
 * Detected steps derive their key from content, which is what lets a rescan recognize them.
 * Hand-authored steps cannot do that — two `wait 500ms` steps would collide, and because
 * `removedStepKeys` and `pinnedStepKeys` are keyed on this, a collision would make editing one
 * silently affect the other. So these get a minted key instead.
 */
export function mintStepKey(kind: MacroStepKind): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${kind}:~${Date.now().toString(36)}${suffix}`;
}

/**
 * Fills in `delayBeforeMs` from how long the user actually waited between these actions.
 *
 * Uses the median gap across every supporting session so one slow morning does not define the
 * rhythm, and leaves the value off entirely when there is nothing to learn from — the executor
 * falls back to its own floor in that case.
 */
export function applyPacing(steps: MacroStep[], sessions: ObservedAction[][]): MacroStep[] {
  const gaps = new Map<string, number[]>();

  for (const session of sessions) {
    for (let i = 1; i < session.length; i++) {
      const current = session[i];
      const previous = session[i - 1];
      if (!current || !previous) continue;
      const gap = current.ts - previous.ts;
      if (gap <= 0) continue;
      const key = itemKey(current);
      const list = gaps.get(key) ?? [];
      list.push(gap);
      gaps.set(key, list);
    }
  }

  return steps.map((step) => {
    const observed = gaps.get(step.key);
    if (!observed || observed.length === 0) return step;
    return { ...step, delayBeforeMs: Math.round(median(observed)) };
  });
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Local calendar day, used to count distinct runs rather than repeats within one day. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Hours are circular: 23:00 and 00:00 are one hour apart, not twenty-three. */
function hourDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 24 - d);
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? 0;
}

export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function openUrlSet(steps: MacroStep[]): Set<string> {
  return new Set(steps.filter((s) => s.kind === 'open_url').map((s) => s.url));
}

function openStepFrom(a: ObservedAction, support: number): MacroStep {
  return { key: itemKey(a), kind: 'open_url', url: a.target, title: a.title, enabled: true, support };
}

function clickStepFrom(a: ObservedAction, support: number): MacroStep {
  return {
    key: itemKey(a),
    kind: 'click',
    url: a.target,
    title: a.title,
    selector: a.selector,
    label: a.label,
    // Clicks are the unreliable half of replay, so the user opts in per step.
    enabled: false,
    support,
  };
}

/**
 * Folds volatile path segments so per-record URLs collide: `/pull/812` and `/pull/904` become
 * one item. Without this, detector B finds nothing on real GitHub/Linear/Jira data, because no
 * concrete ticket URL is ever visited three times.
 */
export function canonForNgram(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((segment) =>
        // A `{name}` placeholder folds to the same wildcard as the concrete values it stands
        // for, so a parameterized macro still recognizes itself when the user opens the next
        // ticket — without this, mid-flow matching would miss exactly the routines that matter
        // most. The brace form survives `encodeURIComponent` in a stored template.
        /^\d+$/.test(segment) ||
        /^[0-9a-f]{8,}$/i.test(segment) ||
        /^(\{[^}]+\}|%7B[^%]*%7D)$/i.test(segment)
          ? '*'
          : segment,
      )
      .join('/');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return url;
  }
}

/* ---------------------------------------------------------------- *
 * Sessionization
 * ---------------------------------------------------------------- */

/**
 * Splits a flat action log into sessions on an idle gap. Consecutive duplicate items are
 * collapsed (tab_activated churn and SPA re-navigations produce long runs of the same URL) and
 * each session is capped, which bounds the n-gram enumeration below.
 */
export function sessionize(actions: ObservedAction[], gapMs: number): ObservedAction[][] {
  const sorted = [...actions].sort((a, b) => a.ts - b.ts);
  const sessions: ObservedAction[][] = [];
  let current: ObservedAction[] = [];
  let lastTs: number | null = null;
  let lastKey: string | null = null;

  for (const action of sorted) {
    if (lastTs !== null && action.ts - lastTs > gapMs) {
      if (current.length > 0) sessions.push(current);
      current = [];
      lastKey = null;
    }
    lastTs = action.ts;

    const key = itemKey(action);
    if (key === lastKey) continue;
    lastKey = key;

    if (current.length >= MACRO_MAX_SESSION_ACTIONS) continue;
    current.push(action);
  }

  if (current.length > 0) sessions.push(current);
  return sessions;
}

/**
 * A session is worth mining only if the user actually went somewhere on purpose and touched more
 * than one page. This is the main defence against suggesting noise.
 */
export function isUsableSession(session: ObservedAction[]): boolean {
  if (!session.some((a) => a.deliberate)) return false;
  const opens = new Set(session.filter((a) => a.kind === 'open_url').map((a) => a.target));
  return opens.size >= 2;
}

/** Rejects candidates that are technically repeated but too thin to be a useful macro. */
export function isUsableCandidate(candidate: MacroCandidate): boolean {
  const urls = openUrlSet(candidate.steps);
  if (urls.size < 2) return false;

  const domains = new Set<string>();
  for (const url of urls) {
    const domain = domainOf(url);
    if (domain) domains.add(domain);
  }
  return domains.size >= 2 || urls.size >= 3;
}

/* ---------------------------------------------------------------- *
 * Click attachment
 * ---------------------------------------------------------------- */

/**
 * Adds the clicks a user reliably makes on a macro's pages.
 *
 * Clicks are deliberately kept out of both detectors' alphabets. The collector records every
 * click on every page and `e.target` is the deepest node under the cursor, so an alphabet that
 * included clicks would be mostly anonymous `<span>`s and the support counts would stop meaning
 * anything. Attaching clicks after the fact keeps detection honest and still surfaces them for
 * the user to opt into.
 */
export function attachClicks(
  openSteps: MacroStep[],
  supportingSessions: ObservedAction[][],
): MacroStep[] {
  if (supportingSessions.length === 0) return openSteps;

  const floor = Math.max(1, Math.ceil(MACRO_CLICK_SUPPORT * supportingSessions.length));
  const hits = new Map<string, { count: number; action: ObservedAction }>();

  for (const session of supportingSessions) {
    const seenInSession = new Set<string>();
    for (const action of session) {
      if (action.kind !== 'click') continue;
      const key = itemKey(action);
      if (seenInSession.has(key)) continue;
      seenInSession.add(key);
      const entry = hits.get(key) ?? { count: 0, action };
      entry.count++;
      hits.set(key, entry);
    }
  }

  const byUrl = new Map<string, { count: number; action: ObservedAction }[]>();
  for (const entry of hits.values()) {
    if (entry.count < floor) continue;
    const list = byUrl.get(entry.action.target) ?? [];
    list.push(entry);
    byUrl.set(entry.action.target, list);
  }

  const out: MacroStep[] = [];
  for (const step of openSteps) {
    out.push(step);
    const clicks = byUrl.get(step.url);
    if (!clicks) continue;
    for (const entry of clicks.sort((a, b) => b.count - a.count).slice(0, MACRO_MAX_CLICKS_PER_URL)) {
      out.push(clickStepFrom(entry.action, entry.count));
    }
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * Detector A: recurring URL set by time of day
 * ---------------------------------------------------------------- */

interface SessionSummary {
  hour: number;
  day: string;
  urls: Set<string>;
  /** First position of each open URL in the session, for median ordering. */
  positions: Map<string, number>;
  actionByUrl: Map<string, ObservedAction>;
  actions: ObservedAction[];
}

function summarize(session: ObservedAction[]): SessionSummary | null {
  const first = session[0];
  if (!first) return null;

  const positions = new Map<string, number>();
  const actionByUrl = new Map<string, ObservedAction>();
  const urls = new Set<string>();

  session.forEach((action, index) => {
    if (action.kind !== 'open_url') return;
    if (!positions.has(action.target)) positions.set(action.target, index);
    if (!actionByUrl.has(action.target)) actionByUrl.set(action.target, action);
    urls.add(action.target);
  });

  return {
    hour: new Date(first.ts).getHours(),
    day: localDayKey(first.ts),
    urls,
    positions,
    actionByUrl,
    actions: session,
  };
}

/**
 * Finds routines that recur at roughly the same time of day. This generalizes the Pre-Meeting
 * Ritual's "2 of the last 3 occurrences" rule: group similar sessions, then keep the URLs that
 * show up in most of them.
 */
export function detectByTimeOfDay(sessions: ObservedAction[][], minRuns: number): MacroCandidate[] {
  const summaries = sessions.map(summarize).filter((s): s is SessionSummary => s !== null);

  const used = new Set<number>();
  const candidates: MacroCandidate[] = [];

  for (let i = 0; i < summaries.length; i++) {
    if (used.has(i)) continue;
    const seed = summaries[i]!;
    const group: SessionSummary[] = [seed];
    used.add(i);

    for (let j = i + 1; j < summaries.length; j++) {
      if (used.has(j)) continue;
      const other = summaries[j]!;
      if (hourDistance(seed.hour, other.hour) > MACRO_HOUR_TOLERANCE) continue;
      if (jaccard(seed.urls, other.urls) < MACRO_SIMILARITY) continue;
      group.push(other);
      used.add(j);
    }

    const days = new Set(group.map((g) => g.day));
    if (days.size < minRuns) continue;

    const floor = Math.ceil(MACRO_URL_FLOOR * group.length);
    const hits = new Map<string, { count: number; positions: number[]; action: ObservedAction }>();

    for (const summary of group) {
      for (const [url, position] of summary.positions) {
        const action = summary.actionByUrl.get(url);
        if (!action) continue;
        const entry = hits.get(url) ?? { count: 0, positions: [], action };
        entry.count++;
        entry.positions.push(position);
        hits.set(url, entry);
      }
    }

    const openSteps = [...hits.values()]
      .filter((v) => v.count >= floor)
      .sort((a, b) => median(a.positions) - median(b.positions))
      .map((v) => openStepFrom(v.action, v.count));

    if (openSteps.length < 2) continue;

    candidates.push({
      steps: applyPacing(attachClicks(openSteps, group.map((g) => g.actions)), group.map((g) => g.actions)),
      detector: 'time_of_day',
      occurrences: days.size,
      typicalHour: median(group.map((g) => g.hour)),
    });
  }

  return candidates;
}

/* ---------------------------------------------------------------- *
 * Detector B: repeated ordered sequences
 * ---------------------------------------------------------------- */

function containsSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

interface GramEntry {
  items: string[];
  sessions: Set<number>;
  days: Set<string>;
}

/**
 * Mines contiguous n-grams of open-URL visits that recur across sessions. Catches
 * order-sensitive routines that don't happen at a fixed time of day.
 *
 * Support counts *distinct sessions*, not raw occurrences, so one session that loops a pattern
 * three times cannot manufacture a macro on its own.
 */
export function detectBySequence(
  sessions: ObservedAction[][],
  minRuns: number,
  minDays: number,
): MacroCandidate[] {
  /** canon URL -> the most recent concrete URL and its action, so replay opens a real page. */
  const concrete = new Map<string, ObservedAction>();
  const sequences: string[][] = [];
  const dayOfSession: string[] = [];

  sessions.forEach((session) => {
    const sequence: string[] = [];
    let lastCanon: string | null = null;
    for (const action of session) {
      if (action.kind !== 'open_url') continue;
      const canon = canonForNgram(action.target);
      const previous = concrete.get(canon);
      if (!previous || action.ts >= previous.ts) concrete.set(canon, action);
      if (canon === lastCanon) continue;
      lastCanon = canon;
      sequence.push(canon);
    }
    sequences.push(sequence);
    dayOfSession.push(localDayKey(session[0]?.ts ?? 0));
  });

  const grams = new Map<string, GramEntry>();

  sequences.forEach((sequence, sessionIndex) => {
    const seenInSession = new Set<string>();
    for (let n = MACRO_NGRAM_MIN; n <= MACRO_NGRAM_MAX; n++) {
      for (let i = 0; i + n <= sequence.length; i++) {
        const items = sequence.slice(i, i + n);
        const gramKey = items.join(' ');
        if (seenInSession.has(gramKey)) continue;
        seenInSession.add(gramKey);
        const entry = grams.get(gramKey) ?? { items, sessions: new Set(), days: new Set() };
        entry.sessions.add(sessionIndex);
        entry.days.add(dayOfSession[sessionIndex] ?? '');
        grams.set(gramKey, entry);
      }
    }
  });

  const kept = [...grams.values()].filter(
    (v) =>
      v.sessions.size >= minRuns &&
      v.days.size >= minDays &&
      new Set(v.items).size >= 2,
  );

  // Keep only maximal grams: a longer gram that retains most of a shorter one's support carries
  // strictly more information, so the shorter one would just clutter the suggestions.
  const maximal = kept.filter(
    (v) =>
      !kept.some(
        (other) =>
          other !== v &&
          other.items.length > v.items.length &&
          other.sessions.size >= v.sessions.size * MACRO_MAXIMALITY_RATIO &&
          containsSubsequence(other.items, v.items),
      ),
  );

  return maximal
    .sort((a, b) => b.sessions.size * b.items.length - a.sessions.size * a.items.length)
    .slice(0, MACRO_MAX_SEQUENCE_CANDIDATES)
    .map((v) => {
      const openSteps = v.items
        .map((canon) => concrete.get(canon))
        .filter((a): a is ObservedAction => a !== undefined)
        .map((a) => openStepFrom(a, v.sessions.size));
      const supporting = [...v.sessions].map((i) => sessions[i]!).filter(Boolean);
      const paced = applyPacing(attachClicks(openSteps, supporting), supporting);
      const { steps, params } = deriveParams(paced, supporting);
      return {
        steps,
        params,
        detector: 'sequence' as MacroDetector,
        occurrences: v.sessions.size,
        typicalHour: null,
      };
    })
    .filter((c) => openUrlSet(c.steps).size >= 2);
}

/* ---------------------------------------------------------------- *
 * In-progress matching
 * ---------------------------------------------------------------- */

export interface InProgressMatch<M extends Macro = Macro> {
  macro: M;
  /** How many leading steps of the macro the user has already done. */
  matched: number;
  /** Steps still to go — what an offer would actually run. */
  remaining: MacroStep[];
}

export interface InProgressOptions {
  /** Steps that must already line up before offering. */
  minMatch: number;
  /** Normalized URLs currently open, so finished work is not offered back. */
  openUrls: Set<string>;
}

/**
 * Spots that the user is partway through a macro they already have.
 *
 * Compares canonically, so a routine recognizes itself on a different ticket, and matches as a
 * *subsequence* rather than a contiguous block — real work has detours in it, and requiring an
 * exact prefix would mean the offer almost never fires.
 *
 * Pure: the caller gathers recent actions and open tabs, exactly like `detectSwitchCandidate`.
 */
export function matchInProgress<M extends Macro>(
  recent: ObservedAction[],
  macros: M[],
  opts: InProgressOptions,
): InProgressMatch<M> | null {
  const visited = recent
    .filter((a) => a.kind === 'open_url')
    .map((a) => canonForNgram(a.target));
  if (visited.length === 0) return null;

  let best: InProgressMatch<M> | null = null;

  for (const macro of macros) {
    if (macro.status !== 'accepted' && macro.status !== 'auto') continue;

    const openSteps = macro.steps.filter((s) => s.enabled && s.kind === 'open_url');
    if (openSteps.length < opts.minMatch + 1) continue;

    // Walk the macro's steps against the visited sequence, allowing gaps in the visits.
    let cursor = 0;
    let matched = 0;
    for (const step of openSteps) {
      const target = canonForNgram(step.url);
      const found = visited.indexOf(target, cursor);
      if (found === -1) break;
      cursor = found + 1;
      matched++;
    }

    if (matched < opts.minMatch) continue;

    const remaining = macro.steps
      .slice(macro.steps.indexOf(openSteps[matched - 1]!) + 1)
      .filter((s) => s.enabled);
    // Everything left is already on screen, so there is nothing useful to offer.
    const remainingOpens = remaining.filter((s) => s.kind === 'open_url');
    if (remainingOpens.length === 0) continue;
    if (remainingOpens.every((s) => opts.openUrls.has(s.url))) continue;

    const candidate: InProgressMatch<M> = { macro, matched, remaining };
    // Prefer the macro the user is furthest into; break ties toward the shorter routine, which
    // is the more specific claim about what they are doing.
    if (
      !best ||
      matched > best.matched ||
      (matched === best.matched && macro.steps.length < best.macro.steps.length)
    ) {
      best = candidate;
    }
  }

  return best;
}

/* ---------------------------------------------------------------- *
 * Parameters
 * ---------------------------------------------------------------- */

const PARAM_TOKEN = /\{([a-zA-Z][\w-]*)\}/g;

export function isTemplateUrl(url: string): boolean {
  PARAM_TOKEN.lastIndex = 0;
  return PARAM_TOKEN.test(url);
}

/** `pull` from `/pull/812`; falls back to `id` when the preceding segment is unusable. */
function paramBaseFor(segments: string[], index: number): string {
  const previous = segments[index - 1] ?? '';
  const cleaned = previous.replace(/[^a-zA-Z0-9_-]/g, '');
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : 'id';
}

/** Makes `base` unique against names already handed out, as `pull`, `pull2`, `pull3`. */
function uniqueParamName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * Identifies "this is the same variable as one we already named".
 *
 * A PR routine visits `/pull/812` and then `/pull/812/files`. Both vary at a position preceded
 * by `pull`, over an identical set of observed values — they are one ticket number, not two, and
 * numbering the second `pull2` would make the run form demand the same value twice. Keying on
 * the value set as well as the name keeps genuinely distinct ids apart.
 */
function paramSignature(base: string, values: Set<string>): string {
  return `${base}|${[...values].sort().join(',')}`;
}

/**
 * Turns the wildcards the n-gram miner already folds into named parameters.
 *
 * `canonForNgram` collapses `/pull/812` and `/pull/904` so a pattern can be found at all. That
 * collapse is thrown away afterwards and the step keeps one arbitrary concrete URL — so the
 * macro reopens whichever ticket happened to be most recent. Promoting the wildcard turns
 * "open these three fixed pages" into "do this for item N", and as a side effect gives the step
 * a key that is stable across tickets instead of changing every time a new one is visited.
 *
 * A wildcard only becomes a parameter if at least two different values were actually observed
 * there; one value means it is simply part of the path.
 */
export function deriveParams(
  steps: MacroStep[],
  sessions: ObservedAction[][],
): { steps: MacroStep[]; params: MacroParam[] } {
  const observedByCanon = new Map<string, ObservedAction[]>();
  for (const session of sessions) {
    for (const action of session) {
      if (action.kind !== 'open_url') continue;
      const canon = canonForNgram(action.target);
      const list = observedByCanon.get(canon) ?? [];
      list.push(action);
      observedByCanon.set(canon, list);
    }
  }

  const params: MacroParam[] = [];
  const taken = new Set<string>();
  /** Lets a variable reappearing on a later page of the routine reuse its existing name. */
  const bySignature = new Map<string, MacroParam>();
  /** Concrete URL -> template, so clicks on a page follow the page's own rewrite. */
  const templateByUrl = new Map<string, string>();

  for (const step of steps) {
    if (step.kind !== 'open_url') continue;

    const canon = canonForNgram(step.url);
    const observed = observedByCanon.get(canon) ?? [];
    if (observed.length === 0) continue;

    let parsed: URL;
    try {
      parsed = new URL(step.url);
    } catch {
      continue;
    }

    const canonSegments = new URL(canon).pathname.split('/');
    const segments = parsed.pathname.split('/');
    let changed = false;

    for (let i = 0; i < canonSegments.length; i++) {
      if (canonSegments[i] !== '*') continue;

      const values = new Set<string>();
      let latest = '';
      let latestTs = -1;
      for (const action of observed) {
        try {
          const value = new URL(action.target).pathname.split('/')[i];
          if (value === undefined) continue;
          values.add(value);
          if (action.ts > latestTs) {
            latestTs = action.ts;
            latest = value;
          }
        } catch {
          /* unparseable observation, skip */
        }
      }

      // One observed value is not a variable, it is just part of the path.
      if (values.size < 2) continue;

      const base = paramBaseFor(segments, i);
      const signature = paramSignature(base, values);
      const existing = bySignature.get(signature);

      if (existing) {
        // Same variable seen on a second page of the routine; reuse it rather than minting
        // `pull2`, so the run form asks for the ticket once.
        segments[i] = `{${existing.name}}`;
        changed = true;
        continue;
      }

      const name = uniqueParamName(base, taken);
      segments[i] = `{${name}}`;
      changed = true;
      const param: MacroParam = {
        name,
        examples: [...values].slice(0, 5),
        lastValue: latest,
      };
      bySignature.set(signature, param);
      params.push(param);
    }

    if (!changed) continue;
    // Assembled by hand rather than through `parsed.toString()`: the URL pathname setter
    // percent-encodes braces, which would turn `{pull}` into `%7Bpull%7D`.
    templateByUrl.set(
      step.url,
      `${parsed.origin}${segments.join('/')}${parsed.search}${parsed.hash}`,
    );
  }

  if (templateByUrl.size === 0) return { steps, params: [] };

  const rewritten = steps.map((step) => {
    const template = templateByUrl.get(step.url);
    if (!template) return step;
    const prefix = step.kind === 'open_url' ? 'open' : step.kind;
    const key =
      step.kind === 'open_url' ? `open:${template}` : `${prefix}:${template}|${step.selector ?? ''}`;
    return { ...step, url: template, key };
  });

  return { steps: rewritten, params };
}

/**
 * Substitutes parameter values into every step URL.
 *
 * Pure, and falls back to each parameter's last observed value, so a macro is always runnable
 * even when nothing was supplied. Step keys are identity and are deliberately left untouched —
 * outcomes must still line up with the stored steps.
 */
export function applyParams(macro: Macro, values: Record<string, string> = {}): Macro {
  const params = macro.params ?? [];
  if (params.length === 0) return macro;

  const resolved = new Map<string, string>();
  for (const param of params) {
    const supplied = values[param.name]?.trim();
    resolved.set(param.name, supplied || param.lastValue);
  }

  const substitute = (url: string): string =>
    url.replace(PARAM_TOKEN, (match, name: string) => {
      const value = resolved.get(name);
      return value === undefined ? match : encodeURIComponent(value);
    });

  return {
    ...macro,
    steps: macro.steps.map((step) =>
      isTemplateUrl(step.url) ? { ...step, url: substitute(step.url) } : step,
    ),
  };
}

/** Names a parameterized macro: "Review pull {pull}" reads better than a bare domain list. */
export function describeParams(params: MacroParam[]): string {
  if (params.length === 0) return '';
  return params.map((p) => `{${p.name}}`).join(' ');
}

/* ---------------------------------------------------------------- *
 * Union
 * ---------------------------------------------------------------- */

function mergeCandidates(target: MacroCandidate, incoming: MacroCandidate): MacroCandidate {
  // Detector A only guesses at order from median positions, so a sequence candidate's ordering
  // always wins: it is the only explicitly-ordered evidence.
  const orderSource =
    incoming.detector === 'sequence' && target.detector !== 'sequence' ? incoming : target;
  const other = orderSource === target ? incoming : target;

  const steps: MacroStep[] = orderSource.steps.map((s) => ({ ...s }));
  const seen = new Set(steps.map((s) => s.key));
  for (const step of other.steps) {
    if (seen.has(step.key)) continue;
    seen.add(step.key);
    steps.push({ ...step });
  }

  return {
    steps,
    detector: target.detector === incoming.detector ? target.detector : 'both',
    occurrences: Math.max(target.occurrences, incoming.occurrences),
    typicalHour: target.typicalHour ?? incoming.typicalHour,
  };
}

function score(candidate: MacroCandidate): number {
  return candidate.occurrences * openUrlSet(candidate.steps).size;
}

/**
 * Folds both detectors' output into one list. Candidates whose open-URL sets overlap enough are
 * the same routine seen two ways, so they merge rather than appearing twice.
 */
export function unionCandidates(candidates: MacroCandidate[]): MacroCandidate[] {
  const out: MacroCandidate[] = [];

  for (const candidate of candidates) {
    if (!isUsableCandidate(candidate)) continue;
    const urls = openUrlSet(candidate.steps);
    const index = out.findIndex((o) => jaccard(openUrlSet(o.steps), urls) >= MACRO_SIMILARITY);
    if (index === -1) {
      out.push({ ...candidate, steps: candidate.steps.map((s) => ({ ...s })) });
      continue;
    }
    out[index] = mergeCandidates(out[index]!, candidate);
  }

  return out.sort((a, b) => score(b) - score(a)).slice(0, MACRO_MAX_CANDIDATES);
}

/* ---------------------------------------------------------------- *
 * Identity and merge
 * ---------------------------------------------------------------- */

export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function mintMacroKey(candidate: MacroCandidate): string {
  return `m:${fnv1a([...openUrlSet(candidate.steps)].sort().join('|'))}`;
}

/**
 * Finds the stored macro this candidate is an update of.
 *
 * Matching on set similarity rather than on an exact content hash is what stops a scan that
 * discovers one extra URL from minting a new key and forking a duplicate row, silently losing
 * the user's status and step edits. The caller keeps the matched macro's existing `macroKey`.
 */
export function matchExistingMacro(existing: Macro[], candidate: MacroCandidate): Macro | null {
  const urls = openUrlSet(candidate.steps);
  let best: { macro: Macro; score: number } | null = null;

  for (const macro of existing) {
    const similarity = jaccard(openUrlSet(macro.steps), urls);
    if (similarity < MACRO_SIMILARITY) continue;
    if (!best || similarity > best.score) best = { macro, score: similarity };
  }

  return best?.macro ?? null;
}

/**
 * Reconciles a fresh candidate against what is stored. Pure, which is what makes the user-edit
 * contract testable without Dexie.
 *
 * The contract, same as `mergeRitual`: a recompute never resurrects a removed step, never
 * clobbers `status`, never overwrites a name the user set, and never flips an `enabled` the user
 * set by hand.
 */
export function applyCandidate(
  existing: Macro | null,
  candidate: MacroCandidate,
  name: string,
  macroKey: string,
  now: number,
): Macro {
  if (!existing) {
    return {
      macroKey,
      name,
      nameIsUserSet: false,
      source: 'chrome',
      detector: candidate.detector,
      steps: candidate.steps.map((s) => ({ ...s })),
      removedStepKeys: [],
      pinnedStepKeys: [],
      status: 'suggested',
      occurrences: candidate.occurrences,
      typicalHour: candidate.typicalHour,
      params: candidate.params ?? [],
      createdAt: now,
      updatedAt: now,
    };
  }

  const removed = new Set(existing.removedStepKeys);
  const pinned = new Set(existing.pinnedStepKeys);
  const previousEnabled = new Map(existing.steps.map((s) => [s.key, s.enabled]));
  const previousOrder = new Map(existing.steps.map((s, i) => [s.key, i]));

  const steps = candidate.steps
    .filter((s) => !removed.has(s.key))
    .map((s) => ({
      ...s,
      enabled: pinned.has(s.key) ? previousEnabled.get(s.key) ?? s.enabled : s.enabled,
    }));

  // A step the user deliberately switched on must survive a scan that happens not to see it,
  // otherwise enabling a click step would silently undo itself.
  const seen = new Set(steps.map((s) => s.key));
  for (const step of existing.steps) {
    if (seen.has(step.key) || removed.has(step.key) || !pinned.has(step.key)) continue;
    steps.push({ ...step });
  }

  // Respect an order the user arranged by hand; steps they have never seen go to the end.
  steps.sort(
    (a, b) =>
      (previousOrder.get(a.key) ?? Number.POSITIVE_INFINITY) -
      (previousOrder.get(b.key) ?? Number.POSITIVE_INFINITY),
  );

  return {
    ...existing,
    name: existing.nameIsUserSet ? existing.name : name,
    detector: existing.detector === candidate.detector ? existing.detector : 'both',
    steps,
    occurrences: Math.max(existing.occurrences, candidate.occurrences),
    typicalHour: candidate.typicalHour ?? existing.typicalHour,
    // A rescan refreshes each parameter's default to the most recently seen value, but never
    // forgets a parameter the user already has.
    params: mergeParams(existing.params ?? [], candidate.params ?? []),
    updatedAt: now,
  };
}

function mergeParams(existing: MacroParam[], incoming: MacroParam[]): MacroParam[] {
  const byName = new Map(existing.map((p) => [p.name, p]));
  for (const param of incoming) {
    byName.set(param.name, param);
  }
  return [...byName.values()];
}

/** Turns an ad-hoc recording into a candidate, reusing the same pipeline the detectors feed. */
export function candidateFromSession(session: ObservedAction[]): MacroCandidate | null {
  const seen = new Set<string>();
  const openSteps: MacroStep[] = [];

  for (const action of session) {
    if (action.kind !== 'open_url') continue;
    const key = itemKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    openSteps.push(openStepFrom(action, 1));
  }

  if (openSteps.length < 2) return null;
  return {
    steps: applyPacing(attachClicks(openSteps, [session]), [session]),
    detector: 'sequence',
    occurrences: 1,
    typicalHour: null,
  };
}

/* ---------------------------------------------------------------- *
 * Naming
 * ---------------------------------------------------------------- */

const BRAND_BY_HOST: Record<string, string> = {
  'docs.google.com': 'Google Docs',
  'drive.google.com': 'Google Drive',
  'mail.google.com': 'Gmail',
  'calendar.google.com': 'Google Calendar',
  'meet.google.com': 'Google Meet',
  'sheets.google.com': 'Google Sheets',
};

const BRAND_BY_LABEL: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  stackoverflow: 'Stack Overflow',
  atlassian: 'Jira',
  instructure: 'Canvas',
  openai: 'OpenAI',
  npmjs: 'npm',
};

export function prettyDomain(host: string): string {
  const h = host.replace(/^www\./, '').toLowerCase();
  const exact = BRAND_BY_HOST[h];
  if (exact) return exact;

  const labels = h.split('.');
  const label = (labels.length > 2 ? labels[labels.length - 2] : labels[0]) ?? h;
  return BRAND_BY_LABEL[label] ?? label.charAt(0).toUpperCase() + label.slice(1);
}

export function hourBucket(hour: number): string {
  if (hour < 11) return 'Morning';
  if (hour < 14) return 'Midday';
  if (hour < 18) return 'Afternoon';
  return 'Evening';
}

/**
 * Names a macro locally from its domains and typical hour. Deliberately offline: the AI proxy
 * must not be a dependency of a feature that has to work during a demo.
 */
export function nameMacro(candidate: MacroCandidate, fallbackIndex: number, taken?: Set<string>): string {
  const counts = new Map<string, number>();
  for (const step of candidate.steps) {
    if (step.kind !== 'open_url') continue;
    const domain = domainOf(step.url);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }

  const pretty = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => prettyDomain(d));
  const unique = [...new Set(pretty)];

  let base: string;
  if (unique.length === 0) base = `Routine ${fallbackIndex + 1}`;
  else if (unique.length === 1) base = `${unique[0]} routine`;
  else if (unique.length <= 3) base = unique.slice(0, 2).join(' + ');
  else base = `${unique[0]} + ${unique[1]} +${unique.length - 2} more`;

  if (unique.length > 0 && candidate.typicalHour !== null) {
    base = `${hourBucket(candidate.typicalHour)} ${base}`;
  }

  if (!taken || !taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base} ${n}`;
    if (!taken.has(next)) return next;
  }
}
