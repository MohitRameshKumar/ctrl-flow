import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addMacroStep,
  deleteMacro,
  getMacros,
  moveMacroStep,
  setMacroReuseOpenTabs,
  removeMacroStep,
  renameMacro,
  setMacroStepEnabled,
  updateMacroStatus,
} from '@/lib/db';
import { summarizeRun } from '@/lib/macro-replay';
import {
  getPaletteShortcut,
  recomputeMacros,
  recordMacroFromRecentActivity,
  runMacro,
} from '@/lib/macros';
import { mintStepKey } from '@/lib/macro-detection';
import { explainStatus } from '@/lib/macro-learning';
import { EMPTY_STATS } from '@/lib/macro-learning';
import { getDemoMode } from '@/lib/settings';
import type { Macro, MacroStep } from '@/lib/types';
import { RunPanel, useRunState } from './RunPanel';
import { SpaceLetterControl } from './SpaceLetterControl';
import { SuggestionCard } from './SuggestionCard';

function detectorLabel(detector: Macro['detector']): string {
  if (detector === 'time_of_day') return 'time of day';
  if (detector === 'sequence') return 'sequence';
  return 'sequence + time';
}

/**
 * Splits a palette query into search words and trailing argument values.
 *
 * Anything that looks like an identifier value — a number, or a short token with a digit — is
 * treated as an argument rather than part of the name being searched for.
 */
export function splitQuery(query: string): { words: string[]; args: string[] } {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const args: string[] = [];
  const words: string[] = [];
  for (const token of tokens) {
    if (/^[A-Za-z]*\d[\w.-]*$/.test(token)) args.push(token);
    else words.push(token);
  }
  return { words, args };
}

function stepLabel(step: MacroStep): string {
  switch (step.kind) {
    case 'click':
      return `Click: ${step.label ?? step.selector ?? 'element'}`;
    case 'type':
      return `Type into ${step.label ?? step.selector ?? 'field'}`;
    case 'focus_tab':
      return `Switch to ${step.title || step.url}`;
    case 'wait':
      return `Wait ${Math.round((step.waitMs ?? 0) / 100) / 10}s`;
    case 'wait_for':
      return `Wait for ${step.label ?? step.selector ?? 'element'}`;
    case 'close_tabs':
      return 'Close the tabs this opened';
    default:
      return step.title || step.url;
  }
}

/** Clicks and typing are the unreliable half of replay; the UI says so rather than implying parity. */
function isExperimental(step: MacroStep): boolean {
  return step.kind === 'click' || step.kind === 'type';
}

/** "3 tabs · seen 4 times · around 9am" */
function macroSummary(macro: Macro): string {
  const tabs = macro.steps.filter((s) => s.kind === 'open_url').length;
  const parts = [`${tabs} tab${tabs === 1 ? '' : 's'}`, `seen ${macro.occurrences} times`];
  if (macro.typicalHour !== null) {
    const hour = macro.typicalHour % 12 === 0 ? 12 : macro.typicalHour % 12;
    parts.push(`around ${hour}${macro.typicalHour < 12 ? 'am' : 'pm'}`);
  }
  return parts.join(' · ');
}

function MacroNameInput({ macro, onRename }: { macro: Macro; onRename: (name: string) => void }) {
  const [value, setValue] = useState(macro.name);
  useEffect(() => setValue(macro.name), [macro.name]);

  return (
    <input
      className="space-name-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed && trimmed !== macro.name) onRename(trimmed);
      }}
    />
  );
}


/**
 * Builds the step kinds detection never produces.
 *
 * `type` text is entered here and only here — the collector records keystroke counts, never
 * their content, so there is no path by which a recorded step could carry text.
 */
function AddStepControls({ macroId, urls, onAdded }: {
  macroId: number;
  urls: string[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'wait' | 'wait_for' | 'type' | 'close_tabs'>('wait');
  const [url, setUrl] = useState(urls[0] ?? '');
  const [selector, setSelector] = useState('');
  const [text, setText] = useState('');
  const [waitSeconds, setWaitSeconds] = useState('2');
  const [error, setError] = useState('');

  const needsPage = kind === 'type' || kind === 'wait_for';

  const add = async () => {
    const step: MacroStep = {
      key: mintStepKey(kind),
      kind,
      url: needsPage ? url : '',
      selector: needsPage ? selector.trim() || undefined : undefined,
      text: kind === 'type' ? text : undefined,
      waitMs: kind === 'wait' ? Math.round(Number(waitSeconds) * 1000) || 1000 : undefined,
      enabled: true,
      support: 0,
    };
    if (needsPage && (!step.url || !step.selector)) return;

    try {
      await addMacroStep(macroId, step);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setError('');
    setOpen(false);
    setSelector('');
    setText('');
    onAdded();
  };

  if (!open) {
    return (
      <button className="btn btn-link" onClick={() => setOpen(true)}>
        + Add step
      </button>
    );
  }

  return (
    <div className="add-step">
      <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
        <option value="wait">Wait a moment</option>
        <option value="wait_for">Wait for something to appear</option>
        <option value="type">Type text</option>
        <option value="close_tabs">Close the tabs this opened</option>
      </select>

      {kind === 'wait' && (
        <label className="add-step-field">
          <span>Seconds</span>
          <input value={waitSeconds} onChange={(e) => setWaitSeconds(e.target.value)} />
        </label>
      )}

      {needsPage && (
        <>
          <label className="add-step-field">
            <span>On page</span>
            <select value={url} onChange={(e) => setUrl(e.target.value)}>
              {urls.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          <label className="add-step-field">
            <span>Selector</span>
            <input
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
              placeholder="#search, [aria-label=&quot;Search&quot;]"
            />
          </label>
        </>
      )}

      {kind === 'type' && (
        <label className="add-step-field">
          <span>Text</span>
          <input value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      )}

      {kind === 'type' && (
        <p className="settings-hint">
          Stored in plain text on this device. Password and payment fields are refused at the
          point of typing.
        </p>
      )}

      {error && <p className="letter-error">{error}</p>}

      <div className="space-actions">
        <button className="btn btn-accept" onClick={add}>
          Add
        </button>
        <button className="btn btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function MacroCard({
  macro,
  highlighted,
  onRefresh,
}: {
  macro: Macro;
  highlighted: boolean;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((macro.params ?? []).map((p) => [p.name, p.lastValue])),
  );

  if (macro.id === undefined) return null;
  const macroId = macro.id;

  // Pause / Stop / Skip live in the RunPanel, which talks to the executor over the session-storage
  // command channel — that works whether the run was started here, from a notification, or by an
  // auto-trigger with no panel open at all.
  const run = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await runMacro(macroId, { params: paramValues });
      setStatus(result ? summarizeRun(macro, result) : 'Nothing to run');
      onRefresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const failed = macro.lastRunResult?.outcomes.some((o) => o.status === 'failed') ?? false;
  const lastRun = status ?? (macro.lastRunResult ? summarizeRun(macro, macro.lastRunResult) : null);

  return (
    <section className={highlighted ? 'space-card macro-row highlight' : 'space-card macro-row'}>
      <div className="space-header">
        <MacroNameInput
          macro={macro}
          onRename={async (name) => {
            await renameMacro(macroId, name);
            onRefresh();
          }}
        />
        <span className="space-status">{detectorLabel(macro.detector)}</span>
      </div>

      <div className="macro-run-status">{explainStatus(macro.status, macro.stats ?? EMPTY_STATS)}</div>

      <SpaceLetterControl kind="macro" spaceId={macroId} name={macro.name} />

      <label className="settings-row">
        <span>If a page is already open</span>
        <select
          value={macro.reuseOpenTabs ? 'switch' : 'new'}
          aria-label="If a page is already open"
          onChange={async (e) => {
            await setMacroReuseOpenTabs(macroId, e.target.value === 'switch');
            onRefresh();
          }}
        >
          <option value="new">Open new tab</option>
          <option value="switch">Switch to it</option>
        </select>
      </label>

      <ul className="tab-list">
        {macro.steps.map((step, index) => (
          <li key={step.key}>
            <label className="always-open-toggle">
              <input
                type="checkbox"
                checked={step.enabled}
                onChange={async (e) => {
                  await setMacroStepEnabled(macroId, step.key, e.target.checked);
                  onRefresh();
                }}
              />
            </label>
            <span className={isExperimental(step) ? 'tab-title macro-step-click' : 'tab-title'}>
              {stepLabel(step)}
            </span>
            {isExperimental(step) && <span className="macro-chip">experimental</span>}
            <button
              className="btn btn-link macro-step-move"
              disabled={index === 0}
              title="Move up"
              onClick={async () => {
                await moveMacroStep(macroId, step.key, -1);
                onRefresh();
              }}
            >
              ↑
            </button>
            <button
              className="btn btn-link macro-step-move"
              disabled={index === macro.steps.length - 1}
              title="Move down"
              onClick={async () => {
                await moveMacroStep(macroId, step.key, 1);
                onRefresh();
              }}
            >
              ↓
            </button>
            <button
              className="btn btn-remove"
              onClick={async () => {
                await removeMacroStep(macroId, step.key);
                onRefresh();
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      {(macro.params ?? []).length > 0 && (
        <div className="macro-params">
          {(macro.params ?? []).map((param) => (
            <label key={param.name} className="add-step-field">
              <span>{param.name}</span>
              <input
                value={paramValues[param.name] ?? ''}
                onChange={(e) =>
                  setParamValues((v) => ({ ...v, [param.name]: e.target.value }))
                }
                placeholder={param.lastValue}
              />
            </label>
          ))}
          <p className="settings-hint">
            Recently: {(macro.params ?? []).flatMap((p) => p.examples).slice(0, 4).join(', ')}
          </p>
        </div>
      )}

      <AddStepControls
        macroId={macroId}
        urls={[...new Set(macro.steps.filter((s) => s.kind === 'open_url').map((s) => s.url))]}
        onAdded={onRefresh}
      />

      <div className="space-actions">
        <button className="btn btn-accept" disabled={busy} onClick={run}>
          {busy ? 'Running…' : 'Run'}
        </button>
        <button
          className="btn btn-secondary"
          onClick={async () => {
            await deleteMacro(macroId);
            onRefresh();
          }}
        >
          Delete
        </button>
      </div>

      {lastRun && <div className={failed ? 'macro-run-status error' : 'macro-run-status'}>{lastRun}</div>}
    </section>
  );
}

export interface MacrosTabProps {
  /** Bumped by App when the keyboard shortcut fires, to focus the filter input. */
  paletteNonce: number;
}

export function MacrosTab({ paletteNonce }: MacrosTabProps) {
  const [macros, setMacros] = useState<Macro[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [shortcut, setShortcut] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setMacros(await getMacros());
    setLoading(false);
  }, []);

  // Held here rather than inside RunPanel so the running macro's own card can be replaced by
  // the run view, instead of a second card appearing above the list for the same thing.
  const { state: runState, abandoned } = useRunState(refresh);

  useEffect(() => {
    (async () => {
      await refresh();
      setShortcut(await getPaletteShortcut());
      // Scan on mount, the same way SpacesTab recomputes when you open it.
      await recomputeMacros(await getDemoMode());
      await refresh();
    })();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (paletteNonce === 0) return;
    setQuery('');
    setHighlight(0);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [paletteNonce]);

  const stepsByMacroId = useMemo(
    () => new Map(macros.filter((m) => m.id !== undefined).map((m) => [m.id as number, m.steps])),
    [macros],
  );

  const suggested = macros.filter((m) => m.status === 'suggested' && !dismissed.has(m.id ?? -1));
  const saved = useMemo(
    () => macros.filter((m) => m.status === 'accepted' || m.status === 'auto'),
    [macros],
  );

  const filtered = useMemo(() => {
    const q = splitQuery(query).words.join(' ').toLowerCase();
    if (!q) return saved;
    return saved
      .filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.steps.some((s) => `${s.title ?? ''} ${s.url}`.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aPrefix - bPrefix;
      });
  }, [saved, query]);

  const onPaletteKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // "pr 847" runs the matching macro with 847 as its first parameter, so a parameterized
      // routine is still one keystroke away from the palette.
      const { words, args } = splitQuery(query);
      const target = filtered[highlight] ?? filtered[0];
      if (target?.id !== undefined) {
        const params = Object.fromEntries(
          (target.params ?? []).map((p, i) => [p.name, args[i] ?? p.lastValue]),
        );
        void words;
        await runMacro(target.id, { params });
        await refresh();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
      setHighlight(0);
    }
  };

  const scanNow = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await recomputeMacros(await getDemoMode());
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const recordNow = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const macro = await recordMacroFromRecentActivity();
      setNotice(
        macro
          ? `Saved "${macro.name}" from the last 30 seconds.`
          : 'Nothing to record — visit at least two pages first.',
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="loading">Loading macros…</div>;

  return (
    <>
      <div className="macro-palette">
        <input
          ref={inputRef}
          className="macro-palette-input"
          placeholder="Run a macro…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onPaletteKeyDown}
        />
        {shortcut ? (
          <span className="macro-palette-hint">{shortcut}</span>
        ) : (
          <button
            className="btn btn-link"
            onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
          >
            Set a shortcut
          </button>
        )}
      </div>

      <div className="spaces-toolbar">
        <button className="btn btn-secondary" disabled={busy} onClick={scanNow}>
          {busy ? 'Working…' : 'Scan now'}
        </button>
        <button className="btn btn-secondary" disabled={busy} onClick={recordNow}>
          Record last 30s
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      {/* A run started from the palette, a notification or an auto-trigger may target a macro
          that is filtered out of view, or not saved at all. Its controls must stay reachable,
          so an unmatched run falls back to rendering above the list. */}
      {runState && !filtered.some((m) => m.id === runState.macroId) && (
        <RunPanel state={runState} abandoned={abandoned} stepsByMacroId={stepsByMacroId} />
      )}

      {suggested.map((macro) => (
        <SuggestionCard
          key={macro.macroKey}
          title={`Save "${macro.name}" as a macro?`}
          description={macroSummary(macro)}
          acceptLabel="Save macro"
          onAccept={async () => {
            if (macro.id !== undefined) await updateMacroStatus(macro.id, 'accepted');
            await refresh();
          }}
          onNotNow={() => setDismissed((d) => new Set(d).add(macro.id ?? -1))}
          onNever={async () => {
            if (macro.id !== undefined) await updateMacroStatus(macro.id, 'never');
            await refresh();
          }}
        />
      ))}

      {filtered.length === 0 && suggested.length === 0 && (
        <div className="ritual-empty">
          {query
            ? 'No macros match that.'
            : 'No macros yet. Repeat a routine a few times and Cadence will spot it — or press "Record last 30s" after doing one.'}
        </div>
      )}

      {filtered.map((macro, index) =>
        runState && macro.id === runState.macroId ? (
          <RunPanel
            key={macro.macroKey}
            state={runState}
            abandoned={abandoned}
            stepsByMacroId={stepsByMacroId}
          />
        ) : (
          <MacroCard
            key={macro.macroKey}
            macro={macro}
            highlighted={query.length > 0 && index === highlight}
            onRefresh={refresh}
          />
        ),
      )}
    </>
  );
}
