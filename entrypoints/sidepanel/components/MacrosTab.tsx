import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addMacroStep,
  deleteMacro,
  getMacros,
  moveMacroStep,
  setMacroReuseOpenTabs,
  setMacroSlot,
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
import { MACRO_RECORD_WINDOW_MS } from '@/lib/constants';
import { suggestLetter } from '@/lib/hotkeys';
import { getMenu, setMacroLetter, takenLetters } from '@/lib/leader';
import { FIND_PDF_SUGGESTION_TEXT, commandSteps } from '@/lib/find-pdf-command';
import { nameOpenMacro, refineSegment } from '@/lib/macro-repeat';
import { notNowSuggestion } from '@/lib/macros';
import { savedMacros, visibleSuggestions } from '@/lib/macro-suggestions';
import { RunPanel, useRunState } from './RunPanel';
import { Icon, IconButton, Keycap, Menu, SiteTile } from './ui';
import { openShortcutSettings, useCommandShortcut } from './ShortcutLabel';
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

function MacroNameInput({ macro, onRename, onDone }: { macro: Macro; onRename: (name: string) => void; onDone: () => void }) {
  const [value, setValue] = useState(macro.name);
  useEffect(() => setValue(macro.name), [macro.name]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== macro.name) onRename(trimmed);
    onDone();
  };

  return (
    <input
      className="name-input"
      value={value}
      autoFocus
      aria-label="Macro name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
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

function SlotControl({ macro, onRefresh }: { macro: Macro; onRefresh: () => void }) {
  const slot = macro.slot ?? 0;
  const shortcut = useCommandShortcut(`run-macro-slot-${slot || 1}`);
  return (
    <div className="inline-field">
      <label>
        <span>Direct shortcut</span>
        <select
          value={slot}
          aria-label="Direct shortcut slot"
          onChange={async (e) => {
            const n = Number(e.target.value);
            if (macro.id !== undefined) await setMacroSlot(macro.id, n === 0 ? null : n);
            onRefresh();
          }}
        >
          <option value={0}>None</option>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              Slot {n}
            </option>
          ))}
        </select>
      </label>
      {slot > 0 &&
        (shortcut.set ? (
          <Keycap title={`Run macro slot ${slot}`}>{shortcut.text}</Keycap>
        ) : (
          <button className="btn-link" onClick={openShortcutSettings}>
            Bind a key in Chrome <Icon name="external" size={12} />
          </button>
        ))}
    </div>
  );
}

function MacroRow({
  macro,
  highlighted,
  onRefresh,
  commandLetter,
}: {
  macro: Macro;
  highlighted: boolean;
  onRefresh: () => void;
  /** The leader letter a built-in command (Find PDF) runs on. */
  commandLetter?: string;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'letter' | 'slot' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((macro.params ?? []).map((p) => [p.name, p.lastValue])),
  );

  if (macro.id === undefined) return null;
  const macroId = macro.id;
  const command = macro.command;
  const cmdSteps = command ? commandSteps(command) : [];
  const openSteps = command ? cmdSteps.length : macro.steps.filter((s) => s.kind === 'open_url' && s.enabled).length;

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
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const failed = macro.lastRunResult?.outcomes.some((o) => o.status === 'failed') ?? false;
  const lastRun = status ?? (macro.lastRunResult ? summarizeRun(macro, macro.lastRunResult) : null);
  const reuse = macro.reuseOpenTabs === true;

  return (
    <section className={highlighted ? 'mrow highlight' : 'mrow'}>
      <div className="row-line">
        <button className={open ? 'chev open' : 'chev'} aria-expanded={open} aria-label={open ? 'Hide steps' : 'Show steps'} onClick={() => setOpen((v) => !v)}>
          <Icon name="chevron" size={14} />
        </button>
        {renaming ? (
          <MacroNameInput
            macro={macro}
            onRename={async (name) => {
              await renameMacro(macroId, name);
              onRefresh();
            }}
            onDone={() => setRenaming(false)}
          />
        ) : (
          <button className="row-title" title={macro.name} onClick={() => setOpen((v) => !v)}>
            {macro.name}
          </button>
        )}
        {command && commandLetter && <Keycap title={`Leader + ${commandLetter.toUpperCase()} runs this on your selected text`}>{commandLetter.toUpperCase()}</Keycap>}
        {macro.letter && <Keycap title={`Leader + ${macro.letter.toUpperCase()} runs this`}>{macro.letter.toUpperCase()}</Keycap>}
        {macro.slot && <Keycap title={`Direct shortcut slot ${macro.slot}`}>{`#${macro.slot}`}</Keycap>}
        <span className="meta" title={macroSummary(macro)}>
          {openSteps} {openSteps === 1 ? 'step' : 'steps'}
        </span>
        <IconButton icon="play" label={busy ? 'Running…' : 'Run'} tone="accent" disabled={busy} onClick={run} />
        <Menu
          items={[
            { label: 'Rename', onSelect: () => setRenaming(true) },
            { label: macro.letter ? 'Change letter' : 'Set letter', onSelect: () => { setOpen(true); setPanel('letter'); } },
            { label: 'Direct shortcut slot', onSelect: () => { setOpen(true); setPanel('slot'); } },
            ...(command
              ? []
              : [
                  { heading: 'If a page is already open' } as const,
                  { label: 'Open new tab', checked: !reuse, onSelect: async () => { await setMacroReuseOpenTabs(macroId, false); onRefresh(); } },
                  { label: 'Switch to it', checked: reuse, onSelect: async () => { await setMacroReuseOpenTabs(macroId, true); onRefresh(); } },
                ]),
            { heading: '' },
            { label: 'Delete', danger: true, onSelect: async () => { await deleteMacro(macroId); onRefresh(); } },
          ]}
        />
      </div>

      {lastRun && !open && <div className={failed ? 'row-sub error' : 'row-sub'} title={lastRun}>{lastRun}</div>}

      {open && (
        <div className="mrow-body">
          {panel === 'letter' && <SpaceLetterControl kind="macro" spaceId={macroId} name={macro.name} />}
          {panel === 'slot' && <SlotControl macro={macro} onRefresh={onRefresh} />}

          {command && (
            <ul className="step-list">
              {cmdSteps.map((label) => (
                <li key={label}>
                  <span className="tile plain" />
                  <span className="step-title" title={label}>
                    {label}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <ul className="step-list">
            {macro.steps.map((step, index) => (
              <li key={step.key}>
                <input
                  type="checkbox"
                  checked={step.enabled}
                  aria-label={`Include step: ${stepLabel(step)}`}
                  onChange={async (e) => {
                    await setMacroStepEnabled(macroId, step.key, e.target.checked);
                    onRefresh();
                  }}
                />
                {step.kind === 'open_url' ? <SiteTile url={step.url} /> : <span className="tile plain" />}
                <span className={isExperimental(step) ? 'step-title dim' : 'step-title'} title={stepLabel(step)}>
                  {stepLabel(step)}
                </span>
                {isExperimental(step) && <span className="chip">experimental</span>}
                <IconButton icon="up" label="Move up" disabled={index === 0} onClick={async () => { await moveMacroStep(macroId, step.key, -1); onRefresh(); }} />
                <IconButton icon="down" label="Move down" disabled={index === macro.steps.length - 1} onClick={async () => { await moveMacroStep(macroId, step.key, 1); onRefresh(); }} />
                <IconButton icon="close" label="Remove step" onClick={async () => { await removeMacroStep(macroId, step.key); onRefresh(); }} />
              </li>
            ))}
          </ul>

          {(macro.params ?? []).length > 0 && (
            <div className="params">
              {(macro.params ?? []).map((param) => (
                <label key={param.name} className="inline-field">
                  <span>{param.name}</span>
                  <input
                    value={paramValues[param.name] ?? ''}
                    onChange={(e) => setParamValues((v) => ({ ...v, [param.name]: e.target.value }))}
                    placeholder={param.lastValue || 'Enter a value'}
                  />
                </label>
              ))}
            </div>
          )}

          {!command && <AddStepControls
            macroId={macroId}
            urls={[...new Set(macro.steps.filter((s) => s.kind === 'open_url').map((s) => s.url))]}
            onAdded={onRefresh}
          />}

          <div className="row-sub" title={explainStatus(macro.status, macro.stats ?? EMPTY_STATS)}>
            {explainStatus(macro.status, macro.stats ?? EMPTY_STATS)} · {detectorLabel(macro.detector)}
          </div>
          {lastRun && <div className={failed ? 'row-sub error' : 'row-sub'}>{lastRun}</div>}
        </div>
      )}
    </section>
  );
}

export interface MacrosTabProps {
  /** Bumped by App when the keyboard shortcut fires, to focus the filter input. */
  paletteNonce: number;
}

export function MacrosTab({ paletteNonce }: MacrosTabProps) {
  const [macros, setMacros] = useState<Macro[]>([]);
  const [commandLetter, setCommandLetter] = useState<string | undefined>(undefined);
  const [offerLetter, setOfferLetter] = useState<{ macroId: number; name: string; letter: string } | null>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [shortcut, setShortcut] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setMacros(await getMacros());
    setCommandLetter((await getMenu()).find((i) => i.id === 'find-pdf')?.letter);
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

  // At most two suggestions, snoozed / merged / best-first; saved macros are listed above them.
  const suggested = useMemo(() => visibleSuggestions(macros, Date.now()), [macros]);
  const saved = useMemo(() => savedMacros(macros), [macros]);

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

  /** After a save: offer the first free letter of the macro's name, one click to confirm. */
  const offerLetterFor = async (macro: Macro) => {
    if (macro.id === undefined || macro.letter || macro.command) return;
    const letter = suggestLetter(macro.name, await takenLetters());
    setOfferLetter(letter ? { macroId: macro.id, name: macro.name, letter } : null);
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
      const macro = await recordMacroFromRecentActivity({
        fromTs: Date.now() - MACRO_RECORD_WINDOW_MS,
        toTs: Date.now(),
        refine: refineSegment,
        reuseExisting: true,
        nameFor: (c, taken) => nameOpenMacro(c.steps.filter((s) => s.kind === 'open_url').map((s) => s.url), taken),
      });
      setNotice(macro ? null : 'Nothing to keep: open at least two pages first.');
      if (macro) await offerLetterFor(macro);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="loading">Loading macros…</div>;

  const recent = [...saved]
    .filter((m) => m.lastRunAt !== undefined && m.lastRunResult)
    .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
    .slice(0, 3);

  return (
    <div className="macros-tab">
      <div className="toolbar">
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Run a macro…"
          aria-label="Run a macro"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onPaletteKeyDown}
        />
        <IconButton icon="refresh" label="Scan for routines now" disabled={busy} onClick={scanNow} />
        <IconButton icon="record" label="Keep the last 30 seconds as a macro" disabled={busy} onClick={recordNow} />
      </div>
      {!shortcut && (
        <button className="btn-link hint-link" onClick={openShortcutSettings}>
          Set a palette shortcut <Icon name="external" size={12} />
        </button>
      )}

      {notice && <div className="notice">{notice}</div>}

      {offerLetter && (
        <div className="notice action">
          <span>
            Saved “{offerLetter.name}”. Run it with leader + <Keycap>{offerLetter.letter.toUpperCase()}</Keycap>?
          </span>
          <button
            className="btn primary sm"
            onClick={async () => {
              await setMacroLetter(offerLetter.macroId, offerLetter.letter);
              setOfferLetter(null);
              await refresh();
            }}
          >
            Assign {offerLetter.letter.toUpperCase()}
          </button>
          <button className="btn sm" onClick={() => setOfferLetter(null)}>
            Skip
          </button>
        </div>
      )}

      {/* A run started from the palette, a notification or an auto-trigger may target a macro
          that is filtered out of view, or not saved at all. Its controls must stay reachable,
          so an unmatched run falls back to rendering above the list. */}
      {runState && !filtered.some((m) => m.id === runState.macroId) && (
        <RunPanel state={runState} abandoned={abandoned} stepsByMacroId={stepsByMacroId} />
      )}

      <h3 className="sec-title">
        Saved <span className="count">{saved.length}</span>
      </h3>
      {filtered.length === 0 && (
        <div className="empty">
          {query ? 'No saved macros match that.' : 'No saved macros yet. Do a routine, then press the leader key and K to keep it.'}
        </div>
      )}
      {filtered.map((macro, index) =>
        runState && macro.id === runState.macroId ? (
          <RunPanel key={macro.macroKey} state={runState} abandoned={abandoned} stepsByMacroId={stepsByMacroId} />
        ) : (
          <MacroRow key={macro.macroKey} macro={macro} highlighted={query.length > 0 && index === highlight} onRefresh={refresh} commandLetter={commandLetter} />
        ),
      )}

      {suggested.length > 0 && (
        <>
          <h3 className="sec-title">Suggestions</h3>
          {suggested.map((macro) => (
            <SuggestionCard
              key={macro.macroKey}
              title={macro.name}
              description={macro.command ? FIND_PDF_SUGGESTION_TEXT : macroSummary(macro)}
              acceptLabel={macro.command && commandLetter ? `Save on ${commandLetter.toUpperCase()}` : 'Save'}
              onAccept={async () => {
                if (macro.id !== undefined) {
                  await updateMacroStatus(macro.id, 'accepted');
                  await offerLetterFor({ ...macro, status: 'accepted' });
                }
                await refresh();
              }}
              onNotNow={async () => {
                if (macro.id !== undefined) await notNowSuggestion(macro.id);
                await refresh();
              }}
              onNever={async () => {
                if (macro.id !== undefined) await updateMacroStatus(macro.id, 'never');
                await refresh();
              }}
            />
          ))}
        </>
      )}

      {recent.length > 0 && (
        <>
          <h3 className="sec-title">Recent runs</h3>
          <ul className="log">
            {recent.map((m) => (
              <li key={m.macroKey} title={`${m.name}: ${summarizeRun(m, m.lastRunResult!)}`}>
                <span className="log-name">{m.name}</span>
                <span className="meta">{summarizeRun(m, m.lastRunResult!)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
