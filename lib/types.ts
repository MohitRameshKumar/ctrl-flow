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
  | { type: 'typing_burst'; keyCount: number };

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

export interface NameSpacesInput {
  urls: AiUrlInput[];
}
export interface NameSpacesSpace {
  name: string;
  urls: string[];
}
export type NameSpacesOutput = NameSpacesSpace[];

export interface AssignTabsInput {
  urls: AiUrlInput[];
  existingSpaces: string[];
}
export interface AssignTabsAssignment {
  url: string;
  spaceName: string | null;
  newSpaceName: string | null;
}
export type AssignTabsOutput = AssignTabsAssignment[];
