// The saved "Find PDF" command (Part 2): suggested after the manual routine is seen, then listed in the
// Macros tab like any macro. It has no steps to replay; running it goes through the same resolver as
// the built-in F key, preferring the sources the user actually used.
import { getEvents, getMacros, putMacro } from './db';
import { detectPaperLookup } from './paper-pattern';
import { LEADER_NOTIFICATION_PREFIX } from './notification-ids';
import { SOURCE_NAMES, DEFAULT_SOURCE_ORDER, type SourceId } from './pdf-resolver';
import type { Macro, MacroCommand } from './types';

export const FIND_PDF_MACRO_KEY = 'cmd:find-pdf';
export const FIND_PDF_LETTER = 'f';

export function buildFindPdfCommand(preferred: SourceId[]): MacroCommand {
  return {
    kind: 'find_pdf',
    variables: [{ name: 'paper_title', source: 'selection' }],
    sourceOrder: [...new Set([...preferred, ...DEFAULT_SOURCE_ORDER])],
  };
}

/** Readable steps for the Macros tab. */
export function commandSteps(command: MacroCommand): string[] {
  return [
    'Take paper_title from your selected text',
    ...command.sourceOrder.map((s) => `Look it up on ${SOURCE_NAMES[s]}`),
    'Download the first verified PDF',
    'If there is none, open a Google search',
  ];
}

export const FIND_PDF_SUGGESTION_TEXT =
  'Looks like you looked up a paper and downloaded its PDF. Save as Find PDF on F?';

export function buildFindPdfSuggestion(preferred: SourceId[], now: number): Macro {
  return {
    macroKey: FIND_PDF_MACRO_KEY,
    name: 'Find PDF',
    nameIsUserSet: false,
    source: 'chrome',
    detector: 'sequence',
    steps: [],
    removedStepKeys: [],
    pinnedStepKeys: [],
    status: 'suggested',
    occurrences: 1,
    typicalHour: null,
    command: buildFindPdfCommand(preferred),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Called after a PDF download is recorded. If the manual routine just happened and Find PDF has never
 * been suggested (or decided on), creates the suggestion and raises a notification. Idempotent:
 * "Never" and "Not now" are remembered by the row itself.
 */
export async function suggestFindPdf(preferred: SourceId[], now: number = Date.now()): Promise<Macro | null> {
  const macros = await getMacros();
  if (macros.some((m) => m.macroKey === FIND_PDF_MACRO_KEY)) return null;
  const macro = buildFindPdfSuggestion(preferred, now);
  const id = await putMacro(macro);
  if (id === undefined) return null;
  await chrome.notifications
    .create(`${LEADER_NOTIFICATION_PREFIX}pdf-suggest:${id}`, {
      type: 'basic',
      iconUrl: '/icon/128.png',
      title: 'Save "Find PDF"?',
      message: FIND_PDF_SUGGESTION_TEXT,
      buttons: [{ title: 'Save on F' }, { title: 'Not now' }],
    })
    .catch(() => undefined);
  return { ...macro, id };
}

/** Looks at the last few minutes of events for the manual paper routine; suggests Find PDF if it just happened. */
export async function checkPaperLookup(now: number = Date.now()): Promise<void> {
  const hit = detectPaperLookup(await getEvents(now - 6 * 60 * 1000, now));
  if (hit) await suggestFindPdf(hit.sources, hit.at);
}
