// CDP has no tabGroups domain, so grouping is virtual on desktop. The rule that matters is that
// `tabs.group` must RESOLVE: `lib/spaces.ts` switchToSpace calls it with no try/catch, so a
// rejection there throws before focusTab() and breaks the entire switch-to-space leader action.
import { beforeEach, expect, it } from 'vitest';
import { createTabsShim, setTabBackend, setGroupCollapseHandler, __test } from '@/desktop/renderer/chrome-shim/tabs';
import type { ShimTab, TabBackend } from '@/desktop/renderer/chrome-shim/tabs';

function tab(id: number, extra: Partial<ShimTab> = {}): ShimTab {
  return {
    id,
    index: 0,
    windowId: 1,
    url: `https://example.com/${id}`,
    title: `tab ${id}`,
    active: false,
    status: 'complete',
    pinned: false,
    incognito: false,
    groupId: -1,
    ...extra,
  };
}

function backendWith(tabs: ShimTab[]): TabBackend {
  return {
    query: async () => tabs,
    get: async (id) => {
      const found = tabs.find((t) => t.id === id);
      if (!found) throw new Error(`no tab ${id}`);
      return found;
    },
    create: async () => tab(99),
    update: async () => undefined,
    remove: async () => {},
    reload: async () => {},
    executeScript: async () => [],
    focusWindow: async () => {},
    lastFocusedWindow: async () => ({ id: 1, focused: true }),
    sendMessage: async () => undefined,
  };
}

beforeEach(() => {
  __test.reset();
  setGroupCollapseHandler(null);
  setTabBackend(backendWith([tab(1), tab(2), tab(3)]));
});

it('tabs.group resolves with a group id rather than rejecting', async () => {
  const { tabs } = createTabsShim();
  await expect(tabs.group({ tabIds: [1, 2] })).resolves.toEqual(expect.any(Number));
});

it('tabs.group resolves even with no browser attached at all', async () => {
  // P0 ships with the null backend; the UI must still be usable.
  setTabBackend({
    ...backendWith([]),
    get: async () => {
      throw new Error('no browser attached');
    },
  });
  const { tabs } = createTabsShim();
  await expect(tabs.group({ tabIds: [1, 2] })).resolves.toEqual(expect.any(Number));
});

it('tabGroups.query finds a group by title, which is how restoreSpace probes', async () => {
  const { tabs, tabGroups } = createTabsShim();
  const id = await tabs.group({ tabIds: [1, 2] });
  await tabGroups.update(id, { title: 'Project A', collapsed: false });

  const found = await tabGroups.query({ title: 'Project A' });
  expect(found).toHaveLength(1);
  expect(found[0]?.id).toBe(id);
});

it('tabGroups.query returns empty for an unknown title so callers take the shelf path', async () => {
  const { tabGroups } = createTabsShim();
  expect(await tabGroups.query({ title: 'Nothing' })).toEqual([]);
});

it('assigns distinct ids to separate groups', async () => {
  const { tabs } = createTabsShim();
  const a = await tabs.group({ tabIds: [1] });
  const b = await tabs.group({ tabIds: [2] });
  expect(a).not.toBe(b);
});

it('adds tabs to an existing group when groupId is passed', async () => {
  const { tabs } = createTabsShim();
  const id = await tabs.group({ tabIds: [1] });
  await tabs.group({ tabIds: [2, 3], groupId: id });

  const members = await tabs.query({ groupId: id });
  expect(members.map((t) => t.id).sort()).toEqual([1, 2, 3]);
});

it('ungroup removes tabs from every group', async () => {
  const { tabs } = createTabsShim();
  const id = await tabs.group({ tabIds: [1, 2, 3] });
  await tabs.ungroup([2]);

  const members = await tabs.query({ groupId: id });
  expect(members.map((t) => t.id)).toEqual([1, 3]);
});

it('notifies the collapse handler only on an actual change', async () => {
  // P4 maps "collapse" onto "shelve these tabs", so a spurious notification would close tabs.
  const { tabs, tabGroups } = createTabsShim();
  const id = await tabs.group({ tabIds: [1, 2] });

  const calls: boolean[] = [];
  setGroupCollapseHandler((_g, collapsed) => calls.push(collapsed));

  await tabGroups.update(id, { title: 'A', collapsed: false }); // already false — no call
  await tabGroups.update(id, { collapsed: true });
  await tabGroups.update(id, { collapsed: true }); // unchanged — no call
  await tabGroups.update(id, { collapsed: false });

  expect(calls).toEqual([true, false]);
});

it('hands the collapse handler the tabs it needs to shelve', async () => {
  const { tabs, tabGroups } = createTabsShim();
  const id = await tabs.group({ tabIds: [1, 2] });
  await tabGroups.update(id, { title: 'Project A' });

  let captured: { title?: string; tabIds: number[] } | null = null;
  setGroupCollapseHandler((group) => {
    captured = { title: group.title, tabIds: [...group.tabIds] };
  });
  await tabGroups.update(id, { collapsed: true });

  expect(captured).toEqual({ title: 'Project A', tabIds: [1, 2] });
});

it('tabGroups.update on an unknown group resolves instead of throwing', async () => {
  const { tabGroups } = createTabsShim();
  await expect(tabGroups.update(999, { title: 'ghost' })).resolves.toBeUndefined();
});

it('tabs.query without a groupId passes the backend list straight through', async () => {
  const { tabs } = createTabsShim();
  expect((await tabs.query({})).map((t) => t.id)).toEqual([1, 2, 3]);
});
