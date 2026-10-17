import { setDemoCalendarEvents } from './calendar';
import { db } from './db';
import { getLastAiRequest } from './ai';
import { setFocusProbeForTests } from './focus-flip';
import { canHostOverlay } from './hotkeys';
import { handleLeaderCommand } from './leader';
import { routeNotificationButtonClicked } from './notifications';
import type { CadenceEvent, CalendarEvent } from './types';

const TABLE_NAMES = ['events', 'rituals', 'spaces', 'spaceUrls', 'shelves', 'flipPairs'] as const;
type TableName = (typeof TABLE_NAMES)[number];

export interface CadenceTestHooks {
  readTable(name: TableName): Promise<unknown[]>;
  clearTable(name: TableName): Promise<void>;
  clearAllTables(): Promise<void>;
  seedTable(name: TableName, rows: unknown[]): Promise<void>;
  triggerLeader(): Promise<'overlay' | 'panel'>;
  setFocusProbe(focused: boolean | null): Promise<void>;
  seedDemoCalendar(events: CalendarEvent[]): Promise<void>;
  seedEvents(events: Array<Omit<CadenceEvent, 'id'>>): Promise<void>;
  setDemoMode(enabled: boolean): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  fireAlarm(name: string): Promise<void>;
  callNotificationButtonClicked(notificationId: string, buttonIndex: number): Promise<void>;
  getLastAiRequest(): ReturnType<typeof getLastAiRequest>;
}

declare global {
  // eslint-disable-next-line no-var
  var __cadenceTest: CadenceTestHooks | undefined;
}

/**
 * Installs globalThis.__cadenceTest. Only ever called from background.ts behind
 * `import.meta.env.WXT_TEST === '1'`, which Vite statically eliminates — see
 * e2e/build-hooks-absent.spec.ts, which greps the normal build for this string.
 */
export function installTestHooks(fireAlarmImpl: (name: string) => Promise<void>): void {
  globalThis.__cadenceTest = {
    async readTable(name) {
      return db.table(name).toArray();
    },
    async clearTable(name) {
      await db.table(name).clear();
    },
    async clearAllTables() {
      await Promise.all(TABLE_NAMES.map((name) => db.table(name).clear()));
    },
    async triggerLeader() {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      handleLeaderCommand(tab);
      return canHostOverlay(tab?.url) ? 'overlay' : 'panel';
    },
    async seedTable(name, rows) {
      await db.table(name).bulkAdd(rows);
    },
    async setFocusProbe(focused) {
      setFocusProbeForTests(focused);
    },
    async seedDemoCalendar(events) {
      await setDemoCalendarEvents(events);
    },
    async seedEvents(events) {
      await db.events.bulkAdd(events as CadenceEvent[]);
    },
    async setDemoMode(enabled) {
      await chrome.storage.local.set({ demoMode: enabled });
    },
    async setPaused(paused) {
      await chrome.storage.local.set({ paused });
    },
    async fireAlarm(name) {
      await fireAlarmImpl(name);
    },
    async callNotificationButtonClicked(notificationId, buttonIndex) {
      await routeNotificationButtonClicked(notificationId, buttonIndex);
    },
    getLastAiRequest() {
      return getLastAiRequest();
    },
  };
}
