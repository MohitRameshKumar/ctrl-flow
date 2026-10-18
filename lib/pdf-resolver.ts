// "Find PDF": turn a paper title (or DOI) into a verified, legally hosted PDF URL.
//
// Deterministic script, no LLM (MOD-1). Sources are tried in order and the first *verified* PDF wins:
//   arXiv -> Semantic Scholar (openAccessPdf) -> OpenAlex (best_oa_location) -> Internet Archive.
// Only the selected text ever leaves the device, only to these four APIs, and only when the user asks.
// Legal sources only: shadow-library hosts are hard-blocked, both as candidates and after redirects.
//
// Pure apart from the injected `fetch`, so every rule is unit-testable with mocked HTTP.

export type SourceId = 'arxiv' | 'semantic_scholar' | 'openalex' | 'internet_archive';

export const DEFAULT_SOURCE_ORDER: SourceId[] = ['arxiv', 'semantic_scholar', 'openalex', 'internet_archive'];

export const SOURCE_NAMES: Record<SourceId, string> = {
  arxiv: 'arXiv',
  semantic_scholar: 'Semantic Scholar',
  openalex: 'OpenAlex',
  internet_archive: 'Internet Archive',
};

export const MAX_QUERY_CHARS = 300;
export const TITLE_MATCH_THRESHOLD = 0.85;
export const REQUEST_TIMEOUT_MS = 5000;
export const TOTAL_TIMEOUT_MS = 15000;
const MAX_CANDIDATES_TRIED = 3;

/** Hosts that distribute copyrighted papers and books without permission. Never fetched, never opened. */
const SHADOW_LIBRARY_MARKERS = [
  'sci-hub', 'scihub', 'sci-net', 'libgen', 'libgenesis', 'library.lol', 'annas-archive', 'annas-',
  'z-lib', 'zlibrary', 'z-library', '1lib', 'b-ok', 'bookfi', 'booksc', 'bookzz', 'pdfcoffee',
];

export function isShadowLibraryHost(hostOrUrl: string): boolean {
  let host = hostOrUrl;
  try {
    host = new URL(hostOrUrl).hostname;
  } catch {
    /* a bare hostname */
  }
  const h = host.toLowerCase();
  return SHADOW_LIBRARY_MARKERS.some((m) => h.includes(m));
}

// ---- text helpers ----------------------------------------------------------------------------------

/** Trim, collapse whitespace, cap. Applied to every selection before anything else touches it. */
export function cleanQuery(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const padded = ` ${s} `;
  for (let i = 0; i < padded.length - 1; i++) {
    const g = padded.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/**
 * 0..1 similarity of two titles: the lower of a character-bigram Dice score (tolerates small typos)
 * and a word-level Dice score (rejects a different paper whose title merely contains this one, such
 * as "Not All Attention Is All You Need"). Both look at the normalized text, so case, punctuation
 * and accents never matter.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dice = (ga: Map<string, number>, gb: Map<string, number>): number => {
    let overlap = 0;
    for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
    const total = [...ga.values()].reduce((s, n) => s + n, 0) + [...gb.values()].reduce((s, n) => s + n, 0);
    return total === 0 ? 0 : (2 * overlap) / total;
  };
  const words = (s: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (const w of s.split(' ')) out.set(w, (out.get(w) ?? 0) + 1);
    return out;
  };
  return Math.min(dice(bigrams(na), bigrams(nb)), dice(words(na), words(nb)));
}

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;

/** A DOI inside the selection (also from a doi.org URL), without trailing punctuation. */
export function extractDoi(text: string): string | null {
  const m = DOI_RE.exec(text);
  if (!m) return null;
  return m[1]!.replace(/[.,;:)\]}]+$/, '');
}

export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`"${query}" pdf`)}`;
}

export function sanitizeFilename(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  return `${base || 'paper'}.pdf`;
}

// ---- verification ----------------------------------------------------------------------------------

export interface Deps {
  fetch: typeof fetch;
  /** One entry per lookup, for the "last outbound request" viewer. */
  log?: (entry: LookupLog) => void;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Sources to try first (e.g. the ones the user actually used); the rest follow in default order. */
  sourceOrder?: SourceId[];
  now?: () => number;
}

export interface LookupLog {
  source: SourceId;
  /** What was sent: the title (or doi:…) and nothing else. */
  query: string;
  result: string;
}

function toHttps(url: string): string {
  return url.replace(/^http:\/\//i, 'https://');
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** One word for the log: `http 429`, or `error (message)` for anything that is not an HTTP status. */
function describeFailure(err: unknown): string {
  if (err instanceof HttpError) return `http ${err.status}`;
  return `error (${err instanceof Error ? err.message : String(err)})`;
}

async function timedFetch(deps: Deps, deadline: number, url: string, init: RequestInit = {}): Promise<Response> {
  const now = deps.now ?? Date.now;
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error('time limit reached');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, remaining));
  try {
    // Detached on purpose: the native fetch throws "Illegal invocation" in a browser or service worker when
    // called as a method of another object (`deps.fetch(...)` binds `this` to `deps`). Node does not care,
    // which is how this shipped past the live check.
    const doFetch = deps.fetch;
    return await doFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readHead(res: Response, bytes: number): Promise<string> {
  try {
    if (res.body) {
      const reader = res.body.getReader();
      const { value } = await reader.read();
      void reader.cancel().catch(() => undefined);
      return new TextDecoder('latin1').decode((value ?? new Uint8Array()).slice(0, bytes));
    }
    return new TextDecoder('latin1').decode((await res.arrayBuffer()).slice(0, bytes));
  } catch {
    return '';
  }
}

export type PdfCheck = { ok: true } | { ok: false; reason: string };

/**
 * Is this URL a real PDF from a legal host (content-type, or `%PDF` first bytes)? Says why when not, so
 * the outbound log can show `verify failed (not a PDF (text/html))` instead of a bare "no".
 */
export async function checkPdf(url: string, deps: Deps, deadline: number): Promise<PdfCheck> {
  if (isShadowLibraryHost(url)) return { ok: false, reason: 'blocked host' };
  let res: Response;
  try {
    res = await timedFetch(deps, deadline, toHttps(url), { headers: { Range: 'bytes=0-1023' }, redirect: 'follow' });
  } catch (err) {
    return { ok: false, reason: describeFailure(err) };
  }
  try {
    if (!(res.ok || res.status === 206)) return { ok: false, reason: `http ${res.status}` };
    if (res.url && isShadowLibraryHost(res.url)) return { ok: false, reason: 'redirected to a blocked host' };
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type.includes('application/pdf')) return { ok: true };
    if ((await readHead(res, 8)).startsWith('%PDF')) return { ok: true };
    return { ok: false, reason: `not a PDF (${type.split(';')[0] || 'unknown type'})` };
  } finally {
    void res.body?.cancel().catch(() => undefined);
  }
}

/** True only if the URL is not a shadow library and really returns a PDF. */
export async function verifyPdf(url: string, deps: Deps, deadline: number): Promise<boolean> {
  return (await checkPdf(url, deps, deadline)).ok;
}

// ---- sources ---------------------------------------------------------------------------------------

export interface Candidate {
  title: string;
  pdfUrl: string;
  source: SourceId;
}

async function getJson(deps: Deps, deadline: number, url: string): Promise<unknown> {
  const res = await timedFetch(deps, deadline, url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status);
  return res.json();
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Atom feed from export.arxiv.org -> candidates (a service worker has no DOMParser, so this is regex). */
export function parseArxiv(xml: string): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of xml.split('<entry>').slice(1)) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1];
    if (!title) continue;
    let pdf: string | undefined;
    for (const link of entry.match(/<link\b[^>]*>/g) ?? []) {
      if (/title="pdf"/.test(link)) pdf = /href="([^"]+)"/.exec(link)?.[1];
    }
    if (!pdf) {
      const id = /<id>[^<]*\/abs\/([^<]+)<\/id>/.exec(entry)?.[1];
      if (id) pdf = `https://arxiv.org/pdf/${id}`;
    }
    if (pdf) out.push({ title: decodeXml(title), pdfUrl: toHttps(pdf), source: 'arxiv' });
  }
  return out;
}

interface S2Paper {
  title?: string;
  openAccessPdf?: { url?: string } | null;
}

function s2Candidates(papers: S2Paper[]): Candidate[] {
  return papers.flatMap((p) => (p.title && p.openAccessPdf?.url ? [{ title: p.title, pdfUrl: toHttps(p.openAccessPdf.url), source: 'semantic_scholar' as const }] : []));
}

interface OaWork {
  title?: string;
  best_oa_location?: { pdf_url?: string | null } | null;
}

function oaCandidates(works: OaWork[]): Candidate[] {
  return works.flatMap((w) => (w.title && w.best_oa_location?.pdf_url ? [{ title: w.title, pdfUrl: toHttps(w.best_oa_location.pdf_url), source: 'openalex' as const }] : []));
}

async function lookup(source: SourceId, title: string, deps: Deps, deadline: number): Promise<Candidate[]> {
  const q = encodeURIComponent(title);
  switch (source) {
    case 'arxiv': {
      const res = await timedFetch(deps, deadline, `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`ti:"${title}"`)}&max_results=5`);
      if (!res.ok) throw new HttpError(res.status);
      return parseArxiv(await res.text());
    }
    case 'semantic_scholar': {
      const json = (await getJson(deps, deadline, `https://api.semanticscholar.org/graph/v1/paper/search?query=${q}&limit=5&fields=title,openAccessPdf`)) as { data?: S2Paper[] };
      return s2Candidates(json.data ?? []);
    }
    case 'openalex': {
      const json = (await getJson(deps, deadline, `https://api.openalex.org/works?search=${q}&per-page=5&select=title,doi,best_oa_location`)) as { results?: OaWork[] };
      return oaCandidates(json.results ?? []);
    }
    case 'internet_archive': {
      const search = encodeURIComponent(`title:(${title}) AND mediatype:texts`);
      const json = (await getJson(deps, deadline, `https://archive.org/advancedsearch.php?q=${search}&fl[]=identifier&fl[]=title&rows=5&output=json`)) as {
        response?: { docs?: { identifier?: string; title?: string }[] };
      };
      const out: Candidate[] = [];
      for (const doc of json.response?.docs ?? []) {
        if (!doc.identifier || !doc.title || titleSimilarity(title, doc.title) < TITLE_MATCH_THRESHOLD) continue;
        const meta = (await getJson(deps, deadline, `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`)) as { files?: { name?: string; format?: string }[] };
        const file = (meta.files ?? []).find((f) => f.name?.toLowerCase().endsWith('.pdf') && /pdf/i.test(f.format ?? 'pdf'));
        if (file?.name) out.push({ title: doc.title, pdfUrl: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(file.name)}`, source: 'internet_archive' });
      }
      return out;
    }
  }
}

/** DOI lookups skip fuzzy title matching: the DOI identifies the paper. Only S2 and OpenAlex resolve DOIs. */
async function lookupDoi(source: SourceId, doi: string, deps: Deps, deadline: number): Promise<Candidate[]> {
  if (source === 'semantic_scholar') {
    const json = (await getJson(deps, deadline, `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title,openAccessPdf`)) as S2Paper;
    return s2Candidates([json]);
  }
  if (source === 'openalex') {
    const json = (await getJson(deps, deadline, `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}?select=title,best_oa_location`)) as OaWork;
    return oaCandidates([json]);
  }
  return [];
}

// ---- the resolver ----------------------------------------------------------------------------------

export type FindPdfResult =
  | { found: true; source: SourceId; title: string; pdfUrl: string }
  | {
      found: false;
      query: string;
      searchUrl: string;
      /**
       * True when this looks like a fault rather than "no free PDF exists": some source threw (not an HTTP
       * status), or every lookup failed. The caller then reports an error instead of opening a search.
       */
      errored: boolean;
    };

function orderedSources(preferred: SourceId[] | undefined): SourceId[] {
  const first = (preferred ?? []).filter((s): s is SourceId => DEFAULT_SOURCE_ORDER.includes(s));
  return [...new Set([...first, ...DEFAULT_SOURCE_ORDER])];
}

/**
 * Resolves `selection` to a verified PDF, or reports that none was found. Stops at the first PDF that
 * passes verification. Each request is capped at ~5 s and the whole run at ~15 s (MOD-6).
 */
export async function findPdf(selection: string, deps: Deps): Promise<FindPdfResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
  const query = cleanQuery(selection);
  const sources = orderedSources(deps.sourceOrder);
  const doi = extractDoi(query);
  const log = deps.log ?? (() => undefined);

  let attempts = 0;
  let failures = 0;
  let exceptions = 0;
  const fail = (source: SourceId, label: string, err: unknown): void => {
    const text = describeFailure(err);
    failures++;
    if (text.startsWith('error')) exceptions++;
    log({ source, query: label, result: text });
  };

  const tryCandidates = async (source: SourceId, label: string, candidates: Candidate[], needsMatch: boolean): Promise<FindPdfResult | null> => {
    const scored = candidates
      .filter((c) => !isShadowLibraryHost(c.pdfUrl))
      .map((c) => ({ c, sim: needsMatch ? titleSimilarity(label, c.title) : 1 }));
    const ranked = scored
      .filter((x) => x.sim >= TITLE_MATCH_THRESHOLD)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, MAX_CANDIDATES_TRIED);
    if (ranked.length === 0) {
      const best = scored.reduce((m, x) => Math.max(m, x.sim), 0);
      log({ source, query: label, result: scored.length === 0 ? 'no match (no results)' : `no match (best score ${best.toFixed(2)})` });
      return null;
    }
    const reasons: string[] = [];
    for (const { c, sim } of ranked) {
      const check = await checkPdf(c.pdfUrl, deps, deadline);
      if (check.ok) {
        log({ source, query: label, result: `found (match ${sim.toFixed(2)})` });
        return { found: true, source, title: c.title, pdfUrl: toHttps(c.pdfUrl) };
      }
      reasons.push(check.reason);
      if (check.reason.startsWith('error')) exceptions++;
    }
    log({ source, query: label, result: `verify failed (${[...new Set(reasons)].join('; ')})` });
    return null;
  };

  if (doi) {
    for (const source of sources) {
      if (source !== 'semantic_scholar' && source !== 'openalex') continue;
      attempts++;
      try {
        const hit = await tryCandidates(source, `doi:${doi}`, await lookupDoi(source, doi, deps, deadline), false);
        if (hit) return hit;
      } catch (err) {
        fail(source, `doi:${doi}`, err);
      }
    }
  }

  const title = cleanQuery(doi ? query.replace(DOI_RE, ' ') : query);
  if (title.length >= 8) {
    for (const source of sources) {
      if (deadline - now() <= 0) {
        log({ source, query: title, result: 'skipped: time limit reached' });
        continue;
      }
      attempts++;
      try {
        const hit = await tryCandidates(source, title, await lookup(source, title, deps, deadline), true);
        if (hit) return hit;
      } catch (err) {
        fail(source, title, err);
      }
    }
  }

  return { found: false, query, searchUrl: googleSearchUrl(query), errored: exceptions > 0 || (attempts > 0 && failures === attempts) };
}
