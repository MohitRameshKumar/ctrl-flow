// The Find PDF runner end to end, with chrome.* stubbed: what the user is told and what is opened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ getMacros: async () => [] }));

const ATOM = `<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention Is All You
  Need</title><link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/></entry></feed>`;

interface Chrome {
  notifications: { create: ReturnType<typeof vi.fn> };
  tabs: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  downloads: { download: ReturnType<typeof vi.fn> };
  storage: { local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }; session: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } };
}

function stubChrome(): Chrome {
  const mem: Record<string, unknown> = {};
  const chrome: Chrome = {
    notifications: { create: vi.fn(async () => 'id') },
    tabs: { create: vi.fn(async () => ({})), get: vi.fn(async () => ({ id: 1, url: 'https://en.wikipedia.org/wiki/Transformer' })), query: vi.fn(async () => []) },
    downloads: { download: vi.fn(async () => 7) },
    storage: {
      local: { get: vi.fn(async (k?: string | string[]) => (typeof k === 'string' ? { [k]: mem[k] } : {})), set: vi.fn(async (o: Record<string, unknown>) => void Object.assign(mem, o)) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    },
  };
  vi.stubGlobal('chrome', chrome);
  return chrome;
}

/** Native-fetch behavior: throws if called as a method of another object. */
function stubFetch(routes: [string, () => Response | Promise<Response>][]) {
  const fn = function (this: unknown, input: RequestInfo | URL) {
    if (this !== undefined && this !== globalThis) return Promise.reject(new TypeError('Illegal invocation'));
    const url = String(input);
    for (const [needle, make] of routes) if (url.includes(needle)) return Promise.resolve(make());
    return Promise.resolve(new Response('{"data":[],"results":[],"response":{"docs":[]}}', { status: 200 }));
  };
  vi.stubGlobal('fetch', fn);
}

const titles = (c: Chrome) => c.notifications.create.mock.calls.map((call) => (call[1] as { title: string }).title);

async function run(selection: string) {
  const { runFindPdf } = await import('@/lib/find-pdf');
  const p = runFindPdf({ tabId: 1, selection });
  await vi.runAllTimersAsync();
  return p;
}

describe('runFindPdf', () => {
  let chrome: Chrome;
  beforeEach(() => {
    vi.useFakeTimers();
    chrome = stubChrome();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('found: downloads <title>.pdf and says which source it came from', async () => {
    stubFetch([
      ['export.arxiv.org', () => new Response(ATOM)],
      ['arxiv.org/pdf', () => new Response('%PDF-1.5', { headers: { 'content-type': 'application/pdf' } })],
    ]);
    expect(await run('Attention Is All You Need')).toBe('downloaded');
    expect(chrome.downloads.download).toHaveBeenCalledWith({ url: 'https://arxiv.org/pdf/1706.03762v7', filename: 'Attention Is All You Need.pdf', conflictAction: 'uniquify' });
    expect(titles(chrome)).toEqual(['Downloaded from arXiv']);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    const logged = chrome.storage.local.set.mock.calls.map((c) => c[0]).find((o) => 'lastOutboundRequest' in o).lastOutboundRequest;
    expect(logged.lookups).toEqual([{ source: 'arxiv', query: 'Attention Is All You Need', result: expect.stringMatching(/^found/) }]);
  });

  it('nothing exists: opens a quoted Google search and says no free PDF was found', async () => {
    stubFetch([]);
    expect(await run('Zzyzx quantum marmalade theorem')).toBe('searched');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://www.google.com/search?q=%22Zzyzx%20quantum%20marmalade%20theorem%22%20pdf' });
    expect(titles(chrome)).toEqual(['No free PDF found']);
  });

  it('a fault is reported as an error and does NOT silently open a search', async () => {
    stubFetch([['export.arxiv.org', () => Promise.reject(new TypeError('Failed to fetch'))]]);
    expect(await run('Attention Is All You Need')).toBe('error');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.downloads.download).not.toHaveBeenCalled();
    expect(titles(chrome)).toEqual(['Find PDF error']);
    expect(chrome.notifications.create.mock.calls[0]![1].message).toMatch(/last outbound request/i);
  });

  it('nothing selected: asks for a selection and sends nothing', async () => {
    stubFetch([]);
    expect(await run('   ')).toBe('empty');
    expect(titles(chrome)).toEqual(['Select a paper title first']);
  });
});
