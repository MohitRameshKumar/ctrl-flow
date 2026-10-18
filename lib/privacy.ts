import { isRootUrl, rootUrlOf } from './sites.ts';
import type { BlocklistConfig, EventKind, ExclusionMode } from './types';

/** Email defaults to "visit only". */
export const DEFAULT_VISIT_ONLY = ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com'] as const;

export const DEFAULT_BLOCKLIST: BlocklistConfig = {
  domains: [
    'chase.com',
    'bankofamerica.com',
    'wellsfargo.com',
    'paypal.com',
    'venmo.com',
    'accounts.google.com',
    // Password managers (PRIV-7): on by default.
    '1password.com',
    'bitwarden.com',
    'lastpass.com',
    'dashlane.com',
    'keepersecurity.com',
    'nordpass.com',
  ],
  substrings: ['mychart'],
  // Email is where a lot of routines start, so it is recorded as visits only (the root URL, nothing
  // else) rather than not at all. Banking, health and password managers stay "never".
  visitOnly: [...DEFAULT_VISIT_ONLY],
};

export async function isPaused(): Promise<boolean> {
  const { paused } = await chrome.storage.local.get<{ paused?: boolean }>('paused');
  return paused === true;
}

export async function getBlocklist(): Promise<BlocklistConfig> {
  const { blocklist } = await chrome.storage.local.get<{ blocklist?: BlocklistConfig }>(
    'blocklist',
  );
  return blocklist ?? DEFAULT_BLOCKLIST;
}

function listed(domain: string, entries: readonly string[] | undefined): boolean {
  const d = domain.toLowerCase();
  return (entries ?? []).some((entry) => {
    const e = entry.toLowerCase();
    return d === e || d.endsWith(`.${e}`);
  });
}

/** How a site is excluded, if at all. "Never" wins when a site is in both lists. */
export function exclusionMode(domain: string, blocklist: BlocklistConfig): ExclusionMode | null {
  const d = domain.toLowerCase();
  if (blocklist.substrings.some((sub) => d.includes(sub.toLowerCase())) || listed(d, blocklist.domains)) return 'never';
  if (listed(d, blocklist.visitOnly)) return 'visit-only';
  return null;
}

/**
 * Is this site excluded in *any* mode? Everything that decides "may I read or learn from this page"
 * uses this, so a visit-only site is treated as off-limits everywhere except the one place that
 * records its bare root visit (`decideExclusion`, used by the event writer) and the macro replay.
 */
export function isBlocklisted(domain: string, blocklist: BlocklistConfig): boolean {
  return exclusionMode(domain, blocklist) !== null;
}

/** "Never record" only: sites whose visits are not recorded at all. */
export function isNeverRecorded(domain: string, blocklist: BlocklistConfig): boolean {
  return exclusionMode(domain, blocklist) === 'never';
}

/** Event kinds that describe *visiting* a page. Everything else (clicks, fields, copies, typing, downloads, closes) is dropped on a visit-only site. */
const VISIT_KINDS: ReadonlySet<EventKind> = new Set(['tab_opened', 'tab_activated', 'navigated']);

export type ExclusionDecision =
  | { action: 'record' }
  | { action: 'drop' }
  /** Record only this root URL: no title, path, selector, label, field or key data. */
  | { action: 'root'; url: string };

/**
 * What the event writer does with an event on `domain`. Pure, so the rule is unit-tested.
 * In-page (SPA) navigations are dropped for visit-only sites: the path is exactly what must not be kept.
 */
export function decideExclusion(
  kind: EventKind,
  domain: string,
  blocklist: BlocklistConfig,
  opts: { spa?: boolean } = {},
): ExclusionDecision {
  const mode = exclusionMode(domain, blocklist);
  if (mode === null) return { action: 'record' };
  if (mode === 'never') return { action: 'drop' };
  if (!VISIT_KINDS.has(kind) || opts.spa) return { action: 'drop' };
  return { action: 'root', url: rootUrlOf(domain) };
}

/**
 * Field names/ids/labels that mark a credential or payment input. `macro-injected.ts` carries an
 * inline copy (an injected function cannot import); tests/type-step.test.ts keeps the two in step.
 */
export const SENSITIVE_RE =
  /pass|card|cvv|cvc|csc|ssn|pin|routing|account|expir|exp[-_ ]?(date|month|year|mm|yy)|ccnum|cc[-_ ]?(num|exp|csc|number)|iban|security[-_ ]?code|one[-_ ]?time|otp/i;

export function isSensitiveField(
  fieldType: string,
  autocomplete: string | null,
  fieldName?: string,
): boolean {
  if (fieldType === 'password' || fieldType === 'hidden') return true;

  const ac = (autocomplete ?? '').toLowerCase();
  if (ac.startsWith('cc-') || ac === 'current-password' || ac === 'new-password' || ac === 'one-time-code') return true;

  if (fieldName && SENSITIVE_RE.test(fieldName)) return true;

  return false;
}

/** "https://www.Chase.com/login" -> "chase.com". Returns null for anything that isn't a plausible hostname. */
export function normalizeDomainInput(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0] ?? '';
  host = host.replace(/^www\./, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

/**
 * One-time move for blocklists saved before "visit only" existed: the email defaults were in the
 * never-record list, and now belong in visit-only. Entries the user added themselves are untouched.
 */
export function migrateEmailToVisitOnly(stored: BlocklistConfig): BlocklistConfig {
  const email = new Set<string>(DEFAULT_VISIT_ONLY);
  const visitOnly = [...(stored.visitOnly ?? [])];
  for (const d of DEFAULT_VISIT_ONLY) if (!visitOnly.includes(d)) visitOnly.push(d);
  return { ...stored, domains: stored.domains.filter((d) => !email.has(d.toLowerCase())), visitOnly };
}

/** Adds the current default domains to a stored blocklist without touching the user's own entries. */
export function mergeDefaultDomains(stored: BlocklistConfig): BlocklistConfig {
  const have = new Set(stored.domains.map((d) => d.toLowerCase()));
  return { ...stored, domains: [...stored.domains, ...DEFAULT_BLOCKLIST.domains.filter((d) => !have.has(d))] };
}

/** Luhn checksum: true for a plausible payment-card number. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Does literal text look like something that must never be written to disk: a payment-card number,
 * an SSN, or a credential/token? Used before a macro stores hand-typed step text. Conservative on
 * purpose: a false positive costs the user one retyped step, a false negative stores a secret.
 */
export function looksSensitiveText(text: string): boolean {
  const compact = text.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(compact) && passesLuhn(compact)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return true;
  if (/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/.test(text)) return true; // API keys
  if (/\b(ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza)[A-Za-z0-9_-]{10,}/.test(text)) return true;
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text)) return true; // JWT
  if (/\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(text)) return true;
  if (/\b(pass(word|wd)?|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i.test(text)) return true;
  if (/^[A-Za-z0-9+/_=-]{32,}$/.test(text.trim())) return true; // one long unbroken token
  return false;
}

/** Is this URL's host on the (current) blocklist / exclusions list? Unparseable URLs are not blocked. */
export function isUrlBlocked(url: string, blocklist: BlocklistConfig): boolean {
  try {
    return isBlocklisted(new URL(url).hostname, blocklist);
  } catch {
    return false;
  }
}

/**
 * May a macro learn from, or open, this URL? "Never" sites: no. "Visit only" sites: only their root
 * (which is all that was ever recorded), so a macro can open Gmail's front page but nothing inside it.
 */
export function isUrlBlockedForMacros(url: string, blocklist: BlocklistConfig): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const mode = exclusionMode(host, blocklist);
  if (mode === null) return false;
  if (mode === 'never') return true;
  return !isRootUrl(url);
}
