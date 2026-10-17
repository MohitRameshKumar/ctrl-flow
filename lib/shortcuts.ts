// Reading and labelling the user's real command bindings. Chrome owns the binding (the manifest
// default is only a suggestion), so the UI must ask `chrome.commands.getAll()` rather than hard-code text.
export const LEADER_COMMAND = 'leader-key';
export const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';

export interface ShortcutLabel {
  set: boolean;
  /** The binding as Chrome reports it ("⌘⇧Y" / "Ctrl+Shift+Y"), or the call to action when unset. */
  text: string;
}

export function formatShortcut(shortcut: string | undefined | null): ShortcutLabel {
  const trimmed = (shortcut ?? '').trim();
  return trimmed
    ? { set: true, text: trimmed }
    : { set: false, text: 'Not set: set it in chrome://extensions/shortcuts' };
}

export async function getCommandShortcut(name: string): Promise<ShortcutLabel> {
  try {
    const commands = await chrome.commands.getAll();
    return formatShortcut(commands.find((c) => c.name === name)?.shortcut);
  } catch {
    return formatShortcut(undefined);
  }
}
