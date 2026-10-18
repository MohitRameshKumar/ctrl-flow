// The registry translates CDP's model (targets) into Chrome's (tabs). It is written as a pure
// reducer over events so the tricky parts — load status, activation dedupe, the SPA flag — can be
// driven directly here instead of only through a live browser.
import { beforeEach, expect, it } from 'vitest';
import { TabRegistry, isTabTarget, type RegistryEvent } from '@/desktop/main/tab-registry';

let registry: TabRegistry;
let events: RegistryEvent[];

beforeEach(() => {
  registry = new TabRegistry();
  events = [];
  registry.subscribe((e) => events.push(e));
});

function addTab(targetId: string, url = 'https://example.com', windowId = 1) {
  return registry.add({ targetId, type: 'page', url, title: '' }, windowId);
}

it('treats only page targets as tabs', () => {
  expect(isTabTarget({ targetId: 't', type: 'page', url: 'https://a.com' })).toBe(true);
  expect(isTabTarget({ targetId: 't', type: 'service_worker' })).toBe(false);
  expect(isTabTarget({ targetId: 't', type: 'iframe' })).toBe(false);
  // DevTools windows are page targets but are not the user's browsing.
  expect(isTabTarget({ targetId: 't', type: 'page', url: 'devtools://devtools/x.html' })).toBe(false);
});

it('assigns stable ids and maps them back to targets', () => {
  const a = addTab('T1');
  const b = addTab('T2');
  expect(a?.id).not.toBe(b?.id);
  expect(registry.targetFor(a!.id)).toBe('T1');
  expect(registry.byTarget('T2')?.id).toBe(b!.id);
});

it('ignores a duplicate attach for the same target', () => {
  const first = addTab('T1');
  const again = addTab('T1');
  expect(again?.id).toBe(first?.id);
  expect(registry.all()).toHaveLength(1);
});

it('starts a new tab as loading, so waitForTabComplete waits for a real signal', () => {
  // If a fresh tab claimed `complete`, replay would inject into a blank page and report a
  // confusing "element not found" instead of waiting.
  const tab = addTab('T1');
  expect(tab?.status).toBe('loading');
});

it('emits only the fields that actually changed', () => {
  const tab = addTab('T1')!;
  events.length = 0;

  registry.update(tab.id, { status: 'complete', url: 'https://example.com' });

  const updated = events.filter((e) => e.kind === 'updated');
  expect(updated).toHaveLength(1);
  // `url` was already that value, so it must not appear in changeInfo.
  expect(updated[0]).toMatchObject({ changes: { status: 'complete' } });
  expect((updated[0] as { changes: Record<string, unknown> }).changes.url).toBeUndefined();
});

it('says nothing when a patch changes nothing', () => {
  const tab = addTab('T1')!;
  events.length = 0;
  registry.update(tab.id, { url: 'https://example.com' });
  expect(events).toHaveLength(0);
});

it('marks a hard navigation as loading and flags it spa:false', () => {
  const tab = addTab('T1')!;
  registry.update(tab.id, { status: 'complete' });
  events.length = 0;

  registry.navigated('T1', 'https://example.com/next', false);

  expect(registry.get(tab.id)?.status).toBe('loading');
  expect(events.find((e) => e.kind === 'navigated')).toMatchObject({ spa: false });
});

it('leaves status alone for an in-page navigation and flags it spa:true', () => {
  // An SPA route change never reloads, so forcing `loading` would hang waitForTabComplete.
  const tab = addTab('T1')!;
  registry.update(tab.id, { status: 'complete' });
  events.length = 0;

  registry.navigated('T1', 'https://example.com/inner', true);

  expect(registry.get(tab.id)?.status).toBe('complete');
  expect(events.find((e) => e.kind === 'navigated')).toMatchObject({ spa: true });
});

it('tracks the visible tab as the active one', () => {
  const a = addTab('T1')!;
  const b = addTab('T2')!;

  registry.reportVisible('T1', true);
  expect(registry.get(a.id)?.active).toBe(true);

  registry.reportVisible('T2', true);
  expect(registry.get(b.id)?.active).toBe(true);
  expect(registry.get(a.id)?.active).toBe(false);
});

it('does not re-announce activation for the already-active tab', () => {
  // visibilitychange also fires on minimize and occlusion; un-deduped it would feed phantom
  // tab_activated events into Focus Flip learning and switch detection.
  addTab('T1');
  registry.reportVisible('T1', true);
  events.length = 0;

  registry.reportVisible('T1', true);
  registry.reportVisible('T1', true);

  expect(events.filter((e) => e.kind === 'activated')).toHaveLength(0);
});

it('re-announces activation after a genuine switch away and back', () => {
  addTab('T1');
  addTab('T2');
  registry.reportVisible('T1', true);
  registry.reportVisible('T2', true);
  events.length = 0;

  registry.reportVisible('T1', true);

  expect(events.filter((e) => e.kind === 'activated')).toHaveLength(1);
});

it('tracks active tabs per window independently', () => {
  const a = addTab('T1', 'https://a.com', 1)!;
  const b = addTab('T2', 'https://b.com', 2)!;

  registry.reportVisible('T1', true);
  registry.reportVisible('T2', true);

  // Two windows each have a visible tab; one must not deactivate the other.
  expect(registry.get(a.id)?.active).toBe(true);
  expect(registry.get(b.id)?.active).toBe(true);
  expect(registry.activeTabIn(1)?.id).toBe(a.id);
  expect(registry.activeTabIn(2)?.id).toBe(b.id);
});

it('clears the active tab when its window reports hidden', () => {
  const a = addTab('T1')!;
  registry.reportVisible('T1', true);
  registry.reportVisible('T1', false);
  expect(registry.get(a.id)?.active).toBe(false);
});

it('removing a tab emits removed and forgets its mapping', () => {
  const tab = addTab('T1')!;
  events.length = 0;

  registry.remove('T1');

  expect(events).toContainEqual({ kind: 'removed', tabId: tab.id, windowId: 1 });
  expect(registry.get(tab.id)).toBeUndefined();
  expect(registry.byTarget('T1')).toBeUndefined();
});

it('removing the active tab frees the window slot for the next activation', () => {
  addTab('T1');
  const b = addTab('T2')!;
  registry.reportVisible('T1', true);
  registry.remove('T1');
  events.length = 0;

  registry.reportVisible('T2', true);

  expect(events.filter((e) => e.kind === 'activated')).toHaveLength(1);
  expect(registry.get(b.id)?.active).toBe(true);
});

it('ignores events for targets it never registered', () => {
  // Worker and OOPIF sessions produce navigation events that are not tab navigations.
  expect(() => registry.navigated('unknown', 'https://x.com', false)).not.toThrow();
  expect(() => registry.reportVisible('unknown', true)).not.toThrow();
  expect(events).toHaveLength(0);
});

it('query filters by active and windowId', () => {
  addTab('T1', 'https://a.com', 1);
  addTab('T2', 'https://b.com', 2);
  registry.reportVisible('T1', true);

  expect(registry.query({ active: true }).map((t) => t.targetId)).toEqual(['T1']);
  expect(registry.query({ windowId: 2 }).map((t) => t.targetId)).toEqual(['T2']);
  expect(registry.query({})).toHaveLength(2);
});

it('clear announces every tab as removed, as a browser exit should', () => {
  addTab('T1');
  addTab('T2');
  events.length = 0;

  registry.clear();

  expect(events.filter((e) => e.kind === 'removed')).toHaveLength(2);
  expect(registry.all()).toEqual([]);
});
