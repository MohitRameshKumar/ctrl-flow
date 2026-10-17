// Background side of the leader key: built-in letters, saved-space letters, running a letter, and
// opening the overlay (or the side-panel fallback on pages content scripts can't run on).
import { getMacros, getRituals, getSpaces } from './db';
import { cancelFlip } from './focus-flip';
import {
  buildMenu,
  canHostOverlay,
  effectiveLetter,
  findMenuItem,
  listRegistrations,
  registerLeader,
  validateLetter,
  type Assignment,
  type LeaderContext,
  type LeaderShowMessage,
  type LetterCheck,
  type MacroLetter,
  type MenuItem,
  type SearchItem,
  type SpaceLetter,
} from './hotkeys';
import { keepLastAsMacro, repeatLastMacro, stopRunningMacro, toggleMark } from './macro-leaders';
import { runMacro } from './macros';
import { openRitualDocs } from './rituals';
import { switchToSpace } from './spaces';

export const LEADER_OVERRIDES_KEY = 'leaderLetters';
export const SPACE_LETTERS_KEY = 'spaceLetters';
export const MACRO_LETTERS_KEY = 'macroLetters';
/** Set when the leader key had to fall back to the side panel; the panel highlights the letter list. */
export const LEADER_PANEL_KEY = 'leaderPanelAt';

let builtinsRegistered = false;
/** Idempotent. Features that want a letter call `registerLeader` from lib/hotkeys.ts themselves. */
export function registerBuiltinLeaders(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  // chrome.sidePanel.open() needs a user gesture that a letter relayed from the overlay does not carry
  // (the overlay itself shows "Click the Cadence icon"). This run() only matters from non-overlay
  // callers, which get the same instruction as a notification.
  registerLeader({
    id: 'open_panel',
    letter: 'e',
    label: 'Open side panel (click the icon)',
    run: async () => {
      await chrome.notifications.create(`cadence-leader:panel-${Date.now()}`, {
        type: 'basic',
        iconUrl: '/icon/128.png',
        title: 'Cadence',
        message: 'Click the Cadence icon in the toolbar to open the panel.',
      });
    },
  });
  registerLeader({
    id: 'stop',
    letter: 's',
    label: 'Stop what Cadence is doing',
    run: async () => {
      await cancelFlip(); // a Focus Flip in progress
      await stopRunningMacro(); // a macro replay in progress
    },
  });
  // Repeat-to-Macro owns R / K / M (reserved in hotkeys.ts).
  registerLeader({ id: 'macro-repeat', letter: 'r', label: 'Repeat last action (else last macro)', run: repeatLastMacro, allowReserved: true });
  registerLeader({ id: 'macro-keep', letter: 'k', label: 'Keep last action as a macro', run: keepLastAsMacro, allowReserved: true });
  registerLeader({ id: 'macro-mark', letter: 'm', label: 'Mark macro start / end', run: toggleMark, allowReserved: true });
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
  registerLeader({ id: 'search', letter: '/', label: 'Search spaces, rituals & macros', run: () => undefined });
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

async function getRawMacroLetters(): Promise<Record<string, string>> {
  const { [MACRO_LETTERS_KEY]: o } = await chrome.storage.local.get<Record<string, Record<string, string> | undefined>>(MACRO_LETTERS_KEY);
  return o ?? {};
}

/** Letters assigned to saved macros; entries for macros that no longer exist, or were rejected, are ignored. */
export async function getMacroLetters(): Promise<MacroLetter[]> {
  const [raw, macros] = await Promise.all([getRawMacroLetters(), getMacros()]);
  return macros.flatMap((m) =>
    m.id !== undefined && m.status !== 'never' && raw[String(m.id)] ? [{ macroId: m.id, name: m.name, letter: raw[String(m.id)]! }] : [],
  );
}

async function allAssignments(): Promise<Assignment[]> {
  registerBuiltinLeaders();
  const [overrides, spaceLetters, macroLetters] = await Promise.all([getLetterOverrides(), getSpaceLetters(), getMacroLetters()]);
  return [
    ...listRegistrations().map((r) => ({ id: r.id, letter: effectiveLetter(r, overrides) })),
    ...spaceLetters.map((s) => ({ id: `space:${s.spaceId}`, letter: s.letter })),
    ...macroLetters.map((m) => ({ id: `macro:${m.macroId}`, letter: m.letter })),
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

/** Same as `setSpaceLetter`, for a saved macro. R / K / M stay reserved for the macro actions themselves. */
export async function setMacroLetter(macroId: number, letter: string | null): Promise<LetterCheck> {
  const raw = await getRawMacroLetters();
  if (letter === null || letter.trim() === '') {
    delete raw[String(macroId)];
    await chrome.storage.local.set({ [MACRO_LETTERS_KEY]: raw });
    return { ok: true, letter: '' };
  }
  const check = validateLetter(letter, `macro:${macroId}`, await allAssignments(), { allowSlash: false });
  if (check.ok) {
    raw[String(macroId)] = check.letter;
    await chrome.storage.local.set({ [MACRO_LETTERS_KEY]: raw });
  }
  return check;
}

/** HOT-1: change a built-in letter. */
export async function setBuiltinLetter(id: string, letter: string): Promise<LetterCheck> {
  // The macro actions own R / K / M, so moving one away must be reversible.
  const check = validateLetter(letter, id, await allAssignments(), { allowReserved: id.startsWith('macro-') });
  if (check.ok) {
    const overrides = await getLetterOverrides();
    overrides[id] = check.letter;
    await chrome.storage.local.set({ [LEADER_OVERRIDES_KEY]: overrides });
  }
  return check;
}

export async function getMenu(): Promise<MenuItem[]> {
  registerBuiltinLeaders();
  return buildMenu(listRegistrations(), await getLetterOverrides(), await getSpaceLetters(), await getMacroLetters());
}

export async function getSearchItems(): Promise<SearchItem[]> {
  const [spaces, rituals, macros] = await Promise.all([getSpaces(), getRituals(), getMacros()]);
  return [
    ...spaces.flatMap((s) => (s.id !== undefined ? [{ kind: 'space' as const, id: s.id, label: s.name }] : [])),
    ...rituals.flatMap((r) => (r.id !== undefined && r.status !== 'never' ? [{ kind: 'ritual' as const, id: r.id, label: r.title }] : [])),
    // Reachable here so the macro palette needs no shortcut of its own.
    ...macros.flatMap((m) =>
      m.id !== undefined && (m.status === 'accepted' || m.status === 'auto') ? [{ kind: 'macro' as const, id: m.id, label: `Macro: ${m.name}` }] : [],
    ),
  ];
}

/** Runs the entry on `letter`. */
export async function runLeaderLetter(letter: string, ctx: LeaderContext): Promise<boolean> {
  const item = findMenuItem(await getMenu(), letter);
  if (!item) return false;
  if (item.kind === 'macro') {
    await runMacro(Number(item.id));
    return true;
  }
  if (item.kind === 'space') {
    await switchToSpace(Number(item.id));
    return true;
  }
  const reg = listRegistrations().find((r) => r.id === item.id);
  if (!reg) return false;
  await reg.run(ctx);
  return true;
}

export async function runSearchItem(kind: 'space' | 'ritual' | 'macro', id: number): Promise<void> {
  if (kind === 'macro') {
    await runMacro(id);
    return;
  }
  if (kind === 'space') {
    await switchToSpace(id);
    return;
  }
  const ritual = (await getRituals()).find((r) => r.id === id);
  if (ritual) await openRitualDocs(ritual);
}

/**
 * Opens the side panel straight from the shortcut's user gesture. Everything before the `open()`
 * call is synchronous: a single `await` first (a DB read, a message round-trip) spends the gesture
 * and Chrome throws "sidePanel.open() may only be called in response to a user gesture".
 */
function openPanelInGesture(tab?: chrome.tabs.Tab): void {
  const opening =
    tab?.id !== undefined
      ? chrome.sidePanel.open({ tabId: tab.id })
      : tab?.windowId !== undefined
        ? chrome.sidePanel.open({ windowId: tab.windowId })
        : null;
  if (!opening) {
    console.warn('[cadence] leader key fired with no tab to open the panel on');
    return;
  }
  opening.catch((err) => console.error('[cadence] sidePanel.open failed', err));
  chrome.storage.session.set({ [LEADER_PANEL_KEY]: Date.now() }).catch(() => undefined);
}

async function notifyLeaderUnavailable(): Promise<void> {
  await chrome.notifications
    .create(`cadence-leader:unavailable-${Date.now()}`, {
      type: 'basic',
      iconUrl: '/icon/128.png',
      title: 'Leader key unavailable on this page',
      message: 'Reload the tab and try again, or click the Cadence icon.',
    })
    .catch(() => undefined);
}

/** Shows the overlay; if the page's content script is missing or stale, injects it once and retries. */
async function showOverlay(tab: chrome.tabs.Tab & { id: number }): Promise<void> {
  const message: LeaderShowMessage = { type: 'leader_show', items: await getMenu(), search: await getSearchItems() };
  const send = () => chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  try {
    await send();
    return;
  } catch {
    // no listener: the tab predates this build of the extension, or the script was orphaned by a reload
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-scripts/leader.js'] });
    await send();
  } catch (err) {
    // Deliberately no sidePanel.open() here: the gesture is long gone after these awaits.
    console.warn('[cadence] leader overlay could not be shown', err);
    await notifyLeaderUnavailable();
  }
}

/**
 * The leader shortcut was pressed (call synchronously from `commands.onCommand`). The overlay-or-panel
 * decision is made from `tab.url` alone, so the panel opens inside the gesture when the page can't
 * host the overlay (chrome://, the Web Store, the new-tab page).
 */
export function handleLeaderCommand(tab?: chrome.tabs.Tab): void {
  if (!tab || tab.id === undefined || !canHostOverlay(tab.url)) {
    openPanelInGesture(tab);
    return;
  }
  showOverlay({ ...tab, id: tab.id }).catch((err) => console.error('[cadence] leader key failed', err));
}
