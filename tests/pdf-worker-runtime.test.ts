// Reproduces the resolver under the constraints of an MV3 service worker, which the live check
// (plain Node) did not have:
//   - no DOM at all: no DOMParser, document, window
//   - `fetch` is a native that throws "Illegal invocation" if called as a method of another object
//   - arXiv's Atom has newlines and runs of spaces inside <title>
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findPdf, parseArxiv, type LookupLog } from '@/lib/pdf-resolver';

const TITLE = 'Attention Is All You Need';

/** A real arXiv API response (trimmed), including the multi-line, double-spaced titles the API returns. */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query%3Dti%3A%22Attention%20Is%20All%20You%20Need%22" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=ti:&quot;Attention Is All You Need&quot;&amp;id_list=&amp;start=0&amp;max_results=3</title>
  <id>http://arxiv.org/api/aNzJ8ZKyG0Mw1kjtAd3vq1gVmio</id>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">2</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You
  Need</title>
    <summary>The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks...</summary>
    <author><name>Ashish Vaswani</name></author>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2110.04544v1</id>
    <title>Not  All   Attention Is All You Need</title>
    <link href="http://arxiv.org/pdf/2110.04544v1" rel="related" type="application/pdf" title="pdf"/>
  </entry>
</feed>`;

/** Like the browser's fetch: refuses to run when called as a method of some other object. */
function workerFetch(routes: [string, () => Response][]) {
  const calls: string[] = [];
  const fn = function (this: unknown, input: RequestInfo | URL): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      return Promise.reject(new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation"));
    }
    const url = String(input);
    calls.push(url);
    for (const [needle, make] of routes) if (url.includes(needle)) return Promise.resolve(make());
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const pdf = () => new Response('%PDF-1.5 body', { status: 200, headers: { 'content-type': 'application/pdf' } });

describe('Find PDF under service-worker constraints', () => {
  beforeEach(() => {
    for (const name of ['DOMParser', 'document', 'window']) vi.stubGlobal(name, undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('there is no DOM available to the resolver in this test', () => {
    expect(typeof DOMParser).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('parses the real multi-line Atom feed without a DOM, normalizing the title', () => {
    const entries = parseArxiv(ATOM);
    expect(entries.map((e) => e.title)).toEqual(['Attention Is All You Need', 'Not All Attention Is All You Need']);
    expect(entries[0]).toMatchObject({ pdfUrl: 'https://arxiv.org/pdf/1706.03762v7', source: 'arxiv' });
    expect(entries[1]!.pdfUrl).toBe('https://arxiv.org/pdf/2110.04544v1'); // link attributes in a different order
  });

  it('finds and verifies the PDF from arXiv with a fetch that enforces browser calling rules', async () => {
    const { fetch, calls } = workerFetch([
      ['export.arxiv.org', () => new Response(ATOM, { status: 200 })],
      ['arxiv.org/pdf/1706.03762v7', pdf],
    ]);
    const logs: LookupLog[] = [];
    const result = await findPdf(TITLE, { fetch, log: (l) => logs.push(l) });
    expect(logs).toEqual([{ source: 'arxiv', query: TITLE, result: expect.stringMatching(/^found/) }]);
    expect(result).toMatchObject({ found: true, source: 'arxiv', pdfUrl: 'https://arxiv.org/pdf/1706.03762v7' });
    expect(calls).toHaveLength(2);
  });

  it('also copes with whitespace and a trailing newline in the selection it receives', async () => {
    const { fetch } = workerFetch([
      ['export.arxiv.org', () => new Response(ATOM, { status: 200 })],
      ['arxiv.org/pdf/1706.03762v7', pdf],
    ]);
    const result = await findPdf('  Attention  Is\n All You Need \n', { fetch });
    expect(result).toMatchObject({ found: true, source: 'arxiv' });
  });
});
