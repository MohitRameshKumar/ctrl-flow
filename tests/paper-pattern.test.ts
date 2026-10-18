// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PAPER_LOOKUP_WINDOW_MS, detectPaperLookup, isPdfSearchUrl, isScholarlyHost, sourceForHost } from '@/lib/paper-pattern';
import { cleanSelection, readSelection } from '@/lib/selection';
import { buildFindPdfCommand, buildFindPdfSuggestion, commandSteps } from '@/lib/find-pdf-command';
import { visibleSuggestions } from '@/lib/macro-suggestions';
import { macro, openStep } from './helpers';
import type { CadenceEvent } from '@/lib/types';

const T0 = 5_000_000;
const sec = (n: number) => T0 + n * 1000;
const ev = (ts: number, kind: CadenceEvent['kind'], over: Partial<CadenceEvent> = {}): CadenceEvent => ({ ts, kind, ...over });

/** copy -> Google "… pdf" -> arXiv -> pdf download, all inside 3 minutes. */
const routine = (): CadenceEvent[] => [
  ev(sec(0), 'copy', { domain: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Transformer' }),
  ev(sec(8), 'navigated', { domain: 'www.google.com', url: 'https://www.google.com/search', pdfSearch: true }),
  ev(sec(20), 'tab_opened', { domain: 'arxiv.org', url: 'https://arxiv.org/abs/1706.03762' }),
  ev(sec(40), 'download', { domain: 'arxiv.org', url: 'https://arxiv.org/pdf/1706.03762', ext: 'pdf', mime: 'application/pdf' }),
];

describe('the paper-lookup pattern (detectPaperLookup)', () => {
  it('copy -> pdf search -> scholarly visit -> pdf download is recognized after a single occurrence', () => {
    const hit = detectPaperLookup(routine());
    expect(hit).toMatchObject({ at: sec(40), domains: ['arxiv.org'], sources: ['arxiv'] });
  });

  it('keeps the order the user actually visited sites in (so the command prefers them)', () => {
    const events = [
      ...routine().slice(0, 2),
      ev(sec(14), 'tab_opened', { domain: 'scholar.google.com' }),
      ev(sec(18), 'tab_opened', { domain: 'www.semanticscholar.org' }),
      ev(sec(25), 'tab_opened', { domain: 'archive.org' }),
      ev(sec(40), 'download', { domain: 'archive.org', ext: 'pdf' }),
    ];
    const hit = detectPaperLookup(events)!;
    expect(hit.domains).toEqual(['scholar.google.com', 'www.semanticscholar.org', 'archive.org']);
    expect(hit.sources).toEqual(['semantic_scholar', 'internet_archive']);
  });

  it('a publisher site counts as scholarly; the download source can be the only scholarly visit', () => {
    const events = [
      ev(sec(0), 'copy'),
      ev(sec(5), 'navigated', { domain: 'google.com', pdfSearch: true }),
      ev(sec(30), 'download', { domain: 'link.springer.com', ext: 'pdf' }),
    ];
    expect(detectPaperLookup(events)).toMatchObject({ domains: ['link.springer.com'], sources: [] });
  });

  it('a pdf recognized by mime type alone (no extension) counts', () => {
    const events = routine();
    events[3] = ev(sec(40), 'download', { domain: 'arxiv.org', mime: 'application/pdf' });
    expect(detectPaperLookup(events)).not.toBeNull();
  });

  // ---- negatives ----
  it('no copy: nothing', () => {
    expect(detectPaperLookup(routine().filter((e) => e.kind !== 'copy'))).toBeNull();
  });

  it('a search that does not mention pdf: nothing', () => {
    expect(detectPaperLookup(routine().map((e) => ({ ...e, pdfSearch: undefined })))).toBeNull();
  });

  it('no scholarly site anywhere: nothing', () => {
    const events = [
      ev(sec(0), 'copy'),
      ev(sec(8), 'navigated', { domain: 'google.com', pdfSearch: true }),
      ev(sec(20), 'tab_opened', { domain: 'randomblog.example' }),
      ev(sec(40), 'download', { domain: 'randomblog.example', ext: 'pdf' }),
    ];
    expect(detectPaperLookup(events)).toBeNull();
  });

  it('a download that is not a PDF: nothing', () => {
    expect(detectPaperLookup(routine().map((e) => (e.kind === 'download' ? { ...e, ext: 'zip', mime: 'application/zip' } : e)))).toBeNull();
  });

  it('wrong order (download before the copy and the search): nothing', () => {
    const events = [
      ev(sec(0), 'download', { domain: 'arxiv.org', ext: 'pdf' }),
      ev(sec(10), 'copy'),
      ev(sec(20), 'navigated', { domain: 'google.com', pdfSearch: true }),
      ev(sec(30), 'tab_opened', { domain: 'arxiv.org' }),
    ];
    expect(detectPaperLookup(events)).toBeNull();
  });

  it('too slow: more than 3 minutes between the copy and the download: nothing', () => {
    const events = routine();
    events[3] = ev(sec(0) + PAPER_LOOKUP_WINDOW_MS + 1000, 'download', { domain: 'arxiv.org', ext: 'pdf' });
    expect(detectPaperLookup(events)).toBeNull();
  });

  it('ctrl-flow\'s own actions and simulated data are never the user\'s behavior', () => {
    expect(detectPaperLookup(routine().map((e) => ({ ...e, programmatic: true })))).toBeNull();
    expect(detectPaperLookup(routine().map((e) => ({ ...e, synthetic: true })))).toBeNull();
  });
});

describe('what is (and is not) stored', () => {
  it('only a boolean for "google search that mentions pdf", from the raw URL', () => {
    expect(isPdfSearchUrl('https://www.google.com/search?q=attention+is+all+you+need+online+pdf')).toBe(true);
    expect(isPdfSearchUrl('https://www.google.co.uk/search?q=Paper+PDF&hl=en')).toBe(true);
    expect(isPdfSearchUrl('https://www.google.com/search?q=attention+is+all+you+need')).toBe(false);
    expect(isPdfSearchUrl('https://www.google.com/search?q=pdfs+are+great')).toBe(false);
    expect(isPdfSearchUrl('https://duckduckgo.com/?q=paper+pdf')).toBe(false);
    expect(isPdfSearchUrl('https://example.com/search?q=paper+pdf')).toBe(false);
    expect(isPdfSearchUrl(undefined)).toBe(false);
  });

  it('scholarly domains and the resolver sources they map to', () => {
    expect(isScholarlyHost('export.arxiv.org')).toBe(true);
    expect(isScholarlyHost('www.nature.com')).toBe(true);
    expect(isScholarlyHost('notarxiv.org')).toBe(false);
    expect(sourceForHost('www.semanticscholar.org')).toBe('semantic_scholar');
    expect(sourceForHost('scholar.google.com')).toBeUndefined();
  });
});

describe('the selection variable', () => {
  it('is trimmed, whitespace-collapsed and capped at 300 characters', () => {
    expect(cleanSelection('  Attention\n  Is   All ')).toBe('Attention Is All');
    expect(cleanSelection('y'.repeat(900))).toHaveLength(300);
  });

  it('is read from the page selection and from a selected range inside a text input; never from a password field', () => {
    document.body.innerHTML = '<p id="p">Attention Is All You Need</p><input id="t" value="hello world" /><input id="pw" type="password" value="hunter2" />';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(readSelection()).toBe('Attention Is All You Need');

    const input = document.getElementById('t') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 5);
    expect(readSelection()).toBe('hello');

    const pw = document.getElementById('pw') as HTMLInputElement;
    pw.focus();
    pw.setSelectionRange(0, 7);
    expect(readSelection()).toBe('');
  });
});

describe('the saved Find PDF command', () => {
  it('is a suggestion with the paper_title selection variable and the sources the user used first', () => {
    const m = buildFindPdfSuggestion(['openalex', 'arxiv'], 1);
    expect(m).toMatchObject({ name: 'Find PDF', status: 'suggested', steps: [], occurrences: 1 });
    expect(m.command).toEqual({
      kind: 'find_pdf',
      variables: [{ name: 'paper_title', source: 'selection' }],
      sourceOrder: ['openalex', 'arxiv', 'semantic_scholar', 'internet_archive'],
    });
  });

  it('lists readable steps, preferred sources first', () => {
    expect(commandSteps(buildFindPdfCommand(['internet_archive']))).toEqual([
      'Take paper_title from your selected text',
      'Look it up on Internet Archive',
      'Look it up on arXiv',
      'Look it up on Semantic Scholar',
      'Look it up on OpenAlex',
      'Download the first verified PDF',
      'If there is none, open a Google search',
    ]);
  });

  it('always shows in Macros suggestions even next to stronger route suggestions', () => {
    const routes = [1, 2, 3].map((i) => ({ ...macro({ steps: [openStep(`https://a${i}.com/`), openStep(`https://b${i}.com/`)], status: 'suggested', occurrences: 9 }), id: i }));
    const cmd = { ...buildFindPdfSuggestion([], 1), id: 99 };
    const shown = visibleSuggestions([...routes, cmd], Date.now());
    expect(shown).toHaveLength(2);
    expect(shown[0]!.id).toBe(99);
  });
});
