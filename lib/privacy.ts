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
