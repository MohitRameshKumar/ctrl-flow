// Reading the user's current text selection (a run-time variable: SPEC GEN-5 `source: selection`).
// It is held in memory only: never written to the event log, only handed to the command that asked.
export const MAX_SELECTION_CHARS = 300;

export function cleanSelection(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SELECTION_CHARS);
}

/** The selection on this page, including text selected inside an input or textarea. */
export function readSelection(doc: Document = document): string {
  const el = doc.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Never read a password (or other secret) field's selection.
    if (el instanceof HTMLInputElement && (el.type === 'password' || el.type === 'hidden')) return '';
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end > start) return cleanSelection(el.value.slice(start, end));
  }
  return cleanSelection(doc.defaultView?.getSelection()?.toString() ?? '');
}
