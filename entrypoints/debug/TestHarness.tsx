import { useCallback, useEffect, useState } from 'react';
import { getMacros } from '@/lib/db';
import {
  clearHarnessData,
  clearStuckReplayFlag,
  inspectRunChannel,
  plantStaleRun,
  promoteToAuto,
  seedOrderingMacro,
  seedParamHistory,
  type HarnessResult,
} from '@/lib/dev-harness';
import type { NormalizedMacro } from '@/lib/types';

/**
 * Dev-only controls for reaching macro states that are slow to reach by hand.
 *
 * Lives on the debug page because that page is already labelled as not the real UI. Nothing in
 * `entrypoints/sidepanel` imports it, so the shipped surface is unchanged; deleting this file
 * and its one use in `App.tsx` removes the harness.
 */
export function TestHarness() {
  const [macros, setMacros] = useState<NormalizedMacro[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<HarnessResult | null>(null);
  const [channel, setChannel] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const all = await getMacros();
    setMacros(all);
    setSelected((current) => {
      if (current !== null && all.some((m) => m.id === current)) return current;
      return all.find((m) => m.status === 'accepted' || m.status === 'auto')?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = (fn: () => Promise<HarnessResult>) => async () => {
    setBusy(true);
    try {
      setResult(await fn());
      await refresh();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const needsMacro = (fn: (id: number) => Promise<HarnessResult>) => async () => {
    if (selected === null) return { ok: false, message: 'Pick a macro first.' };
    return fn(selected);
  };

  return (
    <section className="harness">
      <h2>Test harness</h2>
      <p className="subtitle">
        Seeds states that take days of real use to reach. Everything here writes ordinary data —
        undo it with “Remove harness data”, or from the Macros tab.
      </p>

      <div className="toolbar">
        <button disabled={busy} onClick={act(seedOrderingMacro)}>
          1 · Seed ordering macro
        </button>
        <button disabled={busy} onClick={act(seedParamHistory)}>
          2 · Seed {'{pull}'} history + rescan
        </button>
      </div>

      <div className="toolbar">
        <select
          value={selected ?? ''}
          onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">— pick a macro —</option>
          {macros.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.status})
            </option>
          ))}
        </select>
        <button disabled={busy || selected === null} onClick={act(needsMacro(promoteToAuto))}>
          3 · Make it auto (5 clean runs)
        </button>
        <button disabled={busy || selected === null} onClick={act(needsMacro(plantStaleRun))}>
          4 · Plant a crashed run
        </button>
      </div>

      <div className="toolbar">
        <button
          disabled={busy}
          onClick={async () => {
            setChannel(await inspectRunChannel());
          }}
        >
          Inspect run channel
        </button>
        <button disabled={busy} onClick={act(clearStuckReplayFlag)}>
          Clear stuck run / replay flag
        </button>
        <button className="danger" disabled={busy} onClick={act(clearHarnessData)}>
          Remove harness data
        </button>
      </div>

      {result && (
        <div className={result.ok ? 'harness-note' : 'harness-note bad'}>{result.message}</div>
      )}

      {channel && <pre className="harness-json">{JSON.stringify(channel, null, 2)}</pre>}
    </section>
  );
}
