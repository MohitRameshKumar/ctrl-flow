export type EventKind =
  | 'tab_activated'
  | 'tab_opened'
  | 'tab_closed'
  | 'navigated'
  | 'click'
  | 'field_changed'
  | 'typing_burst'
  | 'chrome_focus_lost'
  | 'chrome_focus_gained';

export interface CadenceEvent {
  id?: number;
  ts: number;
  kind: EventKind;
  tabId?: number;
  windowId?: number;
  url?: string;
  domain?: string;
  title?: string;
  selector?: string;
  label?: string;
  fieldName?: string;
  keyCount?: number;
  /** tab_activated caused by Cadence itself (restore, open ritual docs) rather than the user. Excluded from switch detection and co-usage. */
  programmatic?: boolean;
  /** Written by the debug page's "Simulate" action only; wiped by its one-click cleanup. */
  synthetic?: boolean;
  /** `navigated` from history.pushState / replaceState (in-page navigation), not a document load. */
  spa?: boolean;
}

/** Messages sent from the content script to the background worker. Never carries field/keystroke values. */
export type ContentMessage =
  | { type: 'click'; selector: string; label?: string; frameUrl?: string }
  | {
      type: 'field_changed';
      fieldName?: string;
      fieldType: string;
      autocomplete: string | null;
      frameUrl?: string;
    }
  | { type: 'typing_burst'; keyCount: number }
  /** Focus Flip only (and only while enabled): "something happened" pulses, throttled. Carry no positions, keys, or content. */
  | { type: 'activity'; what: 'key' | 'scroll' | 'click' }
  | { type: 'sensitive_focus'; value: boolean }
  /** Leader-key overlay (or the panel fallback) asking the background to run a letter / a search result. */
  | { type: 'leader_run'; letter: string }
  | { type: 'leader_run_item'; kind: 'space' | 'ritual' | 'macro'; id: number }
  /** Overlay answering the "Repeat N steps?" preview. */
  | { type: 'leader_repeat_confirm' }
  | { type: 'leader_repeat_cancel' };

/** A learned (writing tab, reference tab) pair for Focus Flip. Counts and durations only. */
export interface FlipPair {
  id?: number;
  writingUrl: string;
  referenceUrl: string;
  /** Timestamps of the most recent round trips (writing -> reference -> writing). */
  roundTripTs: number[];
  /** Last few ms spent on the reference tab per visit. */
  dwellSamples: number[];
  /** Last few ms between the last keystroke and leaving the writing tab. */
  pauseSamples: number[];
  active: boolean;
  updatedAt: number;
}

export interface BlocklistConfig {
  domains: string[];
  substrings: string[];
}

/** A single occurrence of a (possibly recurring) calendar meeting. */
export interface CalendarEvent {
  id: string;
  /** Google's recurringEventId, or the normalized title for demo events. Identifies the series. */
  seriesKey: string;
  title: string;
  start: number;
  end: number;
}

export type RitualStatus = 'suggested' | 'accepted' | 'auto' | 'never';

export interface RitualUrl {
  url: string;
  pageTitle?: string;
  /** How many of the last N occurrences this URL appeared in. */
  occurrences: number;
}

export interface Ritual {
  id?: number;
  seriesKey: string;
  title: string;
  urls: RitualUrl[];
  /** URLs the user explicitly removed; never re-added by a later recompute. */
  removedUrls: string[];
  status: RitualStatus;
  updatedAt: number;
}

/** 'auto_offline' is the domain-grouping fallback used when the AI call fails. */
export type SpaceStatus = 'ai' | 'auto_offline' | 'user';

export interface Space {
  id?: number;
  name: string;
  status: SpaceStatus;
  createdAt: number;
  updatedAt: number;
}

export type SpaceUrlSource = 'ai' | 'user';

export interface SpaceUrl {
  id?: number;
  spaceId: number;
  url: string;
  title?: string;
  source: SpaceUrlSource;
  alwaysOpen: boolean;
}

export interface ShelvedUrl {
  url: string;
  title?: string;
}

export interface Shelf {
  id?: number;
  spaceId: number;
  urls: ShelvedUrl[];
  createdAt: number;
}

/** Only what's ever sent to the AI proxy: normalized URL, domain, and page title. */
export interface AiUrlInput {
  url: string;
  title: string;
}

export type TaskName = 'name_spaces' | 'assign_tabs' | 'standup' | 'coverage_doc';

/** Co-usage between two tabs, as indices into the request's tab list. Counts only. */
export interface CoUsageEdge {
  a: number;
  b: number;
  /** Times the user switched directly between the two tabs (either direction). */
  switches: number;
  /** Times one was activated within the "near" window of the other (includes switches). */
  near: number;
}

/** Number of typing bursts (never content) seen in a tab, by index into the request's tab list. */
export interface TypedCount {
  i: number;
  bursts: number;
}

export interface NameSpacesInput {
  urls: AiUrlInput[];
  edges?: CoUsageEdge[];
  typed?: TypedCount[];
}
export interface NameSpacesSpace {
  name: string;
  urls: string[];
}
export type NameSpacesOutput = NameSpacesSpace[];

export interface AssignTabsContextUrl extends AiUrlInput {
  /** Name of the space this already-assigned tab belongs to. */
  space: string;
}

export interface AssignTabsInput {
  urls: AiUrlInput[];
  existingSpaces: string[];
  /** Already-assigned tabs that were co-used with the new ones; edge indices continue after `urls`. */
  context?: AssignTabsContextUrl[];
  edges?: CoUsageEdge[];
  typed?: TypedCount[];
}
export interface AssignTabsAssignment {
  url: string;
  spaceName: string | null;
  newSpaceName: string | null;
}
export type AssignTabsOutput = AssignTabsAssignment[];

/* ------------------------------------------------------------------ *
 * Repeat-to-Macro
 * ------------------------------------------------------------------ */

/**
 * What a macro step does when replayed.
 *
 * Only `open_url` and `click` are ever produced by detection — see `ObservedActionKind`. The rest
 * exist because a recorded routine is a program, not a bookmark folder: `focus_tab` carries the
 * order you actually looked at things, the waits make click replay survive slow apps, and `type`
 * is available to add by hand (never recorded, per the keystroke rule).
 */
export type MacroStepKind =
  | 'open_url'
  | 'focus_tab'
  | 'click'
  | 'type'
  | 'wait'
  | 'wait_for'
  | 'close_tabs';

/**
 * The subset a recorder can observe. Deliberately narrower than `MacroStepKind`: widening the
 * step vocabulary must not imply the collector suddenly emits waits or keystrokes.
 */
export type ObservedActionKind = 'open_url' | 'click';

/** Guided walks the flow visibly; silent does the same work without ever stealing focus. */
export type RunMode = 'guided' | 'silent';

/**
 * How long guided mode dwells on each step.
 *
 * Only meaningful in guided mode — silent mode has no audience, so it yields the minimum and
 * relies on `wait_for` for real readiness instead.
 */
export type RunSpeed = 'slow' | 'normal' | 'fast';
export type MacroStatus = 'suggested' | 'accepted' | 'auto' | 'never';
/** A desktop recorder would add 'desktop' here; nothing else in the detector changes. */
export type MacroSource = 'chrome';
export type MacroDetector = 'time_of_day' | 'sequence' | 'both';

/**
 * One observed user action, source-agnostic. The Chrome collector maps its events onto this
 * shape; a future desktop recorder would emit the same shape and the detectors would not change.
 */
export interface ObservedAction {
  ts: number;
  kind: ObservedActionKind;
  /** In-page (history API) navigation; Leader R ignores these unless the user clicked just before. */
  spa?: boolean;
  /** Opaque target identity: a normalized URL today; an app/window id for desktop later. */
  target: string;
  title?: string;
  /** click only */
  selector?: string;
  /** click only */
  label?: string;
  /** Groups actions on the same surface — a tabId today. */
  contextId?: number;
  /** The user brought this target up on purpose, rather than merely switching back to it. */
  deliberate: boolean;
}

export interface MacroStep {
  /** Stable identity for merge and user edits: `open:<url>` or `click:<url>|<selector>`. */
  key: string;
  kind: MacroStepKind;
  /** Normalized URL, or the page a click/type/wait_for happens on. Empty for wait/close_tabs. */
  url: string;
  title?: string;
  /** click, type, wait_for */
  selector?: string;
  /** click only */
  label?: string;
  /**
   * Text for a `type` step. Always supplied by the user in the step editor — the collector
   * records keystroke counts only and never their content, so this is never populated by
   * detection.
   */
  text?: string;
  /** `wait` only: how long to pause. */
  waitMs?: number;
  /**
   * Pacing before this step, derived from the real gap between the recorded actions and clamped.
   * Honored in guided mode; silent mode uses a flat floor instead.
   */
  delayBeforeMs?: number;
  /** Replay this step? open_url defaults true; click defaults false (experimental). */
  enabled: boolean;
  /** How many observed runs contained this step. */
  support: number;
}

/**
 * A part of a macro's URLs that varies run to run — the ticket number in `/pull/812`.
 *
 * Detection already folds these to `*` to find patterns at all (`canonForNgram`); a param is
 * that same wildcard promoted into something the user can fill in.
 */
export interface MacroParam {
  /** Identifier used in the template, e.g. `pull` in `/pull/{pull}`. */
  name: string;
  /** Concrete values seen while mining, most recent last. */
  examples: string[];
  /** Default offered at run time. */
  lastValue: string;
}

/** Counters that drive ranking, offer back-off, and auto-run promotion. All plain and auditable. */
export interface MacroStats {
  runs: number;
  successes: number;
  failures: number;
  /** Auto-runs the user cancelled during the grace countdown. One of these demotes the macro. */
  undos: number;
  offersShown: number;
  offersDismissed: number;
  /** Consecutive clean runs; promotion watches this, any failure or undo resets it. */
  cleanStreak: number;
}

/** What causes an `auto` macro to fire on its own. */
export interface MacroTrigger {
  kind: 'time_of_day' | 'in_progress';
  /** time_of_day only: local hour 0-23. */
  hour?: number;
}

/** A routine the detectors found, before it is reconciled against what is already stored. */
export interface MacroCandidate {
  steps: MacroStep[];
  /** Varying URL parts the detector found, if any. */
  params?: MacroParam[];
  detector: MacroDetector;
  /** Distinct runs the detector saw. */
  occurrences: number;
  /** Local hour 0-23 for time-of-day candidates; null for sequence-only ones. */
  typicalHour: number | null;
}

export type StepOutcomeStatus = 'ok' | 'skipped' | 'failed';

export interface StepOutcome {
  stepKey: string;
  status: StepOutcomeStatus;
  error?: string;
}

export interface MacroRunResult {
  startedAt: number;
  finishedAt: number;
  outcomes: StepOutcome[];
}

export interface ReplayOptions {
  mode: RunMode;
  /** Guided dwell length; ignored in silent mode. */
  speed?: RunSpeed;
  /** Values for the macro's params, keyed by `MacroParam.name`. */
  params?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Where a run is.
 *
 * `stopping` exists because Stop is honored at the next checkpoint, not instantly — a click
 * already in flight finishes. The UI should say "Stopping…" rather than imply otherwise.
 * `interrupted` means the service worker died mid-run; such a run is finalized, never resumed,
 * because a half-executed step is not safe to repeat.
 */
export type RunStatus =
  | 'countdown'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'done'
  | 'stopped'
  | 'interrupted';

/**
 * Live state of the one run that may be in flight, in `chrome.storage.session`.
 *
 * The single key doubles as the mutex: a second run is refused while this exists with a fresh
 * heartbeat. A stale heartbeat means the service worker was killed, and the next wake finalizes
 * the run as `interrupted`.
 */
export interface MacroRunState {
  runId: string;
  macroId: number;
  macroName: string;
  mode: RunMode;
  status: RunStatus;
  stepIndex: number;
  total: number;
  /** Human-readable note for the UI, e.g. 'Opening github.com'. */
  phase: string;
  /** Key of the step in flight, so a crashed run can say where it died. */
  cursorKey?: string;
  paused: boolean;
  startedAt: number;
  /** Bumped on every heartbeat; staleness here is how a dead worker is detected. */
  heartbeatAt: number;
  /** Tabs this run created, for `close_tabs` and for cleanup after a crash. */
  openedTabIds: number[];
  /** Resolved tabs by URL, so a later step acts on the tab an earlier one opened. */
  tabIdByUrl: Record<string, number>;
  outcomes: StepOutcome[];
  /** Terminal only. */
  summary?: string;
}

export type RunCommandName = 'pause' | 'resume' | 'stop' | 'skip';

/** Panel -> executor control message, also in `chrome.storage.session`. */
export interface MacroRunCommand {
  runId: string;
  command: RunCommandName;
  ts: number;
}

export interface Macro {
  id?: number;
  /** Content-derived and stable across recomputes, so a scan updates rather than forks a macro. */
  macroKey: string;
  name: string;
  /** Set once the user renames; recompute must not clobber the name after that. */
  nameIsUserSet: boolean;
  source: MacroSource;
  detector: MacroDetector;
  steps: MacroStep[];
  /** Step keys the user removed; never re-added by a later recompute. */
  removedStepKeys: string[];
  /** Step keys whose `enabled` the user set by hand; recompute must not clobber those. */
  pinnedStepKeys: string[];
  status: MacroStatus;
  occurrences: number;
  typicalHour: number | null;
  /**
   * Varying URL parts, if the detector found any. Optional because v1 rows predate it —
   * `withMacroDefaults` normalizes on read rather than migrating rows.
   */
  params?: MacroParam[];
  /** Optional for the same reason; read through `withMacroDefaults` to get a filled-in value. */
  stats?: MacroStats;
  trigger?: MacroTrigger;
  /** Cadence-side: if a page is already open, switch to it instead of opening a new tab. Default (unset) opens a new tab. */
  reuseOpenTabs?: boolean;
  lastRunAt?: number;
  lastRunResult?: MacroRunResult;
  createdAt: number;
  updatedAt: number;
}

/** One durable record per run, so the learning counters have something to be derived from. */
export interface MacroRunRecord {
  id?: number;
  macroId: number;
  mode: RunMode;
  startedAt: number;
  finishedAt: number;
  outcomes: StepOutcome[];
  clean: boolean;
}

/** A macro read back with every optional field filled in. What all logic should consume. */
export type NormalizedMacro = Macro & { params: MacroParam[]; stats: MacroStats };
