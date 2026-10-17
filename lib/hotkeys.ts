// Leader-key framework (HOT-1/3/4/6). Pure registry + validation so it is unit-testable and any
// feature can plug in with `registerLeader({ id, letter, label, run })`.
//
//   R, K, M are RESERVED for Repeat-to-Macro (a teammate's feature). Nothing else may take them;
//   the macro feature registers its letters with `allowReserved: true`. Saved macros can take any
//   other free letter, the same way saved spaces do.

export interface LeaderContext {
  tabId?: number;
  windowId?: number;
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
  }));
  const spaceItems: MenuItem[] = spaces.map((s) => ({
    letter: s.letter,
    label: `Project: ${s.name}`,
    kind: 'space',
    id: String(s.spaceId),
  }));
  const macroItems: MenuItem[] = macros.map((m) => ({
    letter: m.letter,
    label: `Macro: ${m.name}`,
    kind: 'macro',
    id: String(m.macroId),
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
  kind: 'space' | 'ritual';
  id: number;
  label: string;
}

export interface LeaderShowMessage {
  type: 'leader_show';
  items: MenuItem[];
  search: SearchItem[];
}
