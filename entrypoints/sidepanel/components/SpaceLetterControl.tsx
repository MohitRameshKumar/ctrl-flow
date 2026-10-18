import { useCallback, useEffect, useState } from 'react';
import { suggestLetter } from '@/lib/hotkeys';
import { getMacroLetters, getSpaceLetters, setMacroLetter, setSpaceLetter, takenLetters } from '@/lib/leader';

/**
 * HOT-4: assign a free leader-key letter to a saved space (Leader + letter = project switch) or,
 * with `kind="macro"`, to a saved macro (Leader + letter = run it). `spaceId` is the row's id either way.
 */
export function SpaceLetterControl({ spaceId, name, kind = 'space' }: { spaceId: number; name: string; kind?: 'space' | 'macro' }) {
  const ownerId = `${kind}:${spaceId}`;
  const assignLetter = kind === 'macro' ? setMacroLetter : setSpaceLetter;
  const [letter, setLetter] = useState('');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    // Letters live on the macro / space row (Dexie), so read them from there.
    const mine =
      kind === 'macro'
        ? ((await getMacroLetters()).find((m) => m.macroId === spaceId)?.letter ?? '')
        : ((await getSpaceLetters()).find((s) => s.spaceId === spaceId)?.letter ?? '');
    setLetter(mine);
    setSuggestion(suggestLetter(name, await takenLetters(ownerId)));
  }, [spaceId, name, kind, ownerId]);

  useEffect(() => {
    refresh();
    const onChanged = () => refresh();
    chrome.storage.onChanged.addListener(onChanged);
    const interval = setInterval(refresh, 3000); // row changes don't fire storage events
    return () => {
      chrome.storage.onChanged.removeListener(onChanged);
      clearInterval(interval);
    };
  }, [refresh]);

  const assign = async (value: string) => {
    const result = await assignLetter(spaceId, value);
    setError(result.ok ? '' : result.reason);
    if (result.ok) setDraft('');
    await refresh();
  };

  return (
    <div className="space-letter">
      <span className="doc-seen">Leader key:</span>
      {letter ? (
        <>
          <kbd className="letter-kbd">{letter.toUpperCase()}</kbd>
          <button className="btn btn-remove" onClick={() => assign('')}>
            Clear
          </button>
        </>
      ) : (
        <>
          <input
            className="letter-input"
            maxLength={1}
            placeholder={suggestion ? suggestion.toUpperCase() : '–'}
            aria-label={`Leader letter for ${name}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="btn" disabled={!draft && !suggestion} onClick={() => assign(draft || suggestion || '')}>
            {kind === 'macro' ? 'Set letter' : 'Assign'}{!draft && suggestion ? ` ${suggestion.toUpperCase()}` : ''}
          </button>
        </>
      )}
      {error && <span className="letter-error">{error}</span>}
    </div>
  );
}
