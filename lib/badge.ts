// UI-5: the toolbar badge shows whether ctrl-flow is recording, paused, or ignoring the current site.
import { getBlocklist, isBlocklisted } from './privacy';
import type { BlocklistConfig } from './types';

const RECORDING = { text: '●', color: '#2e7d32', title: 'ctrl-flow: recording' };
const PAUSED = { text: 'II', color: '#9e9e9e', title: 'ctrl-flow: paused' };
/** A distinct grey: this one site is not recorded (excluded in either mode). */
const EXCLUDED = { text: '○', color: '#9e9e9e', title: "ctrl-flow isn't recording this site" };

export type RecordingState = 'recording' | 'paused' | 'excluded';

/** Is this tab URL on an excluded site (never record or visit only)? Non-web pages count as not recorded too. */
export function isExcludedUrl(url: string | undefined, blocklist: BlocklistConfig): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isBlocklisted(u.hostname, blocklist);
  } catch {
    return false;
  }
}

/** Paused wins: while paused nothing is recorded anywhere, which is the more important thing to say. */
export function recordingStateFor(url: string | undefined, paused: boolean, blocklist: BlocklistConfig): RecordingState {
  if (paused) return 'paused';
  return isExcludedUrl(url, blocklist) ? 'excluded' : 'recording';
}

const STATES = { recording: RECORDING, paused: PAUSED, excluded: EXCLUDED } as const;

/** Sets the global badge (no tab) and, when given, the badge for one tab. */
export async function updateBadge(tab?: { id?: number; url?: string }): Promise<void> {
  if (!chrome.action) return;
  const { paused } = await chrome.storage.local.get<{ paused?: boolean }>('paused');
  const globalState = STATES[paused === true ? 'paused' : 'recording'];
  await Promise.all([
    chrome.action.setBadgeText({ text: globalState.text }),
    chrome.action.setBadgeBackgroundColor({ color: globalState.color }),
    chrome.action.setTitle({ title: globalState.title }),
  ]);
  if (tab?.id !== undefined) await updateBadgeForTab(tab.id, tab.url);
}

/** Per-tab override: only differs from the global state on an excluded site. */
export async function updateBadgeForTab(tabId: number, url: string | undefined): Promise<void> {
  if (!chrome.action) return;
  const { paused } = await chrome.storage.local.get<{ paused?: boolean }>('paused');
  const state = STATES[recordingStateFor(url, paused === true, await getBlocklist())];
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: state.text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: state.color }),
    chrome.action.setTitle({ tabId, title: state.title }),
  ]);
}
