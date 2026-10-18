// Background side of the leader key: built-in letters, saved-space letters, running a letter, and
// opening the overlay (or the side-panel fallback on pages content scripts can't run on).
import { getMacros, getRituals, getSpaces, setMacroLetterRow, setSpaceLetterRow } from './db';
import { cancelFlip } from './focus-flip';
import {
  buildMenu,
  canHostOverlay,
  effectiveLetter,
  findMenuItem,
  planLetterCleanup,
  listRegistrations,
  registerLeader,
  suggestLetter,
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
import {
  LEADER_NOTIFICATION_PREFIX,
  handleLeaderNotificationButtonClicked,
  keepLastAsMacro,
  repeatLastMacro,
  setAfterSaveHook,
  stopRunningMacro,
  toggleMark,
} from './macro-leaders';
import { runMacro } from './macros';
import { openRitualDocs } from './rituals';
import type { Macro } from './types';
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
  setAfterSaveHook(offerMacroLetter);
  // chrome.sidePanel.open() needs a user gesture that a letter relayed from the overlay does not carry
  // (the overlay itself shows "Click the Cadence icon"). This run() only matters from non-overlay
  // callers, which get the same instruction as a notification.
  registerLeader({
    id: 'open_panel',
    letter: 'e',
    label: 'Open side panel (click the icon)',
    short: 'Panel',
    description: 'Open the ctrl-flow panel (click the toolbar icon)',
    run: async () => {
      await chrome.notifications.create(`cadence-leader:panel-${Date.now()}`, {
        type: 'basic',
        iconUrl: '/icon/128.png',
        title: 'ctrl-flow',
        message: 'Click the ctrl-flow icon in the toolbar to open the panel.',
      });
    },
  });
  registerLeader({
    id: 'stop',
    letter: 's',
    label: 'Stop what ctrl-flow is doing',
    short: 'Stop',
    description: 'Stop a running macro or Focus Flip',
    run: async () => {
      await cancelFlip(); // a Focus Flip in progress
      await stopRunningMacro(); // a macro replay in progress
    },
  });
  // Repeat-to-Macro owns R / K / M (reserved in hotkeys.ts).
  registerLeader({ id: 'macro-repeat', letter: 'r', label: 'Repeat last action (else last macro)', short: 'Repeat', description: 'Repeat what you just did, with a preview first', run: repeatLastMacro, allowReserved: true });
  registerLeader({ id: 'macro-keep', letter: 'k', label: 'Keep last action as a macro', short: 'Keep', description: 'Save what you just did as a macro', run: keepLastAsMacro, allowReserved: true });
  registerLeader({ id: 'macro-mark', letter: 'm', label: 'Mark macro start / end', short: 'Mark', description: 'Press once to start, again to save everything since', run: toggleMark, allowReserved: true });
  registerLeader({
    id: 'pause',
    letter: 'p',
    label: 'Pause / resume recording',
    short: 'Pause',
    description: 'Pause or resume recording your activity',
    run: async () => {
      const { paused } = await chrome.storage.local.get<{ paused?: boolean }>('paused');
      await chrome.storage.local.set({ paused: paused !== true });
    },
  });
  // Handled inside the overlay (it switches to a search list); a no-op if run from elsewhere.
  registerLeader({ id: 'search', letter: '/', label: 'Search spaces, rituals & macros', short: 'Search', description: 'Search spaces, rituals and macros', run: () => undefined });
}

export async function getLetterOverrides(): Promise<Record<string, string>> {
  const { [LEADER_OVERRIDES_KEY]: o } = await chrome.storage.local.get<Record<string, Record<string, string> | undefined>>(LEADER_OVERRIDES_KEY);
  return o ?? {};
}

/** Pre-persisted-on-row storage; read once by `syncLetters` and then cleared. */
const LEGACY_KEYS = [SPACE_LETTERS_KEY, MACRO_LETTERS_KEY] as const;

/** Letters assigned to saved spaces. They live on the space row, so a letter cannot outlive or miss its space. */
export async function getSpaceLetters(): Promise<SpaceLetter[]> {
  return (await getSpaces()).flatMap((s) => (s.id !== undefined && s.letter ? [{ spaceId: s.id, name: s.name, letter: s.letter }] : []));
}

/** Letters assigned to saved macros (rejected ones excluded). They live on the macro row. */
export async function getMacroLetters(): Promise<MacroLetter[]> {
  return (await getMacros()).flatMap((m) =>
    m.id !== undefined && m.status !== 'never' && m.letter ? [{ macroId: m.id, name: m.name, letter: m.letter }] : [],
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

/** After a macro is saved (R, K, M): offer the first free letter of its name with a one-click confirm. */
export async function offerMacroLetter(macro: Macro): Promise<void> {
  if (macro.letter || macro.id === undefined) return;
  const letter = suggestLetter(macro.name, await takenLetters());
  if (!letter) return;
  const L = letter.toUpperCase();
  await chrome.notifications
    .create(`${LEADER_NOTIFICATION_PREFIX}letter:${macro.id}:${letter}`, {
      type: 'basic',
      iconUrl: '/icon/128.png',
      title: `Assign letter ${L}?`,
      message: `Leader + ${L} will run "${macro.name}".`,
      buttons: [{ title: `Assign ${L}` }, { title: 'Skip' }],
    })
    .catch(() => undefined);
}

/** Notification buttons for everything under `cadence-leader:`. */
export async function routeLeaderNotification(notificationId: string, buttonIndex: number): Promise<void> {
  const m = new RegExp(`^${LEADER_NOTIFICATION_PREFIX}letter:(\\d+):([a-z0-9])$`).exec(notificationId);
  if (m) {
    if (buttonIndex === 0) {
      const check = await setMacroLetter(Number(m[1]), m[2]!);
      if (!check.ok) await notifyLeaderFailure('Could not assign letter', check.reason);
    }
    await chrome.notifications.clear(notificationId).catch(() => undefined);
    return;
  }
  await handleLeaderNotificationButtonClicked(notificationId, buttonIndex);
}

export async function takenLetters(excludeOwner?: string): Promise<string[]> {
  return (await allAssignments()).filter((a) => a.id !== excludeOwner).map((a) => a.letter);
}

/** Assign (or clear, with null) a saved space's letter. Conflicts and reserved letters are rejected. */
export async function setSpaceLetter(spaceId: number, letter: string | null): Promise<LetterCheck> {
  if (letter === null || letter.trim() === '') {
    await setSpaceLetterRow(spaceId, null);
    return { ok: true, letter: '' };
  }
  const check = validateLetter(letter, `space:${spaceId}`, await allAssignments(), { allowSlash: false });
  if (check.ok) await setSpaceLetterRow(spaceId, check.letter);
  return check;
}

/** Same as `setSpaceLetter`, for a saved macro. R / K / M stay reserved for the macro actions themselves. */
export async function setMacroLetter(macroId: number, letter: string | null): Promise<LetterCheck> {
  if (letter === null || letter.trim() === '') {
    await setMacroLetterRow(macroId, null);
    return { ok: true, letter: '' };
  }
  const check = validateLetter(letter, `macro:${macroId}`, await allAssignments(), { allowSlash: false });
  if (check.ok) await setMacroLetterRow(macroId, check.letter);
  return check;
}

/**
 * Run on every service-worker start (and install): moves letters saved by earlier builds from storage
 * onto their rows, then clears any letter that is now invalid, reserved or duplicated, so the menu
 * can never contain two owners for one key. Cheap and idempotent. The menu itself is rebuilt from
 * the rows each time it opens, so there is no in-memory registry for macro/space letters to go stale.
 */
export async function syncLetters(): Promise<void> {
  registerBuiltinLeaders();
  const legacy = await chrome.storage.local.get<Record<string, Record<string, string> | undefined>>([...LEGACY_KEYS]);
  const [spaces, macros] = await Promise.all([getSpaces(), getMacros()]);

  for (const s of spaces) {
    const old = s.id !== undefined ? legacy[SPACE_LETTERS_KEY]?.[String(s.id)] : undefined;
    if (s.id !== undefined && old && !s.letter) {
      await setSpaceLetterRow(s.id, old);
      s.letter = old;
    }
  }
  for (const m of macros) {
    const old = m.id !== undefined ? legacy[MACRO_LETTERS_KEY]?.[String(m.id)] : undefined;
    if (m.id !== undefined && old && !m.letter) {
      await setMacroLetterRow(m.id, old);
      m.letter = old;
    }
  }
  if (legacy[SPACE_LETTERS_KEY] || legacy[MACRO_LETTERS_KEY]) await chrome.storage.local.remove([...LEGACY_KEYS]);

  const overrides = await getLetterOverrides();
  const plan = planLetterCleanup(
    listRegistrations().map((r) => effectiveLetter(r, overrides)),
    spaces.flatMap((s) => (s.id !== undefined ? [{ id: s.id, letter: s.letter }] : [])),
    macros.flatMap((m) => (m.id !== undefined ? [{ id: m.id, letter: m.letter }] : [])),
  );
  for (const id of plan.clearSpaces) await setSpaceLetterRow(id, null);
  for (const id of plan.clearMacros) await setMacroLetterRow(id, null);
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
    try {
      if ((await runMacro(Number(item.id))) === null) await notifyLeaderFailure(`Could not run "${item.label}"`, 'That macro is no longer available.');
    } catch (err) {
      await notifyLeaderFailure(`Could not run "${item.label}"`, err instanceof Error ? err.message : String(err));
    }
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

/** A leader action that failed must say so: it used to end up only in the service-worker console. */
export async function notifyLeaderFailure(title: string, message: string): Promise<void> {
  await chrome.notifications
    .create(`cadence-leader:failed-${Date.now()}`, { type: 'basic', iconUrl: '/icon/128.png', title, message })
    .catch(() => undefined);
}

async function notifyLeaderUnavailable(): Promise<void> {
  await chrome.notifications
    .create(`cadence-leader:unavailable-${Date.now()}`, {
      type: 'basic',
      iconUrl: '/icon/128.png',
      title: 'Leader key unavailable on this page',
      message: 'Reload the tab and try again, or click the ctrl-flow icon.',
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
