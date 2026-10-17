import type { BlocklistConfig } from './types';

export const DEFAULT_BLOCKLIST: BlocklistConfig = {
  domains: [
    'chase.com',
    'bankofamerica.com',
    'wellsfargo.com',
    'paypal.com',
    'venmo.com',
    'mail.google.com',
    'outlook.live.com',
    'outlook.office.com',
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

export function isBlocklisted(domain: string, blocklist: BlocklistConfig): boolean {
  const d = domain.toLowerCase();
  if (blocklist.substrings.some((sub) => d.includes(sub.toLowerCase()))) return true;
  return blocklist.domains.some((entry) => {
    const e = entry.toLowerCase();
    return d === e || d.endsWith(`.${e}`);
  });
}

const SENSITIVE_RE = /pass|card|cvv|cvc|ssn|pin|routing|account/i;

export function isSensitiveField(
  fieldType: string,
  autocomplete: string | null,
  fieldName?: string,
): boolean {
  if (fieldType === 'password' || fieldType === 'hidden') return true;

  const ac = (autocomplete ?? '').toLowerCase();
  if (ac.startsWith('cc-') || ac === 'current-password' || ac === 'new-password') return true;

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
