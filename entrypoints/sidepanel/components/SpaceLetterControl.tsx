import { useCallback, useEffect, useState } from 'react';
import { suggestLetter } from '@/lib/hotkeys';
import { MACRO_LETTERS_KEY, SPACE_LETTERS_KEY, setMacroLetter, setSpaceLetter, takenLetters } from '@/lib/leader';

/**
 * HOT-4: assign a free leader-key letter to a saved space (Leader + letter = project switch) or,
 * with `kind="macro"`, to a saved macro (Leader + letter = run it). `spaceId` is the row's id either way.
 */
export function SpaceLetterControl({ spaceId, name, kind = 'space' }: { spaceId: number; name: string; kind?: 'space' | 'macro' }) {
  const storageKey = kind === 'macro' ? MACRO_LETTERS_KEY : SPACE_LETTERS_KEY;
  const ownerId = `${kind}:${spaceId}`;
  const assignLetter = kind === 'macro' ? setMacroLetter : setSpaceLetter;
  const [letter, setLetter] = useState('');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const { [storageKey]: raw } = await chrome.storage.local.get<Record<string, Record<string, string> | undefined>>(storageKey);
    const mine = raw?.[String(spaceId)] ?? '';
    setLetter(mine);
    setSuggestion(suggestLetter(name, await takenLetters(ownerId)));
  }, [spaceId, name, storageKey, ownerId]);

  useEffect(() => {
    refresh();
    const onChanged = () => refresh();
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
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
            Assign{!draft && suggestion ? ` ${suggestion.toUpperCase()}` : ''}
          </button>
        </>
      )}
      {error && <span className="letter-error">{error}</span>}
    </div>
  );
}
