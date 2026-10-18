// Part 2 of "Find PDF": recognize the manual routine from behavior alone.
//
//   copy  ->  a Google search whose query contains "pdf"  ->  visits to scholarly sites  ->  a .pdf download
//
// all within ~3 minutes. One sighting is enough (a long action, SPEC §7.3). Pure: it reads event rows,
// which hold only counts, domains and flags: never the copied text, the search query, or file names
// (CAP-1). `pdfSearch` is a boolean computed from the raw URL at event time because stored URLs have
// their query strings stripped.
import type { SourceId } from './pdf-resolver';
import type { CadenceEvent } from './types';

export const PAPER_LOOKUP_WINDOW_MS = 3 * 60 * 1000;

/** Scholarly hosts, and the resolver source each one corresponds to (if any). */
const SCHOLARLY: { match: (host: string) => boolean; source?: SourceId }[] = [
  { match: (h) => is(h, 'arxiv.org'), source: 'arxiv' },
  { match: (h) => is(h, 'semanticscholar.org'), source: 'semantic_scholar' },
  { match: (h) => is(h, 'openalex.org'), source: 'openalex' },
  { match: (h) => is(h, 'archive.org'), source: 'internet_archive' },
  { match: (h) => h === 'scholar.google.com' },
  ...[
    'doi.org', 'acm.org', 'ieee.org', 'springer.com', 'nature.com', 'sciencedirect.com', 'wiley.com', 'jstor.org',
    'plos.org', 'biorxiv.org', 'medrxiv.org', 'researchgate.net', 'ncbi.nlm.nih.gov', 'openreview.net', 'aclanthology.org',
    'mdpi.com', 'ssrn.com', 'neurips.cc', 'mlr.press', 'cvf.com', 'thecvf.com', 'tandfonline.com', 'sagepub.com', 'pnas.org', 'science.org',
  ].map((d) => ({ match: (h: string) => is(h, d) })),
];

function is(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isScholarlyHost(host: string | undefined): boolean {
  return !!host && SCHOLARLY.some((s) => s.match(host.toLowerCase()));
}

export function sourceForHost(host: string | undefined): SourceId | undefined {
  if (!host) return undefined;
  return SCHOLARLY.find((s) => s.match(host.toLowerCase()))?.source;
}

/** A Google results page whose query mentions "pdf". Only this boolean is ever stored, never the query. */
export function isPdfSearchUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname) || u.pathname !== '/search') return false;
    return /\bpdf\b/i.test(u.searchParams.get('q') ?? '');
  } catch {
    return false;
  }
}

export function isPdfDownload(e: Pick<CadenceEvent, 'ext' | 'mime'>): boolean {
  return e.ext?.toLowerCase() === 'pdf' || /pdf/i.test(e.mime ?? '');
}

export interface PaperLookup {
  /** When the download happened. */
  at: number;
  /** Scholarly domains in the order the user visited them (then the download's own domain). */
  domains: string[];
  /** The resolver sources those domains map to, in that order: the preferred order for the command. */
  sources: SourceId[];
}

type PatternEvent = Pick<CadenceEvent, 'ts' | 'kind' | 'domain' | 'pdfSearch' | 'ext' | 'mime' | 'programmatic' | 'synthetic'>;

/**
 * The most recent paper lookup in `events`, or null. A lookup needs, in this order and within the
 * window: a copy, a pdf search, at least one scholarly visit, then a PDF download.
 */
export function detectPaperLookup(events: PatternEvent[], windowMs: number = PAPER_LOOKUP_WINDOW_MS): PaperLookup | null {
  // Synthetic data and ctrl-flow's own actions are never the user's behavior.
  const sorted = events.filter((e) => !e.synthetic && !e.programmatic).sort((a, b) => a.ts - b.ts);
  const downloads = sorted.filter((e) => e.kind === 'download' && isPdfDownload(e));

  for (let i = downloads.length - 1; i >= 0; i--) {
    const download = downloads[i]!;
    const before = sorted.filter((e) => e.ts <= download.ts && download.ts - e.ts <= windowMs);
    const copy = [...before].reverse().find((e) => e.kind === 'copy');
    if (!copy) continue;
    const after = before.filter((e) => e.ts >= copy.ts);
    const search = after.find((e) => e.pdfSearch === true);
    if (!search) continue;
    const visits = after.filter((e) => e.ts >= search.ts && e.kind !== 'download' && e.kind !== 'copy' && isScholarlyHost(e.domain));
    const domains = [...new Set([...visits.map((e) => e.domain!), ...(isScholarlyHost(download.domain) ? [download.domain!] : [])])];
    if (visits.length === 0 && !isScholarlyHost(download.domain)) continue;
    const sources = [...new Set(domains.map(sourceForHost).filter((s): s is SourceId => s !== undefined))];
    return { at: download.ts, domains, sources };
  }
  return null;
}
