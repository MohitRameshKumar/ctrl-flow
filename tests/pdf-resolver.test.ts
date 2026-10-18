import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_ORDER,
  MAX_QUERY_CHARS,
  TITLE_MATCH_THRESHOLD,
  cleanQuery,
  extractDoi,
  findPdf,
  googleSearchUrl,
  isShadowLibraryHost,
  parseArxiv,
  sanitizeFilename,
  titleSimilarity,
  verifyPdf,
  type LookupLog,
} from '@/lib/pdf-resolver';

const TITLE = 'Attention Is All You Need';

const arxivXml = (title: string, id = '1706.03762v7') => `<?xml version="1.0"?><feed><title>arXiv Query</title><entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title>
  <link href="http://arxiv.org/abs/${id}" rel="alternate" type="text/html"/><link title="pdf" href="http://arxiv.org/pdf/${id}" rel="related" type="application/pdf"/></entry></feed>`;

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** A fetch whose responses come from the first matching route; records every URL it is asked for. */
function mockFetch(routes: [string, Route][]) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const [needle, route] of routes) if (url.includes(needle)) return route(url, init);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const pdfResponse = () => new Response('%PDF-1.5 body', { status: 200, headers: { 'content-type': 'application/pdf' } });
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const xml = (body: string) => new Response(body, { status: 200 });

describe('title matching', () => {
  it('exact and case/punctuation-only differences match', () => {
    expect(titleSimilarity(TITLE, TITLE)).toBe(1);
    expect(titleSimilarity(TITLE, 'ATTENTION IS ALL YOU NEED.')).toBe(1);
    expect(titleSimilarity('Deep Residual Learning for Image Recognition', 'Deep residual learning, for image recognition!')).toBe(1);
  });

  it('near-exact titles pass the threshold (one word off in a long title; accents)', () => {
    expect(titleSimilarity('Language Models are Few-Shot Learners and Reasoners at Scale', 'Language Models are Few-Shot Learners and Reasoners at Scales')).toBeGreaterThanOrEqual(TITLE_MATCH_THRESHOLD);
    expect(titleSimilarity('Naïve Bayes Classifiers', 'Naive Bayes classifiers')).toBe(1);
  });

  it('a different paper does not match, even one whose title contains the query', () => {
    expect(titleSimilarity(TITLE, 'Not All Attention Is All You Need')).toBeLessThan(TITLE_MATCH_THRESHOLD);
    expect(titleSimilarity(TITLE, 'Attention Is All You Need In Speech Separation')).toBeLessThan(TITLE_MATCH_THRESHOLD);
    expect(titleSimilarity(TITLE, 'Deep Residual Learning for Image Recognition')).toBeLessThan(0.5);
    expect(titleSimilarity(TITLE, '')).toBe(0);
  });
});

describe('DOI detection', () => {
  it('finds a DOI bare, inside a URL, and inside a sentence; strips trailing punctuation', () => {
    expect(extractDoi('10.1145/3290605.3300233')).toBe('10.1145/3290605.3300233');
    expect(extractDoi('https://doi.org/10.1038/nature14539')).toBe('10.1038/nature14539');
    expect(extractDoi('see (doi: 10.1000/xyz123).')).toBe('10.1000/xyz123');
    expect(extractDoi('LeCun et al., Deep learning, 10.1038/nature14539,')).toBe('10.1038/nature14539');
  });
  it('returns null when there is none', () => {
    expect(extractDoi(TITLE)).toBeNull();
    expect(extractDoi('version 10.5 of the spec')).toBeNull();
  });
});

describe('selection handling', () => {
  it('trims, collapses whitespace and caps at 300 characters', () => {
    expect(cleanQuery('  Attention\n\n  Is   All You Need \t')).toBe(TITLE);
    expect(cleanQuery('x'.repeat(1000))).toHaveLength(MAX_QUERY_CHARS);
  });
  it('builds a safe filename and a quoted fallback search', () => {
    expect(sanitizeFilename('Attention/Is: All "You" Need?')).toBe('Attention Is All You Need.pdf');
    expect(sanitizeFilename('///')).toBe('paper.pdf');
    expect(googleSearchUrl(TITLE)).toBe('https://www.google.com/search?q=%22Attention%20Is%20All%20You%20Need%22%20pdf');
  });
});

describe('shadow libraries are hard-blocked', () => {
  it('recognizes them by host, in any form', () => {
    for (const u of ['https://sci-hub.se/10.1/x', 'https://www.sci-hub.ru/x', 'https://libgen.is/book', 'https://annas-archive.org/md5/1', 'https://z-lib.id/x', 'https://zlibrary.to/x', 'library.lol']) {
      expect(isShadowLibraryHost(u), u).toBe(true);
    }
    for (const u of ['https://arxiv.org/pdf/1706.03762', 'https://archive.org/download/x/y.pdf', 'https://openalex.org/W1']) {
      expect(isShadowLibraryHost(u), u).toBe(false);
    }
  });

  it('a shadow-library candidate is never verified, fetched or returned; the next legal source is used', async () => {
    const { fetch, calls } = mockFetch([
      ['export.arxiv.org', () => xml(arxivXml(TITLE).replace('http://arxiv.org/pdf/1706.03762v7', 'https://sci-hub.se/downloads/attention.pdf'))],
      ['semanticscholar.org', () => json({ data: [{ title: TITLE, openAccessPdf: { url: 'https://libgen.is/x.pdf' } }] })],
      ['api.openalex.org', () => json({ results: [{ title: TITLE, best_oa_location: { pdf_url: 'https://example.edu/attention.pdf' } }] })],
      ['example.edu', pdfResponse],
    ]);
    const result = await findPdf(TITLE, { fetch });
    expect(result).toMatchObject({ found: true, source: 'openalex', pdfUrl: 'https://example.edu/attention.pdf' });
    expect(calls.some((u) => /sci-hub|libgen/.test(u))).toBe(false);
  });

  it('a PDF URL that redirects into a blocked host fails verification', async () => {
    const redirected = () => {
      const res = pdfResponse();
      Object.defineProperty(res, 'url', { value: 'https://sci-hub.se/final.pdf' });
      return res;
    };
    const { fetch } = mockFetch([['legit.example', redirected]]);
    expect(await verifyPdf('https://legit.example/a.pdf', { fetch }, Date.now() + 5000)).toBe(false);
  });
});

describe('PDF verification', () => {
  const verify = (res: Route) => verifyPdf('https://x.example/f', { fetch: mockFetch([['x.example', res]]).fetch }, Date.now() + 5000);

  it('accepts application/pdf, and accepts %PDF magic bytes behind a generic content-type', async () => {
    expect(await verify(pdfResponse)).toBe(true);
    expect(await verify(() => new Response('%PDF-1.7 ...', { headers: { 'content-type': 'application/octet-stream' } }))).toBe(true);
  });

  it('rejects an HTML page, an error status, and a network failure', async () => {
    expect(await verify(() => new Response('<html>Please log in</html>', { headers: { 'content-type': 'text/html' } }))).toBe(false);
    expect(await verify(() => new Response('%PDF', { status: 403 }))).toBe(false);
    expect(await verify(() => Promise.reject(new Error('offline')))).toBe(false);
  });

  it('upgrades http to https before fetching', async () => {
    const { fetch, calls } = mockFetch([['x.example', pdfResponse]]);
    await verifyPdf('http://x.example/f.pdf', { fetch }, Date.now() + 5000);
    expect(calls[0]).toMatch(/^https:\/\//);
  });
});

describe('source order and stopping at the first PDF', () => {
  const sources = (over: Partial<Record<string, Route>> = {}) =>
    mockFetch([
      ['export.arxiv.org', over.arxiv ?? (() => xml('<feed></feed>'))],
      ['semanticscholar.org', over.s2 ?? (() => json({ data: [] }))],
      ['api.openalex.org', over.oa ?? (() => json({ results: [] }))],
      ['archive.org/advancedsearch', over.ia ?? (() => json({ response: { docs: [] } }))],
      ['arxiv.org/pdf', pdfResponse],
      ['cdn.example', pdfResponse],
      ['archive.org/metadata', () => json({ files: [{ name: 'paper.pdf', format: 'Text PDF' }] })],
      ['archive.org/download', pdfResponse],
    ]);

  it('the default order is arXiv, Semantic Scholar, OpenAlex, Internet Archive', () => {
    expect(DEFAULT_SOURCE_ORDER).toEqual(['arxiv', 'semantic_scholar', 'openalex', 'internet_archive']);
  });

  it('stops at arXiv when it has a verified PDF: no other source is even queried', async () => {
    const { fetch, calls } = sources({ arxiv: () => xml(arxivXml(TITLE)) });
    const result = await findPdf(TITLE, { fetch });
    expect(result).toMatchObject({ found: true, source: 'arxiv', pdfUrl: 'https://arxiv.org/pdf/1706.03762v7' });
    expect(calls.filter((u) => /semanticscholar|openalex|archive\.org/.test(u))).toEqual([]);
  });

  it('falls through in order until one verifies, and logs each lookup', async () => {
    const logs: LookupLog[] = [];
    const { fetch } = sources({
      s2: () => json({ data: [{ title: 'Some Other Paper Entirely', openAccessPdf: { url: 'https://cdn.example/other.pdf' } }] }),
      oa: () => json({ results: [{ title: TITLE, best_oa_location: { pdf_url: 'https://cdn.example/a.pdf' } }] }),
    });
    const result = await findPdf(TITLE, { fetch, log: (l) => logs.push(l) });
    expect(result).toMatchObject({ found: true, source: 'openalex' });
    expect(logs.map((l) => l.source)).toEqual(['arxiv', 'semantic_scholar', 'openalex']);
    expect(logs.map((l) => l.query)).toEqual([TITLE, TITLE, TITLE]); // only the title was sent
    expect(logs[1]!.result).toMatch(/none matched/);
    expect(logs[2]!.result).toMatch(/verified/);
  });

  it('skips a matching title whose PDF does not verify and moves on', async () => {
    const { fetch } = sources({
      arxiv: () => xml(arxivXml(TITLE)),
    });
    const broken = mockFetch([
      ['export.arxiv.org', () => xml(arxivXml(TITLE))],
      ['arxiv.org/pdf', () => new Response('<html>paywall</html>', { headers: { 'content-type': 'text/html' } })],
      ['archive.org/advancedsearch', () => json({ response: { docs: [{ identifier: 'ia-1', title: TITLE }] } })],
      ['archive.org/metadata', () => json({ files: [{ name: 'a b.pdf', format: 'Text PDF' }] })],
      ['archive.org/download', pdfResponse],
    ]);
    void fetch;
    const result = await findPdf(TITLE, { fetch: broken.fetch });
    expect(result).toMatchObject({ found: true, source: 'internet_archive', pdfUrl: 'https://archive.org/download/ia-1/a%20b.pdf' });
  });

  it('a learned source order puts the user\'s sources first', async () => {
    const { fetch, calls } = sources({
      oa: () => json({ results: [{ title: TITLE, best_oa_location: { pdf_url: 'https://cdn.example/a.pdf' } }] }),
    });
    const result = await findPdf(TITLE, { fetch, sourceOrder: ['openalex'] });
    expect(result).toMatchObject({ found: true, source: 'openalex' });
    expect(calls.some((u) => u.includes('export.arxiv.org'))).toBe(false);
  });

  it('a DOI is used directly, with no fuzzy title check', async () => {
    const { fetch, calls } = mockFetch([
      ['semanticscholar.org/graph/v1/paper/DOI:', () => json({ title: 'A Totally Different Looking Title', openAccessPdf: { url: 'https://cdn.example/d.pdf' } })],
      ['cdn.example', pdfResponse],
    ]);
    const result = await findPdf('Deep learning 10.1038/nature14539.', { fetch });
    expect(result).toMatchObject({ found: true, source: 'semantic_scholar' });
    expect(calls[0]).toContain('DOI:10.1038%2Fnature14539');
  });
});

describe('not found, errors and limits', () => {
  it('no free PDF: reports a quoted Google search instead', async () => {
    const { fetch } = mockFetch([]);
    const result = await findPdf('Zzyzx quantum marmalade theorem', { fetch });
    expect(result).toEqual({ found: false, query: 'Zzyzx quantum marmalade theorem', searchUrl: googleSearchUrl('Zzyzx quantum marmalade theorem') });
  });

  it('a failing source (rate limit, outage) is logged and skipped, not fatal', async () => {
    const logs: LookupLog[] = [];
    const { fetch } = mockFetch([
      ['export.arxiv.org', () => new Response('x', { status: 503 })],
      ['semanticscholar.org', () => new Response('{}', { status: 429 })],
      ['api.openalex.org', () => json({ results: [{ title: TITLE, best_oa_location: { pdf_url: 'https://cdn.example/a.pdf' } }] })],
      ['cdn.example', pdfResponse],
    ]);
    const result = await findPdf(TITLE, { fetch, log: (l) => logs.push(l) });
    expect(result).toMatchObject({ found: true, source: 'openalex' });
    expect(logs[0]!.result).toBe('error: HTTP 503');
    expect(logs[1]!.result).toBe('error: HTTP 429');
  });

  it('a hanging request is cut off by the per-request timeout, and the run still finishes', async () => {
    const hang = ((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    const started = Date.now();
    const result = await findPdf(TITLE, { fetch: hang, requestTimeoutMs: 20, totalTimeoutMs: 500 });
    expect(result.found).toBe(false);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('the whole run is capped: once the time limit passes, remaining sources are skipped', async () => {
    let t = 0;
    const logs: LookupLog[] = [];
    const { fetch, calls } = mockFetch([['export.arxiv.org', () => { t += 20_000; return xml('<feed></feed>'); }]]);
    const result = await findPdf(TITLE, { fetch, now: () => t, log: (l) => logs.push(l) });
    expect(result.found).toBe(false);
    expect(calls).toHaveLength(1);
    expect(logs.slice(1).every((l) => /time limit/.test(l.result))).toBe(true);
  });

  it('only the capped selection is sent: a 1000-char selection reaches the API as at most 300 chars', async () => {
    const { fetch, calls } = mockFetch([]);
    await findPdf('word '.repeat(300), { fetch });
    const arxivCall = decodeURIComponent(calls.find((u) => u.includes('export.arxiv.org'))!.split('search_query=')[1]!.split('&')[0]!);
    expect(arxivCall.length).toBeLessThanOrEqual(MAX_QUERY_CHARS + 6);
  });
});

describe('arXiv feed parsing', () => {
  it('reads titles and pdf links, upgrades to https, and falls back to the abs id', () => {
    expect(parseArxiv(arxivXml(TITLE))).toEqual([{ title: TITLE, pdfUrl: 'https://arxiv.org/pdf/1706.03762v7', source: 'arxiv' }]);
    const noLink = '<feed><entry><id>http://arxiv.org/abs/2001.00001v1</id><title>T &amp; U</title></entry></feed>';
    expect(parseArxiv(noLink)).toEqual([{ title: 'T & U', pdfUrl: 'https://arxiv.org/pdf/2001.00001v1', source: 'arxiv' }]);
  });
});
