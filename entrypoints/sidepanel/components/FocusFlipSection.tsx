import { useCallback, useEffect, useState } from 'react';
import { deleteFlipPair, getFlipPairs } from '@/lib/db';
import { FOCUS_FLIP_KEY, cancelFlip, getFlipState, isFocusFlipEnabled, type FlipState } from '@/lib/focus-flip';
import { learnedDwellMs, learnedPauseMs } from '@/lib/flip-learning';
import type { FlipPair } from '@/lib/types';

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    const text = `${u.hostname}${path}`;
    return text.length > 38 ? `${text.slice(0, 37)}…` : text;
  } catch {
    return url;
  }
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

export function FocusFlipSection() {
  const [enabled, setEnabled] = useState(false);
  const [pairs, setPairs] = useState<FlipPair[]>([]);
  const [flip, setFlip] = useState<FlipState | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    const [e, p, f] = await Promise.all([isFocusFlipEnabled(), getFlipPairs(), getFlipState()]);
    setEnabled(e);
    setPairs(p);
    setFlip(f);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1500);
    const tick = setInterval(() => setNow(Date.now()), 250);
    const onChanged = () => refresh();
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      clearInterval(interval);
      clearInterval(tick);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [refresh]);

  const toggle = async (checked: boolean) => {
    setEnabled(checked);
    await chrome.storage.local.set({ [FOCUS_FLIP_KEY]: checked });
    await refresh();
  };

  const stay = async () => {
    await cancelFlip();
    await refresh();
  };

  const remove = async (id: number | undefined) => {
    if (id === undefined) return;
    await deleteFlipPair(id);
    await refresh();
  };

  const secondsLeft = flip ? Math.max(0, Math.ceil((flip.returnAt - now) / 1000)) : 0;

  return (
    <div className="settings-block focus-flip">
      <label className="settings-row checkbox-row">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        <span>Flip to my reference tab when I pause typing</span>
      </label>

      {flip && enabled && (
        <div className="notice flip-indicator">
          Flipping back in {secondsLeft}s ·{' '}
          <button className="btn btn-link" onClick={stay}>
            Stay here
          </button>
        </div>
      )}

      {enabled && pairs.length === 0 && (
        <div className="empty">No pairs yet. Switch between a writing tab and a reference tab a few times while typing.</div>
      )}
      {pairs.length > 0 && (
        <ul className="flip-pairs">
          {pairs.map((p) => (
            <li key={p.id}>
              <span className="tab-title" title={`${p.writingUrl} ⇄ ${p.referenceUrl}`}>
                {shortUrl(p.writingUrl)} ⇄ {shortUrl(p.referenceUrl)}
              </span>
              <span className="doc-seen">
                {p.active ? 'active' : 'learning'} · pause {seconds(learnedPauseMs(p))} · dwell {seconds(learnedDwellMs(p))}
              </span>
              <button className="btn btn-remove" onClick={() => remove(p.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
