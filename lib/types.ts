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
