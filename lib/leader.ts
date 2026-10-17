// Background side of the leader key: built-in letters, saved-space letters, running a letter, and
// opening the overlay (or the side-panel fallback on pages content scripts can't run on).
import { getRituals, getSpaces } from './db';
import { cancelFlip } from './focus-flip';
import {
  buildMenu,
  effectiveLetter,
  findMenuItem,
  listRegistrations,
  registerLeader,
  validateLetter,
  type Assignment,
  type LeaderContext,
  type LeaderShowMessage,
  type LetterCheck,
  type MenuItem,
  type SearchItem,
  type SpaceLetter,
} from './hotkeys';
import { openRitualDocs } from './rituals';
import { switchToSpace } from './spaces';

export const LEADER_OVERRIDES_KEY = 'leaderLetters';
export const SPACE_LETTERS_KEY = 'spaceLetters';
/** Set when the leader key had to fall back to the side panel; the panel highlights the letter list. */
export const LEADER_PANEL_KEY = 'leaderPanelAt';

async function openSidePanel(ctx: LeaderContext): Promise<void> {
  if (ctx.tabId !== undefined) await chrome.sidePanel.open({ tabId: ctx.tabId });
  else if (ctx.windowId !== undefined) await chrome.sidePanel.open({ windowId: ctx.windowId });
  else {
    const win = await chrome.windows.getLastFocused();
    if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id });
  }
}

let builtinsRegistered = false;
/** Idempotent. Features that want a letter call `registerLeader` from lib/hotkeys.ts themselves. */
export function registerBuiltinLeaders(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  registerLeader({ id: 'open_panel', letter: 'e', label: 'Open side panel', run: openSidePanel });
  registerLeader({
    id: 'stop',
    letter: 's',
    label: 'Stop what Cadence is doing',
    run: async () => {
      await cancelFlip(); // cancels a Focus Flip in progress; nothing else runs long yet
    },
  });
  registerLeader({
    id: 'pause',
    letter: 'p',
    label: 'Pause / resume recording',
    run: async () => {
      const { paused } = await chrome.storage.local.get<{ paused?: boolean }>('paused');
      await chrome.storage.local.set({ paused: paused !== true });
    },
  });
  // Handled inside the overlay (it switches to a search list); a no-op if run from elsewhere.
  registerLeader({ id: 'search', letter: '/', label: 'Search spaces & rituals', run: () => undefined });
}

export async function getLetterOverrides(): Promise<Record<string, string>> {
  const { [LEADER_OVERRIDES_KEY]: o } = await chrome.storage.local.get<Record<string, Record<string, string> | undefined>>(LEADER_OVERRIDES_KEY);
  return o ?? {};
}

async function getRawSpaceLetters(): Promise<Record<string, string>> {
  const { [SPACE_LETTERS_KEY]: o } = await chrome.storage.local.get<Record<string, Record<string, string> | undefined>>(SPACE_LETTERS_KEY);
  return o ?? {};
}

/** Letters assigned to saved spaces; entries for spaces that no longer exist are ignored. */
export async function getSpaceLetters(): Promise<SpaceLetter[]> {
  const [raw, spaces] = await Promise.all([getRawSpaceLetters(), getSpaces()]);
  return spaces.flatMap((s) => (s.id !== undefined && raw[String(s.id)] ? [{ spaceId: s.id, name: s.name, letter: raw[String(s.id)]! }] : []));
}

async function allAssignments(): Promise<Assignment[]> {
  registerBuiltinLeaders();
  const [overrides, spaceLetters] = await Promise.all([getLetterOverrides(), getSpaceLetters()]);
  return [
    ...listRegistrations().map((r) => ({ id: r.id, letter: effectiveLetter(r, overrides) })),
    ...spaceLetters.map((s) => ({ id: `space:${s.spaceId}`, letter: s.letter })),
  ];
}

export async function takenLetters(excludeOwner?: string): Promise<string[]> {
  return (await allAssignments()).filter((a) => a.id !== excludeOwner).map((a) => a.letter);
}

/** Assign (or clear, with null) a saved space's letter. Conflicts and reserved letters are rejected. */
export async function setSpaceLetter(spaceId: number, letter: string | null): Promise<LetterCheck> {
  const raw = await getRawSpaceLetters();
  if (letter === null || letter.trim() === '') {
    delete raw[String(spaceId)];
    await chrome.storage.local.set({ [SPACE_LETTERS_KEY]: raw });
    return { ok: true, letter: '' };
  }
  const check = validateLetter(letter, `space:${spaceId}`, await allAssignments(), { allowSlash: false });
  if (check.ok) {
    raw[String(spaceId)] = check.letter;
    await chrome.storage.local.set({ [SPACE_LETTERS_KEY]: raw });
  }
  return check;
}

/** HOT-1: change a built-in letter. */
export async function setBuiltinLetter(id: string, letter: string): Promise<LetterCheck> {
  const check = validateLetter(letter, id, await allAssignments());
  if (check.ok) {
    const overrides = await getLetterOverrides();
    overrides[id] = check.letter;
    await chrome.storage.local.set({ [LEADER_OVERRIDES_KEY]: overrides });
  }
  return check;
}

export async function getMenu(): Promise<MenuItem[]> {
  registerBuiltinLeaders();
  return buildMenu(listRegistrations(), await getLetterOverrides(), await getSpaceLetters());
}

export async function getSearchItems(): Promise<SearchItem[]> {
  const [spaces, rituals] = await Promise.all([getSpaces(), getRituals()]);
  return [
    ...spaces.flatMap((s) => (s.id !== undefined ? [{ kind: 'space' as const, id: s.id, label: s.name }] : [])),
    ...rituals.flatMap((r) => (r.id !== undefined && r.status !== 'never' ? [{ kind: 'ritual' as const, id: r.id, label: r.title }] : [])),
  ];
}

/** Runs the entry on `letter`. Reserved "coming soon" letters (R/K/M until the macro feature registers) do nothing. */
export async function runLeaderLetter(letter: string, ctx: LeaderContext): Promise<boolean> {
  const item = findMenuItem(await getMenu(), letter);
  if (!item || item.comingSoon) return false;
  if (item.kind === 'space') {
    await switchToSpace(Number(item.id));
    return true;
  }
  const reg = listRegistrations().find((r) => r.id === item.id);
  if (!reg) return false;
  await reg.run(ctx);
  return true;
}

export async function runSearchItem(kind: 'space' | 'ritual', id: number): Promise<void> {
  if (kind === 'space') {
    await switchToSpace(id);
    return;
  }
  const ritual = (await getRituals()).find((r) => r.id === id);
  if (ritual) await openRitualDocs(ritual);
}

/**
 * The leader shortcut was pressed. Shows the overlay in the page; on pages where content scripts
 * can't run (chrome://, the Web Store, the new-tab page) opens the side panel with the letter list.
 */
export async function openLeader(tab?: chrome.tabs.Tab): Promise<'overlay' | 'panel'> {
  const target = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const message: LeaderShowMessage = { type: 'leader_show', items: await getMenu(), search: await getSearchItems() };

  if (target?.id !== undefined) {
    try {
      await chrome.tabs.sendMessage(target.id, message, { frameId: 0 });
      return 'overlay';
    } catch {
      // no content script in this tab: fall through to the panel
    }
  }

  await chrome.storage.session.set({ [LEADER_PANEL_KEY]: Date.now() });
  await openSidePanel({ tabId: target?.id, windowId: target?.windowId });
  return 'panel';
}
