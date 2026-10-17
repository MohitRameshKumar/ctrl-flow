import { useCallback, useEffect, useState } from 'react';
import { LEADER_COMMAND } from '@/lib/shortcuts';
import { ShortcutLabel } from './ShortcutLabel';
import { listRegistrations, type MenuItem, type SearchItem } from '@/lib/hotkeys';
import {
  LEADER_PANEL_KEY,
  getMenu,
  getSearchItems,
  registerBuiltinLeaders,
  setBuiltinLetter,
} from '@/lib/leader';

const FALLBACK_WINDOW_MS = 60_000;

/**
 * Settings → leader keys: change a built-in letter (HOT-1, conflicts rejected). When the leader
 * shortcut was pressed on a page the overlay can't run on (chrome://, Web Store), the background
 * opens the panel and this section shows the letter list, usable by clicking or typing a letter.
 */
export function LeaderKeysSection() {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [search, setSearch] = useState<SearchItem[]>([]);
  const [fallback, setFallback] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    registerBuiltinLeaders();
    setMenu(await getMenu());
    setSearch(await getSearchItems());
    const { [LEADER_PANEL_KEY]: at } = await chrome.storage.session.get<Record<string, number | undefined>>(LEADER_PANEL_KEY);
    setFallback(typeof at === 'number' && Date.now() - at < FALLBACK_WINDOW_MS);
  }, []);

  useEffect(() => {
    refresh();
    const onChanged = () => refresh();
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  const run = useCallback((letter: string) => {
    chrome.runtime.sendMessage({ type: 'leader_run', letter }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!fallback) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const item = menu.find((i) => i.letter === e.key.toLowerCase());
      if (item && item.id !== 'search') run(item.letter);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fallback, menu, run]);

  const change = async (id: string) => {
    const result = await setBuiltinLetter(id, drafts[id] ?? '');
    setError(result.ok ? '' : result.reason);
    if (result.ok) setDrafts((d) => ({ ...d, [id]: '' }));
    await refresh();
  };

  const matches = search.filter((s) => !query.trim() || s.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8);
  const builtins = listRegistrations();

  return (
    <section className={fallback ? 'settings leader-keys leader-fallback' : 'settings leader-keys'}>
      <h3>Leader keys</h3>
      <div className="doc-seen">
        Press the Cadence shortcut <ShortcutLabel command={LEADER_COMMAND} />, then a letter. Change it at
        chrome://extensions/shortcuts.
      </div>
      {fallback && <div className="notice">This page can&apos;t show the overlay. Click a letter below or type it.</div>}

      <ul className="leader-list">
        {menu.map((i) => (
          <li key={`${i.kind}-${i.id}`}>
            <button className="btn letter-btn" disabled={i.id === 'search'} onClick={() => run(i.letter)}>
              {i.letter.toUpperCase()}
            </button>
            <span>{i.label}</span>
          </li>
        ))}
      </ul>

      {fallback && (
        <div className="leader-search">
          <input placeholder="Search spaces, rituals & macros…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {matches.map((s) => (
            <button
              key={`${s.kind}-${s.id}`}
              className="btn btn-secondary"
              onClick={() => chrome.runtime.sendMessage({ type: 'leader_run_item', kind: s.kind, id: s.id }).catch(() => undefined)}
            >
              {s.kind === 'space' ? 'Space' : 'Ritual'}: {s.label}
            </button>
          ))}
        </div>
      )}

      <h4>Change a letter</h4>
      {builtins.map((b) => {
        const current = menu.find((i) => i.kind === 'action' && i.id === b.id)?.letter ?? b.letter;
        return (
          <label key={b.id} className="settings-row">
            <span>
              {b.label} ({current.toUpperCase()})
            </span>
            <span>
              <input
                className="letter-input"
                maxLength={1}
                aria-label={`New letter for ${b.label}`}
                value={drafts[b.id] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [b.id]: e.target.value }))}
              />
              <button className="btn" disabled={!drafts[b.id]} onClick={() => change(b.id)}>
                Set
              </button>
            </span>
          </label>
        );
      })}
      {error && <div className="letter-error">{error}</div>}
    </section>
  );
}

