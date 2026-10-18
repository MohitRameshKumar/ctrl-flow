/**
 * The authoritative tab list, rebuilt from CDP target events.
 *
 * This is where CDP's model (targets, frames, sessions) is translated into the `chrome.tabs` model
 * the rest of Cadence is written against. Kept free of any CDP *client* so the whole thing can be
 * unit-tested by feeding it recorded events.
 *
 * ## The fields that matter, and why
 *
 * - `status` — `lib/tabs.ts`'s `waitForTabComplete` both listens for an `onUpdated` with
 *   `status === 'complete'` *and* synchronously reads `tab.status` to avoid hanging on a tab that
 *   already finished. Getting this wrong makes every macro step wait out its full timeout, which
 *   presents as "macros are broken" rather than as a tracking bug.
 * - `title` — comes free from `Target.targetInfoChanged`, which fires on title *and* URL changes,
 *   even for targets we are not attached to. It ends up in `ObservedAction.title`, which is what
 *   macro naming uses, so polling `document.title` would be both slower and worse.
 * - `windowId` — `openUrlsAsGroup` creates tabs into a specific window and `focusTab` focuses one.
 * - `active` — there is **no CDP event for tab activation**. The injected collector reports
 *   `visibilitychange`, and exactly one tab per window is visible at a time, which is precisely
 *   Chrome's definition of the active tab. Verified against a real Chrome in the spike.
 */

export interface RegistryTab {
  id: number;
  targetId: string;
  index: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  status: 'loading' | 'complete';
  pinned: boolean;
  incognito: boolean;
  groupId: number;
  discarded?: boolean;
  frozen?: boolean;
}

export interface TargetInfo {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
}

export type RegistryEvent =
  | { kind: 'created'; tab: RegistryTab }
  | { kind: 'removed'; tabId: number; windowId: number }
  | { kind: 'updated'; tabId: number; changes: Partial<RegistryTab>; tab: RegistryTab }
  | { kind: 'activated'; tabId: number; windowId: number }
  | { kind: 'navigated'; tabId: number; url: string; spa: boolean };

/** Only page targets are tabs. Workers, iframes and extension pages are not. */
export function isTabTarget(info: TargetInfo): boolean {
  if (info.type !== 'page') return false;
  const url = info.url ?? '';
  return !url.startsWith('devtools://');
}

export class TabRegistry {
  private readonly byId = new Map<number, RegistryTab>();
  private readonly idByTarget = new Map<string, number>();
  private nextId = 1;

  /** Last tab reported visible per window, so phantom activations can be filtered out. */
  private readonly activeByWindow = new Map<number, number>();

  private readonly listeners = new Set<(event: RegistryEvent) => void>();

  subscribe(fn: (event: RegistryEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: RegistryEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch (err) {
        console.error('[cadence] registry listener threw', err);
      }
    }
  }

  all(): RegistryTab[] {
    return [...this.byId.values()];
  }

  get(tabId: number): RegistryTab | undefined {
    return this.byId.get(tabId);
  }

  byTarget(targetId: string): RegistryTab | undefined {
    const id = this.idByTarget.get(targetId);
    return id === undefined ? undefined : this.byId.get(id);
  }

  targetFor(tabId: number): string | undefined {
    return this.byId.get(tabId)?.targetId;
  }

  add(info: TargetInfo, windowId = 1): RegistryTab | null {
    if (!isTabTarget(info)) return null;
    const existing = this.byTarget(info.targetId);
    if (existing) return existing;

    const tab: RegistryTab = {
      id: this.nextId++,
      targetId: info.targetId,
      index: this.byId.size,
      windowId,
      url: info.url ?? '',
      title: info.title ?? '',
      active: false,
      // A brand new target has not finished loading; `loading` is the safe assumption because it
      // makes waitForTabComplete wait for a real signal rather than proceeding into a blank page.
      status: 'loading',
      pinned: false,
      incognito: false,
      groupId: -1,
    };

    this.byId.set(tab.id, tab);
    this.idByTarget.set(info.targetId, tab.id);
    this.emit({ kind: 'created', tab });
    return tab;
  }

  remove(targetId: string): void {
    const tab = this.byTarget(targetId);
    if (!tab) return;
    this.byId.delete(tab.id);
    this.idByTarget.delete(targetId);
    if (this.activeByWindow.get(tab.windowId) === tab.id) {
      this.activeByWindow.delete(tab.windowId);
    }
    this.emit({ kind: 'removed', tabId: tab.id, windowId: tab.windowId });
  }

  /** Applies a patch and emits `updated` with only the fields that actually changed. */
  update(tabId: number, patch: Partial<RegistryTab>): void {
    const tab = this.byId.get(tabId);
    if (!tab) return;

    const changes: Partial<RegistryTab> = {};
    for (const [key, value] of Object.entries(patch) as [keyof RegistryTab, never][]) {
      if (tab[key] === value) continue;
      changes[key] = value;
      tab[key] = value;
    }
    if (Object.keys(changes).length === 0) return;
    this.emit({ kind: 'updated', tabId, changes, tab });
  }

  updateByTarget(targetId: string, patch: Partial<RegistryTab>): void {
    const tab = this.byTarget(targetId);
    if (tab) this.update(tab.id, patch);
  }

  setWindow(targetId: string, windowId: number): void {
    this.updateByTarget(targetId, { windowId });
  }

  /**
   * A navigation, from `Page.frameNavigated` (hard) or `Page.navigatedWithinDocument` (in-page).
   *
   * The `spa` flag maps exactly onto the extension's two `webNavigation` listeners, and the
   * distinction is load-bearing for Leader R: `lib/macro-repeat.ts` drops SPA navigations unless a
   * click preceded them, which is what keeps a recorded segment from filling up with Gmail's or
   * Linear's internal route changes.
   */
  navigated(targetId: string, url: string, spa: boolean): void {
    const tab = this.byTarget(targetId);
    if (!tab) return;
    this.update(tab.id, { url, ...(spa ? {} : { status: 'loading' as const }) });
    this.emit({ kind: 'navigated', tabId: tab.id, url, spa });
  }

  /**
   * Records which tab is visible, from the injected `visibilitychange` reporter.
   *
   * Deduped per window. `visibilitychange` also fires on minimize and on occlusion, and an
   * un-deduped stream would feed phantom `tab_activated` events into Focus Flip learning, switch
   * detection, and space dwell times.
   */
  reportVisible(targetId: string, visible: boolean): void {
    const tab = this.byTarget(targetId);
    if (!tab) return;

    if (!visible) {
      if (tab.active) this.update(tab.id, { active: false });
      return;
    }

    if (this.activeByWindow.get(tab.windowId) === tab.id) {
      // Already known active — minimize/restore, not a real switch.
      if (!tab.active) this.update(tab.id, { active: true });
      return;
    }

    const previous = this.activeByWindow.get(tab.windowId);
    if (previous !== undefined && previous !== tab.id) {
      this.update(previous, { active: false });
    }
    this.activeByWindow.set(tab.windowId, tab.id);
    this.update(tab.id, { active: true });
    this.emit({ kind: 'activated', tabId: tab.id, windowId: tab.windowId });
  }

  /** Mirrors `chrome.tabs.query`'s filters, for the subset the codebase uses. */
  query(info: {
    active?: boolean;
    windowId?: number;
    url?: string | string[];
    currentWindow?: boolean;
  } = {}): RegistryTab[] {
    return this.all().filter((tab) => {
      if (info.active !== undefined && tab.active !== info.active) return false;
      if (info.windowId !== undefined && tab.windowId !== info.windowId) return false;
      return true;
    });
  }

  activeTabIn(windowId: number): RegistryTab | undefined {
    const id = this.activeByWindow.get(windowId);
    return id === undefined ? undefined : this.byId.get(id);
  }

  clear(): void {
    for (const tab of this.all()) {
      this.emit({ kind: 'removed', tabId: tab.id, windowId: tab.windowId });
    }
    this.byId.clear();
    this.idByTarget.clear();
    this.activeByWindow.clear();
  }
}
