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
