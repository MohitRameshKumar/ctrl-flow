// Site identity helpers shared by macros, suggestions, Spaces and notifications. Pure (no chrome.*).
//
//   appName   "mail.google.com" -> "Gmail": people name apps, not hostnames. Multi-product domains
//             (Google, Microsoft 365) are told apart by host and, where the host is shared, by path.
//   canonicalUrl   the same page reached through different account / redirect shapes compares equal.
//   isTransientUrl  pages that are never a routine step: search results and sign-in hops.

/** Brand names for hosts whose second-level label alone says nothing ("google" for ten products). */
const APP_BY_HOST: Record<string, string> = {
  'mail.google.com': 'Gmail',
  'classroom.google.com': 'Classroom',
  'drive.google.com': 'Drive',
  'calendar.google.com': 'Calendar',
  'meet.google.com': 'Meet',
  'chat.google.com': 'Chat',
  'keep.google.com': 'Keep',
  'maps.google.com': 'Maps',
  'photos.google.com': 'Photos',
  'sites.google.com': 'Google Sites',
  'contacts.google.com': 'Contacts',
  'forms.google.com': 'Google Forms',
  'scholar.google.com': 'Google Scholar',
  'colab.research.google.com': 'Colab',
  'accounts.google.com': 'Google Account',
  'myaccount.google.com': 'Google Account',
  'outlook.live.com': 'Outlook',
  'outlook.office.com': 'Outlook',
  'outlook.office365.com': 'Outlook',
  'teams.microsoft.com': 'Teams',
  'teams.live.com': 'Teams',
  'onedrive.live.com': 'OneDrive',
  'office.com': 'Microsoft 365',
  'm365.cloud.microsoft': 'Microsoft 365',
  'word.cloud.microsoft': 'Word',
  'excel.cloud.microsoft': 'Excel',
  'powerpoint.cloud.microsoft': 'PowerPoint',
  'onenote.com': 'OneNote',
  'sharepoint.com': 'SharePoint',
};

/** docs.google.com is three products; the first path segment says which. */
const DOCS_BY_PATH: Record<string, string> = {
  document: 'Google Docs',
  spreadsheets: 'Google Sheets',
  presentation: 'Google Slides',
  forms: 'Google Forms',
  drawings: 'Google Drawings',
};

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function bare(host: string): string {
  return host.replace(/^www\./, '').toLowerCase();
}

/** The app a URL belongs to, when it is one of the multi-product domains; otherwise null. */
export function knownAppName(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  const host = bare(u.hostname);

  if (host === 'docs.google.com') {
    const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
    return DOCS_BY_PATH[first] ?? 'Google Docs';
  }
  const exact = APP_BY_HOST[host];
  if (exact) return exact;
  // *.sharepoint.com (tenant hosts), *.officeapps.live.com
  if (host.endsWith('.sharepoint.com')) return 'SharePoint';
  if (host.endsWith('.officeapps.live.com')) return 'Microsoft 365';
  if (isGoogleSearchHost(host) && u.pathname === '/') return 'Google';
  return null;
}

function isGoogleSearchHost(host: string): boolean {
  return /^(www\.)?google\.[a-z.]{2,6}$/.test(host);
}

/**
 * Google results pages (and sign-in hops) are transient: where you were *on the way* to somewhere.
 * They never become a macro step, a suggestion name or a Space tab. (Find PDF's own detector reads
 * the `pdfSearch` flag stored on the event, so it does not depend on these pages being learned.)
 */
export function isTransientUrl(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  const host = bare(u.hostname);
  if (isGoogleSearchHost(host) && (u.pathname === '/search' || u.pathname.startsWith('/search/') || u.pathname === '/webhp')) return true;
  if (host === 'accounts.google.com') return true;
  // Chrome's own search-redirect shim.
  if (isGoogleSearchHost(host) && u.pathname === '/url') return true;
  return false;
}

/**
 * One key per *page*, not per URL shape. Strips what Google adds to reach the same place:
 *   classroom.google.com/u/0/h  ==  classroom.google.com/h  ==  classroom.google.com/
 * (the account index `/u/N` and a bare home-ish path), a trailing slash, query and fragment.
 */
export function canonicalUrl(url: string): string {
  const u = parse(url);
  if (!u) return url;
  const host = bare(u.hostname);
  let path = u.pathname;
  if (host.endsWith('.google.com') || host === 'google.com') {
    path = path.replace(/^\/u\/\d+(?=\/|$)/, '').replace(/^\/mail\/u\/\d+(?=\/|$)/, '/mail');
    // Per-product "home" aliases: /h (Classroom), /mail (Gmail), /drive/my-drive, /calendar/r.
    if (/^\/(h|mail|home|r)?\/?$/.test(path)) path = '/';
  }
  path = path.replace(/\/+$/, '') || '/';
  return `${u.protocol}//${host}${path}`;
}

/** Same page reached two ways (account prefix, home alias, trailing slash)? */
export function samePage(a: string, b: string): boolean {
  return canonicalUrl(a) === canonicalUrl(b);
}

/** The site root, e.g. "https://mail.google.com/". What a visit-only site is ever recorded as. */
export function rootUrlOf(urlOrHost: string): string {
  const u = parse(urlOrHost) ?? parse(`https://${urlOrHost}`);
  return u ? `${u.protocol}//${u.host}/` : urlOrHost;
}

/** Is this URL a site's root (nothing after the host)? */
export function isRootUrl(url: string): boolean {
  const u = parse(url);
  return !!u && (u.pathname === '/' || u.pathname === '') && u.search === '' && u.hash === '';
}
