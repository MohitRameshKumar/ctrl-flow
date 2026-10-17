// Marks tab activations that Cadence itself causes (restoring a space, opening ritual docs, Focus
// Flip) so the collector, Rituals, Spaces, the switch offer, and Focus Flip's own learning don't
// treat them as the user choosing to work on that tab. Tab-aware so a user's own switch made right
// after a Cadence one is never mislabeled.
const PROGRAMMATIC_KEY = 'programmaticNavs';
const PROGRAMMATIC_WINDOW_MS = 4000;

interface ProgrammaticNav {
  tabId: number | null;
  until: number;
}

async function readNavs(): Promise<ProgrammaticNav[]> {
  const { [PROGRAMMATIC_KEY]: navs } =
    await chrome.storage.session.get<Record<string, ProgrammaticNav[] | undefined>>(PROGRAMMATIC_KEY);
  const now = Date.now();
  return (navs ?? []).filter((n) => n.until > now);
}

/** Call immediately before a chrome.tabs.update({ active: true }) that Cadence initiates. Pass the tab being activated. */
export async function markProgrammaticNav(tabId?: number): Promise<void> {
  const navs = await readNavs();
  navs.push({ tabId: tabId ?? null, until: Date.now() + PROGRAMMATIC_WINDOW_MS });
  await chrome.storage.session.set({ [PROGRAMMATIC_KEY]: navs });
}

/** True if this activation was marked by Cadence. A mark without a tab id matches any tab. */
export async function isProgrammaticNav(tabId?: number): Promise<boolean> {
  const navs = await readNavs();
  return navs.some((n) => n.tabId === null || tabId === undefined || n.tabId === tabId);
}
