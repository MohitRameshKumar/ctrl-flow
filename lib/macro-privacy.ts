// Cadence-side privacy rules for macros, in one place so the store path and the replay path cannot
// drift: (1) the single gate for typed text, (2) redaction of macro variable values.
import { SENSITIVE_RE, isUrlBlocked, looksSensitiveText } from './privacy';
import type { BlocklistConfig, MacroParam } from './types';

/**
 * TYPED-VALUE POLICY. Typed text is never captured from the page and never written to the event log
 * (events carry key counts and field names only). The only way text enters a macro is a hand-authored
 * `type` step, and it must pass this gate both when it is stored (`db.addMacroStep`) and again when
 * it is replayed (`macro-host-chrome.type`), against the *current* exclusions. Secrets are refused
 * rather than masked: a masked value would type garbage into a real field.
 */
export type TypedCheck = { ok: true } | { ok: false; reason: string };

export function checkTypedStep(
  input: { text: string; url?: string; selector?: string },
  blocklist: BlocklistConfig,
): TypedCheck {
  if (looksSensitiveText(input.text)) {
    return { ok: false, reason: 'That text looks like a password, token or card number.' };
  }
  if (input.url && isUrlBlocked(input.url, blocklist)) {
    return { ok: false, reason: 'That page is on your excluded sites.' };
  }
  if (input.selector && SENSITIVE_RE.test(input.selector)) {
    return { ok: false, reason: 'That selector points at a password or payment field.' };
  }
  return { ok: true };
}

export const MAX_PARAM_EXAMPLES = 3;

const EMAIL_RE = /[^\s/@]+@[^\s/@]+\.[^\s/@]+/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path segment that is an email, UUID, long hex id, or opaque mixed letters+digits token. */
export function looksLikeOpaqueId(value: string): boolean {
  let v = value;
  try {
    v = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  if (EMAIL_RE.test(v) || UUID_RE.test(v)) return true;
  if (/^[0-9a-f]{16,}$/i.test(v)) return true;
  return /^[A-Za-z0-9_-]{20,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);
}

/** '' when the value must not be stored. Short numbers and plain slugs ("123", "my-repo") are fine. */
export function redactParamValue(value: string): string {
  if (!value) return '';
  return looksSensitiveText(value) || looksLikeOpaqueId(value) ? '' : value;
}

export function sanitizeParam(param: MacroParam): MacroParam {
  const examples = [...new Set(param.examples.map(redactParamValue).filter(Boolean))].slice(-MAX_PARAM_EXAMPLES);
  return { ...param, examples, lastValue: redactParamValue(param.lastValue) };
}

export function sanitizeParams(params: MacroParam[] | undefined): MacroParam[] {
  return (params ?? []).map(sanitizeParam);
}
