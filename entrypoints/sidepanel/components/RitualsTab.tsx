import { useCallback, useEffect, useState } from 'react';
import { createCalendarSource } from '@/lib/calendar';
import { getRituals, removeRitualUrl, updateRitualStatus } from '@/lib/db';
import { detectRituals, fireRitualTrigger, scheduleRitualAlarms } from '@/lib/rituals';
import type { CalendarEvent, Ritual } from '@/lib/types';
import { SuggestionCard } from './SuggestionCard';

const DAY_MS = 24 * 60 * 60 * 1000;

async function readSettings(): Promise<{ calendarSource: 'demo' | 'google'; demoMode: boolean }> {
  const { calendarSource, demoMode } = await chrome.storage.local.get<{
    calendarSource?: 'demo' | 'google';
    demoMode?: boolean;
  }>(['calendarSource', 'demoMode']);
  return { calendarSource: calendarSource ?? 'demo', demoMode: demoMode ?? true };
}

function RitualCard({
  ritual,
  windowSize,
  onRefresh,
}: {
  ritual: Ritual;
  windowSize: number;
  onRefresh: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  if (ritual.id === undefined) return null;
  const ritualId = ritual.id;

  const setStatus = async (status: Ritual['status']) => {
    await updateRitualStatus(ritualId, status);
    onRefresh();
  };

  const removeDoc = async (url: string) => {
    await removeRitualUrl(ritualId, url);
    onRefresh();
  };

  const testNow = async () => {
    setTesting(true);
    try {
      await fireRitualTrigger(ritualId);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="ritual-card">
      <div className="ritual-title">{ritual.title}</div>

      {ritual.urls.length === 0 ? (
        <div className="ritual-empty">No prep docs detected yet.</div>
      ) : (
        <ul className="doc-list">
          {ritual.urls.map((u) => (
            <li key={u.url}>
              <span className="doc-title" title={u.url}>
                {u.pageTitle || u.url}
              </span>
              <span className="doc-seen">
                seen in {u.occurrences} of {windowSize}
              </span>
              <button className="btn btn-remove" onClick={() => removeDoc(u.url)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {ritual.status === 'suggested' && !suggestionDismissed && (
        <SuggestionCard
          title="Run this ritual automatically next time?"
          description="ctrl-flow noticed these tabs around this meeting every time."
          onAccept={() => setStatus('accepted')}
          onNotNow={() => setSuggestionDismissed(true)}
          onNever={() => setStatus('never')}
        />
      )}

      {(ritual.status === 'accepted' || ritual.status === 'auto') && (
        <label className="settings-row checkbox-row">
          <input
            type="checkbox"
            checked={ritual.status === 'auto'}
            onChange={(e) => setStatus(e.target.checked ? 'auto' : 'accepted')}
          />
          <span>Open automatically</span>
        </label>
      )}

      <button className="btn btn-secondary" disabled={testing} onClick={testNow}>
        {testing ? 'Testing…' : 'Test now'}
      </button>
    </div>
  );
}

function UpcomingList({ upcoming, rituals }: { upcoming: CalendarEvent[]; rituals: Ritual[] }) {
  const next5 = [...upcoming].sort((a, b) => a.start - b.start).slice(0, 5);

  if (next5.length === 0) {
    return (
      <section>
        <h3>Upcoming</h3>
        <div className="ritual-empty">No upcoming meetings.</div>
      </section>
    );
  }

  return (
    <section>
      <h3>Upcoming</h3>
      <ul className="upcoming-list">
        {next5.map((e) => {
          const ritual = rituals.find((r) => r.seriesKey === e.seriesKey);
          const willFire = !!ritual && ritual.status !== 'never' && ritual.urls.length > 0;
          return (
            <li key={e.id}>
              <span className="upcoming-time">
                {new Date(e.start).toLocaleString([], {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
              <span className="upcoming-title">{e.title}</span>
              <span className={willFire ? 'will-fire yes' : 'will-fire no'}>
                {willFire ? 'Ritual will fire' : 'No ritual'}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RitualsTab() {
  const [rituals, setRituals] = useState<Ritual[]>([]);
  const [upcoming, setUpcoming] = useState<CalendarEvent[]>([]);
  const [demoMode, setDemoMode] = useState(true);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { calendarSource, demoMode: dm } = await readSettings();
    setDemoMode(dm);
    const source = createCalendarSource(calendarSource);
    const now = Date.now();
    const [rits, upcomingEvents] = await Promise.all([
      getRituals(),
      source.getEvents(now, now + 7 * DAY_MS),
    ]);
    setRituals(rits);
    setUpcoming(upcomingEvents);
    setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      const { calendarSource, demoMode: dm } = await readSettings();
      const source = createCalendarSource(calendarSource);
      await detectRituals(source, { demoMode: dm });
      await scheduleRitualAlarms(source);
      await refresh();
    })();
  }, [refresh]);

  if (loading) return <div className="loading">Loading rituals…</div>;

  const visibleRituals = rituals.filter((r) => r.status !== 'never');
  const windowSize = demoMode ? 2 : 3;

  return (
    <div className="rituals-tab">
      {visibleRituals.length === 0 && (
        <div className="ritual-empty">
          No rituals detected yet. Rituals need at least 2 past occurrences of a recurring meeting.
        </div>
      )}
      {visibleRituals.map((r) => (
        <RitualCard key={r.id} ritual={r} windowSize={windowSize} onRefresh={refresh} />
      ))}
      <UpcomingList upcoming={upcoming} rituals={rituals} />
    </div>
  );
}
