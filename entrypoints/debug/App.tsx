import { useCallback, useEffect, useState } from 'react';
import { clearAll, countByKind, exportAll, getEvents } from '@/lib/db';
import { simulateTwoPastTeamSyncs, wipeSyntheticRitualData } from '@/lib/ritual-simulation';
import type { CadenceEvent, EventKind } from '@/lib/types';
import { TestHarness } from './TestHarness';

const DAY_MS = 24 * 60 * 60 * 1000;

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [totalCount, setTotalCount] = useState(0);
  const [kindCounts, setKindCounts] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<CadenceEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [simStatus, setSimStatus] = useState('');

  const refresh = useCallback(async () => {
    const now = Date.now();
    const [allEvents, counts24h] = await Promise.all([
      getEvents(0, now),
      countByKind(now - DAY_MS, now),
    ]);
    setTotalCount(allEvents.length);
    setKindCounts(counts24h as Record<string, number>);
    setRecent(allEvents.sort((a, b) => b.ts - a.ts).slice(0, 50));

    const { paused: p } = await chrome.storage.local.get('paused');
    setPaused(p === true);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const togglePause = async () => {
    await chrome.storage.local.set({ paused: !paused });
    setPaused(!paused);
  };

  const handleExport = async () => {
    const data = await exportAll();
    downloadJson(data, `cadence-export-${Date.now()}.json`);
  };

  const handleClear = async () => {
    if (!confirm('Delete all stored Cadence events? This cannot be undone.')) return;
    await clearAll();
    await refresh();
  };

  const simulate = async () => {
    setSimStatus('Simulating…');
    try {
      const r = await simulateTwoPastTeamSyncs();
      setSimStatus(
        `Added ${r.occurrences} past Team sync occurrences with ${r.tabs} open tab(s). ${r.rituals} ritual(s) now exist — check the Rituals tab, then press "Test now".`,
      );
      await refresh();
    } catch (err) {
      setSimStatus(`Simulation failed: ${String(err)}`);
    }
  };

  const wipeSimulation = async () => {
    await wipeSyntheticRitualData();
    setSimStatus('Synthetic events, occurrences, and the Team sync ritual were removed.');
    await refresh();
  };

  const kinds: EventKind[] = [
    'tab_activated',
    'tab_opened',
    'tab_closed',
    'navigated',
    'click',
    'field_changed',
    'typing_burst',
    'chrome_focus_lost',
    'chrome_focus_gained',
  ];

  return (
    <div>
      <h1>Cadence Debug</h1>
      <p className="subtitle">Internal testing view. Not the real UI.</p>

      <div className="toolbar">
        <button className={paused ? 'active' : ''} onClick={togglePause}>
          {paused ? 'Paused — click to resume' : 'Pause collection'}
        </button>
        <button onClick={handleExport}>Export JSON</button>
        <button className="danger" onClick={handleClear}>
          Clear all data
        </button>
        <button onClick={refresh}>Refresh</button>
      </div>

      <div className="toolbar">
        <button onClick={simulate}>Simulate 2 past Team syncs</button>
        <button className="danger" onClick={wipeSimulation}>
          Wipe simulated data
        </button>
        <span>{simStatus}</span>
      </div>

      <TestHarness />

      <div className="cards">
        <div className="card">
          <div className="value">{totalCount}</div>
          <div className="label">total events</div>
        </div>
        {kinds.map((k) => (
          <div className="card" key={k}>
            <div className="value">{kindCounts[k] ?? 0}</div>
            <div className="label">{k} (24h)</div>
          </div>
        ))}
      </div>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Kind</th>
            <th>Domain</th>
            <th>Title</th>
            <th>Selector</th>
            <th>Label</th>
            <th>Field</th>
            <th>Keys</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((e) => (
            <tr key={e.id}>
              <td>{formatTs(e.ts)}</td>
              <td>{e.kind}</td>
              <td>{e.domain ?? ''}</td>
              <td>{e.title ?? ''}</td>
              <td>{e.selector ?? ''}</td>
              <td>{e.label ?? ''}</td>
              <td>{e.fieldName ?? ''}</td>
              <td>{e.keyCount ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
