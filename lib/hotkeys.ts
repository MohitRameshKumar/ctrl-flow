// Leader-key framework (HOT-1/3/4/6). Pure registry + validation so it is unit-testable and any
// feature can plug in with `registerLeader({ id, letter, label, run })`.
//
//   R, K, M are RESERVED for Repeat-to-Macro (a teammate's feature). Nothing else may take them;
//   the macro feature registers its letters with `allowReserved: true`. Saved macros can take any
//   other free letter, the same way saved spaces do.

export interface LeaderContext {
  tabId?: number;
  windowId?: number;
  /** The page's selected text, captured when the pie opened (Find PDF only; never stored). */
  selection?: string;
}

export interface LeaderRegistration {
  /** Stable id; user letter overrides are stored against it. */
  id: string;
  /** Default letter (lowercase single char, a–z, 0–9 or "/"). */
  letter: string;
  label: string;
  run: (ctx: LeaderContext) => void | Promise<void>;
  /** Only Repeat-to-Macro sets this, to take R / K / M. */
  allowReserved?: boolean;
  /** One word for a pie slice ("Repeat"). */
  short?: string;
  /** One line shown in the pie's center while the slice is hovered. */
  description?: string;
}

export const RESERVED_LETTERS: Record<string, string> = {
  r: 'Repeat-to-Macro',
  k: 'Repeat-to-Macro',
  m: 'Repeat-to-Macro',
};

export interface MenuItem {
  letter: string;
  label: string;
  kind: 'action' | 'space' | 'macro';
  /** Registration id, or the space / macro id for kind "space" / "macro". */
  id: string;
  /** Short slice label and hover description for the pie menu. */
  short?: string;
  description?: string;
  /** Toggle items (Focus Flip) only: whether the thing is currently on. */
  on?: boolean;
}

export type LetterCheck = { ok: true; letter: string } | { ok: false; reason: string };

export function normalizeLetter(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidLetter(letter: string, allowSlash = true): boolean {
  return allowSlash ? /^[a-z0-9/]$/.test(letter) : /^[a-z0-9]$/.test(letter);
}

export interface Assignment {
  id: string;
  letter: string;
}

/**
 * Can `ownerId` use `input` as its letter? Rejects: not a single a–z / 0–9 (or "/") character,
 * reserved letters (unless `allowReserved`), and any letter another entry already has.
 */
export function validateLetter(
  input: string,
  ownerId: string,
  assignments: Assignment[],
  opts: { allowReserved?: boolean; allowSlash?: boolean } = {},
): LetterCheck {
  const letter = normalizeLetter(input);
  if (!isValidLetter(letter, opts.allowSlash ?? true)) {
    return { ok: false, reason: 'Use a single letter or digit.' };
  }
  if (RESERVED_LETTERS[letter] && !opts.allowReserved) {
    return { ok: false, reason: `"${letter.toUpperCase()}" is reserved for ${RESERVED_LETTERS[letter]}.` };
  }
  const clash = assignments.find((a) => a.id !== ownerId && a.letter === letter);
  if (clash) return { ok: false, reason: `"${letter.toUpperCase()}" is already used.` };
  return { ok: true, letter };
}

/** First free letter of the name (HOT-4), else the first free a–z, else a digit. Never a reserved or taken letter. */
export function suggestLetter(name: string, taken: Iterable<string>): string | null {
  const used = new Set([...taken].map(normalizeLetter));
  const free = (c: string) => isValidLetter(c, false) && !used.has(c) && !RESERVED_LETTERS[c];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const c of name.toLowerCase()) {
    if (letters.includes(c) && free(c)) return c;
  }
  for (const c of letters + '0123456789') {
    if (free(c)) return c;
  }
  return null;
}

// ---- registry ---------------------------------------------------------------------------------

const registry = new Map<string, LeaderRegistration>();

export function registerLeader(reg: LeaderRegistration): void {
  const letter = normalizeLetter(reg.letter);
  const check = validateLetter(
    letter,
    reg.id,
    [...registry.values()].map((r) => ({ id: r.id, letter: r.letter })),
    { allowReserved: reg.allowReserved },
  );
  if (!check.ok) throw new Error(`Cannot register leader "${reg.id}": ${check.reason}`);
  registry.set(reg.id, { ...reg, letter });
}

export function unregisterLeader(id: string): void {
  registry.delete(id);
}

export function listRegistrations(): LeaderRegistration[] {
  return [...registry.values()];
}

/** The letter a registration actually answers to: the user's override, else its default. */
export function effectiveLetter(reg: LeaderRegistration, overrides: Record<string, string>): string {
  return overrides[reg.id] ?? reg.letter;
}

export interface SpaceLetter {
  spaceId: number;
  name: string;
  letter: string;
}

export interface MacroLetter {
  macroId: number;
  name: string;
  letter: string;
}

/** The overlay's letter list: registered actions, saved-space letters, then saved-macro letters. */
export function buildMenu(
  registrations: LeaderRegistration[],
  overrides: Record<string, string>,
  spaces: SpaceLetter[],
  macros: MacroLetter[] = [],
): MenuItem[] {
  const actions: MenuItem[] = registrations.map((r) => ({
    letter: effectiveLetter(r, overrides),
    label: r.label,
    kind: 'action',
    id: r.id,
    short: r.short,
    description: r.description,
  }));
  const spaceItems: MenuItem[] = spaces.map((s) => ({
    letter: s.letter,
    label: `Project: ${s.name}`,
    kind: 'space',
    id: String(s.spaceId),
    short: s.name,
    description: `Switch to the "${s.name}" project`,
  }));
  const macroItems: MenuItem[] = macros.map((m) => ({
    letter: m.letter,
    label: `Macro: ${m.name}`,
    kind: 'macro',
    id: String(m.macroId),
    short: m.name,
    description: `Run the macro "${m.name}"`,
  }));
  const byLetter = (a: MenuItem, b: MenuItem) => a.letter.localeCompare(b.letter);
  return [...actions.sort(byLetter), ...spaceItems.sort(byLetter), ...macroItems.sort(byLetter)];
}

/** Resolves a pressed letter to a menu item. */
export function findMenuItem(menu: MenuItem[], pressed: string): MenuItem | undefined {
  const letter = normalizeLetter(pressed);
  return menu.find((i) => i.letter === letter);
}

// ---- background <-> overlay messages -------------------------------------------------------------

export interface SearchItem {
  kind: 'space' | 'ritual' | 'macro';
  id: number;
  label: string;
}

export interface LeaderShowMessage {
  type: 'leader_show';
  items: MenuItem[];
  search: SearchItem[];
}

/**
 * Can the leader overlay (a content script) run on this page? Content scripts only match http(s),
 * and Chrome blocks them on the Web Store. Decided from the URL alone so the caller can open the
 * side panel *synchronously* inside the shortcut's user gesture when the answer is no.
 */
export function canHostOverlay(url: string | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname === 'chromewebstore.google.com') return false;
  if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return false;
  return true;
}

/** Background -> overlay: what R would repeat. `runnable: false` is an informational message (nothing to repeat). */
export interface LeaderRepeatPreviewMessage {
  type: 'leader_repeat_preview';
  text: string;
  runnable: boolean;
}

/**
 * Which stored letters must be cleared at startup: invalid, reserved, taken by an action, or already
 * claimed by an earlier row (spaces first, then macros, each in id order). Guarantees the menu never
 * has two owners for one key. Pure; `leader.syncLetters` applies the result.
 */
export function planLetterCleanup(
  actionLetters: string[],
  spaces: { id: number; letter?: string }[],
  macros: { id: number; letter?: string }[],
): { clearSpaces: number[]; clearMacros: number[] } {
  const owned = new Set(actionLetters.map(normalizeLetter));
  const claim = (raw: string): boolean => {
    const letter = normalizeLetter(raw);
    if (!isValidLetter(letter, false) || RESERVED_LETTERS[letter] || owned.has(letter)) return false;
    owned.add(letter);
    return true;
  };
  const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);
  return {
    clearSpaces: byId(spaces).filter((s) => s.letter && !claim(s.letter)).map((s) => s.id),
    clearMacros: byId(macros).filter((m) => m.letter && !claim(m.letter)).map((m) => m.id),
  };
}
