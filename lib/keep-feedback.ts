// What K / R / M say back after they run. K used to answer with a plain OS notification only, which is
// easy to miss (or switched off), so every outcome now also gets an in-page toast, and every outcome
// says something: either what was saved, or why nothing was.
export interface KeepFeedback {
  kind: 'saved' | 'nothing';
  title: string;
  message: string;
  /** Set when a free letter exists: the one-click "Assign" offer. */
  assign?: { macroId: number; letter: string };
}

/** `macro` null means the segment held nothing repeatable. */
export function keepFeedback(macro: { id?: number; name: string } | null, letter: string | null): KeepFeedback {
  if (!macro) {
    return { kind: 'nothing', title: 'Nothing to keep', message: 'Do a task first: open two or more pages, then press K.' };
  }
  const base = { kind: 'saved' as const, title: `Saved "${macro.name}"` };
  if (macro.id !== undefined && letter) {
    return { ...base, message: `Assign letter ${letter.toUpperCase()}?`, assign: { macroId: macro.id, letter } };
  }
  return { ...base, message: 'Find it at the top of the Macros tab.' };
}

/** Messages the background sends to the overlay content script. */
export interface LeaderToastMessage {
  type: 'leader_toast';
  title: string;
  message: string;
  assign?: { macroId: number; letter: string };
}
