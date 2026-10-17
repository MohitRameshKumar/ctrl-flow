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
}

/** Messages sent from the content script to the background worker. Never carries field/keystroke values. */
export type ContentMessage =
  | { type: 'click'; selector: string; label?: string }
  | {
      type: 'field_changed';
      fieldName?: string;
      fieldType: string;
      autocomplete: string | null;
    }
  | { type: 'typing_burst'; keyCount: number }
  /** Focus Flip only (and only while enabled): "something happened" pulses, throttled. Carry no positions, keys, or content. */
  | { type: 'activity'; what: 'key' | 'scroll' | 'click' }
  | { type: 'sensitive_focus'; value: boolean }
  /** Leader-key overlay (or the panel fallback) asking the background to run a letter / a search result. */
  | { type: 'leader_run'; letter: string }
  | { type: 'leader_run_item'; kind: 'space' | 'ritual'; id: number };

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
