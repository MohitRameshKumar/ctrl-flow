// Focus Flip's cycle as a pure state machine (no chrome.*, no timers), so every rule is unit-testable.
//
//   writing tab:   type, then stop for the flip delay  -> flip to the reference tab
//   reference tab: scroll / click, then stop           -> flip back to the writing tab
//
// A flip only ever follows activity *then* idle, measured in the page from the real last event, so
// arriving at a tab and doing nothing never flips, and it cannot ping-pong while you are away. The
// machine is stateless: "paused" simply means the tab you are on is not part of an active pair, and
// the cycle resumes the moment you are on either tab of the pair and act again.
import { domainOf, prettyDomain } from './macro-detection';

export type IdleKind = 'key' | 'scroll' | 'click';

export interface CyclePair {
  writingUrl: string;
  referenceUrl: string;
  active: boolean;
  updatedAt: number;
}

export interface CycleTab {
  id: number;
  /** Normalized URL. */
  url: string;
  windowId?: number;
  /** Active in its window. */
  active?: boolean;
}

export interface CycleContext {
  enabled: boolean;
  /** ctrl-flow's own recording pause. */
  appPaused: boolean;
  /** A macro is replaying. */
  replaying: boolean;
  /** Chrome has focus and this tab's window is the focused one. */
  chromeFocused: boolean;
  /** Tabs with a password / payment field focused. */
  sensitiveTabIds: number[];
  /** The tab that went idle. */
  tab: CycleTab;
  kind: IdleKind;
  pairs: CyclePair[];
  /** Flippable open tabs (trackable, not incognito). */
  openTabs: CycleTab[];
}

export type FlipDecision =
  | { flip: true; toTabId: number; role: 'writing' | 'reference' }
  | { flip: false; reason: 'off' | 'app-paused' | 'replaying' | 'chrome-unfocused' | 'tab-inactive' | 'sensitive' | 'no-pair' | 'no-target' };

/** Typing idles the writing tab; scrolling or clicking idles the reference tab. Anything else is ignored. */
export function decideFlip(ctx: CycleContext): FlipDecision {
  if (!ctx.enabled) return { flip: false, reason: 'off' };
  if (ctx.appPaused) return { flip: false, reason: 'app-paused' };
  if (ctx.replaying) return { flip: false, reason: 'replaying' };
  if (!ctx.chromeFocused) return { flip: false, reason: 'chrome-unfocused' };
  if (!ctx.tab.active) return { flip: false, reason: 'tab-inactive' };
  if (ctx.sensitiveTabIds.includes(ctx.tab.id)) return { flip: false, reason: 'sensitive' };

  const role = ctx.kind === 'key' ? 'writing' : 'reference';
  const pairs = ctx.pairs.filter((p) => p.active).sort((a, b) => b.updatedAt - a.updatedAt);
  let involved = false;
  for (const pair of pairs) {
    const here = role === 'writing' ? pair.writingUrl : pair.referenceUrl;
    if (ctx.tab.url !== here) continue;
    involved = true;
    const there = role === 'writing' ? pair.referenceUrl : pair.writingUrl;
    const target = ctx.openTabs
      .filter((t) => t.id !== ctx.tab.id && t.url === there)
      .sort((a, b) => Number(b.windowId === ctx.tab.windowId) - Number(a.windowId === ctx.tab.windowId))[0];
    if (target) return { flip: true, toTabId: target.id, role };
  }
  return { flip: false, reason: involved ? 'no-target' : 'no-pair' };
}

export function siteLabel(url: string): string {
  return prettyDomain(domainOf(url) ?? url);
}

export type FlipStatusState = 'off' | 'no-pair' | 'cycling' | 'paused-other-tab' | 'paused-recording' | 'paused-macro';

export interface FlipStatus {
  state: FlipStatusState;
  /** e.g. "Focus Flip: Google Docs ↔ NYT · cycling". */
  label: string;
}

/** What the panel shows. `activeUrl` is the normalized URL of the tab you are on. */
export function flipStatus(input: {
  enabled: boolean;
  appPaused: boolean;
  replaying: boolean;
  activeUrl?: string;
  pairs: CyclePair[];
}): FlipStatus {
  if (!input.enabled) return { state: 'off', label: 'Focus Flip: off' };
  const pairs = input.pairs.filter((p) => p.active).sort((a, b) => b.updatedAt - a.updatedAt);
  if (pairs.length === 0) return { state: 'no-pair', label: 'Focus Flip: on · no pair yet' };

  const current = input.activeUrl
    ? pairs.find((p) => p.writingUrl === input.activeUrl || p.referenceUrl === input.activeUrl)
    : undefined;
  const shown = current ?? pairs[0]!;
  const names = `${siteLabel(shown.writingUrl)} ↔ ${siteLabel(shown.referenceUrl)}`;

  if (input.appPaused) return { state: 'paused-recording', label: `Focus Flip: ${names} · paused (recording is paused)` };
  if (input.replaying) return { state: 'paused-macro', label: `Focus Flip: ${names} · paused (macro running)` };
  if (!current) return { state: 'paused-other-tab', label: `Focus Flip: ${names} · paused (on another tab)` };
  return { state: 'cycling', label: `Focus Flip: ${names} · cycling` };
}
