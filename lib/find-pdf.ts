// "Find PDF" runner: reads the selection, asks the resolver, then downloads the PDF or opens a search.
// This file is the only place that touches chrome.* for the feature; the rules live in pdf-resolver.ts.
//
// Privacy (PRIV-8): the selected text goes only to the four lookup APIs, only because the user pressed
// the key, and every lookup is logged for "Last outbound request". It does nothing while ctrl-flow is
// paused or on an excluded site, and it never writes the selection to the event log.
import { getMacros } from './db';
import { isReplayInProgress, setReplayInProgress } from './macro-run-channel';
import { LEADER_NOTIFICATION_PREFIX } from './notification-ids';
import { normalizeUrl } from './normalize';
import { recordOutbound } from './outbound-log';
import { SOURCE_NAMES, findPdf, sanitizeFilename, type LookupLog, type SourceId } from './pdf-resolver';
import { getBlocklist, isBlocklisted, isPaused } from './privacy';
import { cleanSelection } from './selection';

export type FindPdfOutcome = 'downloaded' | 'searched' | 'blocked' | 'paused' | 'empty';

export interface FindPdfOptions {
  /** The tab the user was on. Defaults to the active tab. */
  tabId?: number;
  /** Selection already captured by the pie (it snapshots at open); otherwise read from the tab now. */
  selection?: string;
}

async function tell(title: string, message: string, id?: string, buttons?: string[]): Promise<void> {
  await chrome.notifications
    .create(id ?? `${LEADER_NOTIFICATION_PREFIX}pdf-${Date.now()}`, {
      type: 'basic',
      iconUrl: '/icon/128.png',
      title,
      message,
      ...(buttons ? { buttons: buttons.map((t) => ({ title: t })) } : {}),
    })
    .catch(() => undefined);
}

/** Injected into the page: must be self-contained. Mirrors `readSelection` in selection.ts. */
function readSelectionInPage(): string {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el instanceof HTMLInputElement && (el.type === 'password' || el.type === 'hidden')) return '';
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end > start) return el.value.slice(start, end);
  }
  return window.getSelection()?.toString() ?? '';
}

/**
 * The tab's selected text, read at the moment the user asked (never stored). Uses scripting rather than a
 * content script so it also works on tabs that were open before the extension loaded.
 */
export async function readSelectionFromTab(tabId: number): Promise<string> {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: readSelectionInPage });
    for (const r of results) {
      const text = cleanSelection(typeof r.result === 'string' ? r.result : '');
      if (text) return text;
    }
  } catch {
    /* chrome://, the Web Store, or a closed tab */
  }
  return '';
}

/** Sources the user's saved Find PDF command prefers, if they saved one. */
async function preferredSources(): Promise<SourceId[]> {
  const saved = (await getMacros()).find((m) => m.command?.kind === 'find_pdf' && (m.status === 'accepted' || m.status === 'auto'));
  return saved?.command?.sourceOrder ?? [];
}

export async function runFindPdf(opts: FindPdfOptions = {}): Promise<FindPdfOutcome> {
  if (await isPaused()) {
    await tell('ctrl-flow is paused', 'Resume recording to use Find PDF.');
    return 'paused';
  }

  const tab =
    opts.tabId !== undefined
      ? await chrome.tabs.get(opts.tabId).catch(() => undefined)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const page = normalizeUrl(tab?.url);
  if (page && isBlocklisted(page.domain, await getBlocklist())) {
    // Excluded site: no selection read, nothing sent anywhere.
    await tell('Find PDF is off here', `${page.domain} is on your excluded sites.`);
    return 'blocked';
  }

  const selection = cleanSelection(opts.selection ?? (tab?.id !== undefined ? await readSelectionFromTab(tab.id) : ''));
  if (!selection) {
    await tell('Select a paper title first', 'Highlight the title, then press the leader key and F.');
    return 'empty';
  }

  const logs: LookupLog[] = [];
  // ctrl-flow's own tab opens and download must not be learned as the user's behavior.
  const ownFlag = !(await isReplayInProgress());
  if (ownFlag) await setReplayInProgress(true);
  try {
    const result = await findPdf(selection, { fetch, log: (l) => logs.push(l), sourceOrder: await preferredSources() });

    if (result.found) {
      const name = SOURCE_NAMES[result.source];
      const filename = sanitizeFilename(result.title || selection);
      if (chrome.downloads) {
        const id = await chrome.downloads.download({ url: result.pdfUrl, filename, conflictAction: 'uniquify' });
        await recordOutbound({ ts: Date.now(), kind: 'pdf-lookup', lookups: logs, outcome: `downloaded from ${name}` });
        await tell(`Downloaded from ${name}`, filename, `${LEADER_NOTIFICATION_PREFIX}pdf-open:${id}`, ['Open']);
      } else {
        // The `downloads` permission is not granted: open the verified PDF instead of failing.
        await chrome.tabs.create({ url: result.pdfUrl });
        await recordOutbound({ ts: Date.now(), kind: 'pdf-lookup', lookups: logs, outcome: `opened PDF from ${name}` });
        await tell(`Opened PDF from ${name}`, 'Downloads are not enabled for ctrl-flow, so it opened in a tab.');
      }
      return 'downloaded';
    }

    await chrome.tabs.create({ url: result.searchUrl });
    await recordOutbound({ ts: Date.now(), kind: 'pdf-lookup', lookups: logs, outcome: 'no free PDF found; opened a search' });
    await tell('No free PDF found', 'Opened a search.');
    return 'searched';
  } finally {
    if (ownFlag) {
      // Page loads from the tab we just opened land a moment later.
      await new Promise((r) => setTimeout(r, 2500));
      await setReplayInProgress(false);
    }
  }
}

/** Notification "Open" button for a finished download. */
export async function openDownload(downloadId: number): Promise<void> {
  try {
    await chrome.downloads.open(downloadId);
  } catch {
    chrome.downloads.show(downloadId); // `downloads.open` not granted: reveal the file instead
  }
}
