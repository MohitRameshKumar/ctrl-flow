import { useCallback, useEffect, useState } from 'react';
import { suggestLetter } from '@/lib/hotkeys';
import { SPACE_LETTERS_KEY, setSpaceLetter, takenLetters } from '@/lib/leader';

/** HOT-4: assign a free leader-key letter to a saved space (Leader + letter = project switch). */
export function SpaceLetterControl({ spaceId, name }: { spaceId: number; name: string }) {
  const [letter, setLetter] = useState('');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const { [SPACE_LETTERS_KEY]: raw } = await chrome.storage.local.get<Record<string, Record<string, string> | undefined>>(SPACE_LETTERS_KEY);
    const mine = raw?.[String(spaceId)] ?? '';
    setLetter(mine);
    setSuggestion(suggestLetter(name, await takenLetters(`space:${spaceId}`)));
  }, [spaceId, name]);

  useEffect(() => {
    refresh();
    const onChanged = () => refresh();
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  const assign = async (value: string) => {
    const result = await setSpaceLetter(spaceId, value);
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
