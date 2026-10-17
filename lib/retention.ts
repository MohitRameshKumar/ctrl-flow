// PRIV-5: how long raw events are kept. Only the events table is ever purged: rituals, spaces,
// shelves, and flip pairs are saved items, not activity history.
export type RetentionSetting = '10m' | '1h' | '24h' | '7d';

export const RETENTION_KEY = 'retention';
export const DEFAULT_RETENTION: RetentionSetting = '24h';

export const RETENTION_OPTIONS: { value: RetentionSetting; label: string; ms: number }[] = [
  { value: '10m', label: '10 minutes', ms: 10 * 60 * 1000 },
  { value: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { value: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
];

export function isRetentionSetting(v: unknown): v is RetentionSetting {
  return RETENTION_OPTIONS.some((o) => o.value === v);
}

export function retentionMs(setting: unknown): number {
  const found = RETENTION_OPTIONS.find((o) => o.value === setting);
  return (found ?? RETENTION_OPTIONS.find((o) => o.value === DEFAULT_RETENTION)!).ms;
}

/** Events with ts strictly below this are deleted. */
export function retentionCutoff(setting: unknown, now: number): number {
  return now - retentionMs(setting);
}

export function isExpired(eventTs: number, setting: unknown, now: number): boolean {
  return eventTs < retentionCutoff(setting, now);
}
