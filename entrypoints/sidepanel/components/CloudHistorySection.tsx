/**
 * The TigerData mirror: the opt-in switch, what has been sent, and what comes back.
 *
 * The chart is read from a TimescaleDB continuous aggregate rather than computed locally — the
 * point of the panel is that the round trip is real, so showing locally-derived numbers here
 * would defeat it.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchActivityStats,
  getCloudSyncState,
  resetCloudSyncState,
  syncEvents,
  SYNCED_FIELDS,
  type ActivityStats,
  type CloudSyncState,
} from '@/lib/cloud-sync';
import { getCloudSyncEnabled, setCloudSyncEnabled } from '@/lib/settings';

const STATS_DAYS = 14;

function when(ts: number | null): string {
  if (ts === null) return 'never';
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** Daily totals across every kind, oldest first, with empty days filled in so the bars stay even. */
function dailyTotals(stats: ActivityStats): { day: string; events: number }[] {
  const byDay = new Map<string, number>();
  for (const row of stats.days) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.events);

  const out: { day: string; events: number }[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (STATS_DAYS - 1));
  for (let i = 0; i < STATS_DAYS; i++) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    out.push({ day: key, events: byDay.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function ActivityChart({ stats }: { stats: ActivityStats }) {
  const totals = dailyTotals(stats);
  const peak = Math.max(1, ...totals.map((t) => t.events));

  return (
    <div className="cloud-chart" role="img" aria-label={`Events per day for the last ${STATS_DAYS} days`}>
      {totals.map((t) => (
        <div key={t.day} className="cloud-bar-slot" title={`${t.day}: ${t.events} events`}>
          <div className="cloud-bar" style={{ height: `${Math.round((t.events / peak) * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function CloudHistorySection() {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<CloudSyncState | null>(null);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    const [on, s] = await Promise.all([getCloudSyncEnabled(), getCloudSyncState()]);
    setEnabled(on);
    setState(s);
    if (!on) {
      setStats(null);
      return;
    }
    const result = await fetchActivityStats(STATS_DAYS);
    setStats(result.ok ? result.stats : null);
    if (!result.ok) setMessage(`Could not read from TigerData: ${result.error}`);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (next: boolean) => {
    await setCloudSyncEnabled(next);
    setMessage(next ? '' : 'Syncing stopped. What was already sent stays in TigerData until you clear it.');
    await refresh();
  };

  const syncNow = async () => {
    setBusy(true);
    setMessage('');
    try {
      const result = await syncEvents();
      setMessage(
        result.ok
          ? result.skipped
            ? 'Turn syncing on first.'
            : `Sent ${result.sent} events, stored ${result.inserted}.`
          : `Sync failed: ${result.error}`,
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    await resetCloudSyncState();
    setMessage('Will re-send from the beginning on the next sync. Duplicates are discarded server-side.');
    await refresh();
  };

  return (
    <div className="cloud-history">
      <label className="settings-row checkbox-row">
        <input type="checkbox" checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
        <span>Sends event times, types, site domains and page titles to Tiger Data. Never typed text, URLs or page content.</span>
      </label>
      <p className="settings-hint">
        Off by default. Fields sent: <strong>{SYNCED_FIELDS.join(', ')}</strong>. Sites you exclude never send a
        title: &quot;Never record&quot; sites send nothing, and &quot;Visit only&quot; sites send just the domain. Your browsing history stays
        on this device; this is a copy of the metadata, kept 90 days.
      </p>

      {enabled && (
        <>
          <div className="settings-row">
            <span className="row-text">Last sync</span>
            <span className="cloud-value">{when(state?.lastSyncAt ?? null)}</span>
          </div>
          <div className="settings-row">
            <span className="row-text">Events stored</span>
            <span className="cloud-value">{stats ? stats.total.toLocaleString() : '—'}</span>
          </div>

          {stats && stats.total > 0 && (
            <>
              <p className="settings-hint">Events per day, last {STATS_DAYS} days — read back from the database.</p>
              <ActivityChart stats={stats} />
              {stats.topDomains.length > 0 && (
                <ul className="cloud-domains">
                  {stats.topDomains.slice(0, 5).map((d) => (
                    <li key={d.domain}>
                      <span className="cloud-domain">{d.domain}</span>
                      <span className="cloud-value">{d.events.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {stats !== null && stats.total === 0 && (
            <p className="settings-hint">Nothing stored yet. Press Sync now once you have some activity recorded.</p>
          )}

          <div className="standup-actions">
            <button className="btn" disabled={busy} onClick={() => void syncNow()}>
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
            <button className="btn" disabled={busy} onClick={() => void resend()}>
              Re-send everything
            </button>
          </div>
        </>
      )}

      {message !== '' && <div className="notice">{message}</div>}
      {state?.lastError && <div className="notice">Last sync error: {state.lastError}</div>}
    </div>
  );
}
