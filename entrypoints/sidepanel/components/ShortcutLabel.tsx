import { useCallback, useEffect, useState } from 'react';
import { SHORTCUTS_PAGE, formatShortcut, getCommandShortcut, type ShortcutLabel as Label } from '@/lib/shortcuts';

/** The live binding of a manifest command, re-read when the user comes back from chrome://extensions/shortcuts. */
export function useCommandShortcut(name: string): Label {
  const [label, setLabel] = useState<Label>(formatShortcut(undefined));
  const refresh = useCallback(() => {
    getCommandShortcut(name).then(setLabel);
  }, [name]);

  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refresh]);

  return label;
}

export function openShortcutSettings(): void {
  chrome.tabs.create({ url: SHORTCUTS_PAGE }).catch(() => undefined);
}

/** "Not set" plus a button to fix it, or the key cap. No truncation: it wraps. */
export function ShortcutLabel({ command }: { command: string }) {
  const { set, text } = useCommandShortcut(command);
  return set ? (
    <kbd className="letter-kbd">{text}</kbd>
  ) : (
    <span className="shortcut-unset">
      {text}{' '}
      <button className="btn" onClick={openShortcutSettings}>
        Open shortcut settings
      </button>
    </span>
  );
}
