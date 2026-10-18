import { useCallback, useEffect, useState } from 'react';
import { deleteFlipPair, getFlipPairs } from '@/lib/db';
import { flipStatus, siteLabel, type FlipStatus } from '@/lib/flip-cycle';
import {
  FLIP_DELAY_MAX_MS,
  FLIP_DELAY_MIN_MS,
  FLIP_DELAY_STEP_MS,
  FLIP_READ_DELAY_KEY,
  FLIP_WRITE_DELAY_KEY,
  getFlipDelays,
  type FlipDelays,
} from '@/lib/flip-settings';
import { FOCUS_FLIP_KEY, isFocusFlipEnabled, pairTabs } from '@/lib/focus-flip';
import { isReplayInProgress } from '@/lib/macro-run-channel';
import { normalizeUrl } from '@/lib/normalize';
import { isPaused } from '@/lib/privacy';
import type { FlipPair } from '@/lib/types';
import { IconButton } from './ui';

interface OpenTab {
  id: number;
  title: string;
  url: string;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function DelaySlider({ label, hint, value, storageKey }: { label: string; hint: string; value: number; storageKey: string }) {
  return (
    <label className="slider-row" title={hint}>
      <span className="slider-label">{label}</span>
      <input
        type="range"
        min={FLIP_DELAY_MIN_MS}
        max={FLIP_DELAY_MAX_MS}
        step={FLIP_DELAY_STEP_MS}
        value={value}
        aria-label={`${label}: ${seconds(value)}`}
        onChange={(e) => chrome.storage.local.set({ [storageKey]: Number(e.target.value) })}
      />
      <span className="slider-value">{seconds(value)}</span>
    </label>
  );
}

export function FocusFlipSection() {
  const [enabled, setEnabled] = useState(false);
  const [pairs, setPairs] = useState<FlipPair[]>([]);
  const [delays, setDelays] = useState<FlipDelays>({ writeMs: 1500, readMs: 1500 });
  const [status, setStatus] = useState<FlipStatus>({ state: 'off', label: 'Focus Flip: off' });
  const [current, setCurrent] = useState<OpenTab | null>(null);
  const [others, setOthers] = useState<OpenTab[]>([]);
  const [pick, setPick] = useState('');
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    const [on, allPairs, d, appPaused, replaying] = await Promise.all([
      isFocusFlipEnabled(),
      getFlipPairs(),
      getFlipDelays(),
      isPaused(),
      isReplayInProgress(),
    ]);
    setEnabled(on);
    setPairs(allPairs);
    setDelays(d);

    // The panel has its own window focus, so "current tab" means the active tab of the browser window.
    const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
    const usable: OpenTab[] = tabs.flatMap((t) =>
      t.id !== undefined && !t.incognito && normalizeUrl(t.url) ? [{ id: t.id, title: t.title || t.url || '', url: t.url! }] : [],
    );
    const activeTab = active?.id !== undefined ? usable.find((t) => t.id === active.id) ?? null : null;
    setCurrent(activeTab);
    setOthers(usable.filter((t) => t.id !== activeTab?.id));
    setStatus(
      flipStatus({
        enabled: on,
        appPaused,
        replaying,
        activeUrl: activeTab ? normalizeUrl(activeTab.url)?.url : undefined,
        pairs: allPairs,
      }),
    );
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1500);
    const onChanged = () => refresh();
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      clearInterval(interval);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [refresh]);

  const toggle = async (checked: boolean) => {
    setEnabled(checked);
    await chrome.storage.local.set({ [FOCUS_FLIP_KEY]: checked });
    await refresh();
  };

  const pairNow = async () => {
    if (!current || !pick) return;
    const result = await pairTabs(current.id, Number(pick));
    setMessage(result.ok ? `Paired. Type in this tab, pause, and ctrl-flow flips to ${siteLabel(others.find((t) => t.id === Number(pick))?.url ?? '')}.` : result.reason);
    if (result.ok) setPick('');
    await refresh();
  };

  const remove = async (id: number | undefined) => {
    if (id === undefined) return;
    await deleteFlipPair(id);
    await refresh();
  };

  return (
    <div className="settings-block focus-flip">
      <label className="settings-row checkbox-row">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        <span>Flip between my writing tab and reference tab</span>
      </label>

      <div className={`flip-status ${status.state}`} role="status">
        <span className="flip-dot" />
        {status.label}
      </div>

      <p className="settings-hint">
        Even while this is off, ctrl-flow counts tab switches and whether you typed in a tab (never what you type) so it can offer to turn
        Focus Flip on when it spots a writing and reference pair. Nothing flips until you turn it on.
      </p>

      <DelaySlider
        label="Flip to reference after typing stops"
        hint="How long you stop typing in the writing tab before ctrl-flow flips to the reference tab."
        value={delays.writeMs}
        storageKey={FLIP_WRITE_DELAY_KEY}
      />
      <DelaySlider
        label="Flip back after scrolling stops"
        hint="How long you stop scrolling or clicking in the reference tab before ctrl-flow flips back."
        value={delays.readMs}
        storageKey={FLIP_READ_DELAY_KEY}
      />

      <div className="sub-title">Pair the current tab</div>
      {current ? (
        <div className="pair-row">
          <span className="pair-current" title={current.title}>
            {current.title || siteLabel(current.url)}
          </span>
          <span className="meta">↔</span>
          <select value={pick} aria-label="Pair current tab with" onChange={(e) => setPick(e.target.value)}>
            <option value="">Pair with…</option>
            {others.map((t) => (
              <option key={t.id} value={t.id}>
                {(t.title || siteLabel(t.url)).slice(0, 48)}
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={!pick} onClick={pairNow}>
            Pair
          </button>
        </div>
      ) : (
        <div className="hint">Open the tab you write in, then come back here.</div>
      )}
      {message && <div className="hint">{message}</div>}

      {pairs.length === 0 ? (
        <div className="empty">
          No pairs yet. Pair two tabs above, or switch between a writing tab and a reference tab a few times while typing.
        </div>
      ) : (
        <ul className="step-list flush">
          {pairs.map((p) => (
            <li key={p.id}>
              <span className="step-title" title={`${p.writingUrl} ↔ ${p.referenceUrl}`}>
                {siteLabel(p.writingUrl)} ↔ {siteLabel(p.referenceUrl)}
              </span>
              <span className="chip">{p.active ? (p.manual ? 'manual' : 'learned') : 'learning'}</span>
              <IconButton icon="close" label="Remove pair" onClick={() => remove(p.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
