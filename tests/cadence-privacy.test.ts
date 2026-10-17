// @vitest-environment happy-dom
// Cadence-side privacy additions on top of the macro feature: payment fields, replay-time exclusions,
// param redaction, the typed-value gate, standup/coverage domain filtering, and Leader R's plan.
import { beforeEach, describe, expect, it } from 'vitest';
import { executeMacro } from '@/lib/macro-executor';
import { typeIntoSelector } from '@/lib/macro-injected';
import { checkTypedStep, looksLikeOpaqueId, redactParamValue, sanitizeParam } from '@/lib/macro-privacy';
import { lastCompletedSegment, planRepeat } from '@/lib/macro-repeat';
import { SENSITIVE_RE } from '@/lib/privacy';
import { buildCoverageInput, buildStandupInput } from '@/lib/standup-input';
import type { BlocklistConfig, ObservedAction } from '@/lib/types';
import { createFakeHost, freshRunState } from './fake-host';
import { A, B, macro, openStep } from './helpers';

const blocklist: BlocklistConfig = { domains: ['bank.example'], substrings: [] };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('payment and credential fields are refused at replay', () => {
  const refused = [
    '<input id="f" autocomplete="cc-number" />',
    '<input id="f" autocomplete="cc-exp" />',
    '<input id="f" autocomplete="one-time-code" />',
    '<input id="f" name="cardnumber" />',
    '<input id="f" name="cvv" />',
    '<input id="f" id2="x" placeholder="Expiry date" />',
    '<label for="f">Card number</label><input id="f" />',
    '<input id="f" aria-label="Security code" />',
  ];
  for (const html of refused) {
    it(`refuses ${html}`, () => {
      document.body.innerHTML = html;
      const result = typeIntoSelector('#f', 'hello');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/refused/);
      expect(document.querySelector<HTMLInputElement>('#f')?.value).toBe('');
    });
  }

  it('still types into an ordinary field', () => {
    document.body.innerHTML = '<label for="q">Search</label><input id="q" name="q" />';
    expect(typeIntoSelector('#q', 'standup notes')).toEqual({ ok: true });
  });

  it('inline pattern agrees with SENSITIVE_RE on a shared sample', () => {
    const samples = ['cardnumber', 'cvv', 'Expiry date', 'exp-month', 'ccnum', 'iban', 'Security code', 'otp', 'search', 'title', 'email'];
    for (const hint of samples) {
      document.body.innerHTML = `<input id="f" name="${hint}" />`;
      expect(typeIntoSelector('#f', 'x').ok, hint).toBe(!SENSITIVE_RE.test(hint));
    }
  });
});

describe('replay re-checks the current exclusions', () => {
  it('stops the run at a blocked step and says which step and why', async () => {
    const BLOCKED = 'https://bank.example/home';
    const host = createFakeHost();
    host.isUrlBlocked = async (url) => url.includes('bank.example');
    const target = macro({ steps: [openStep(A), openStep(BLOCKED), openStep(B)] });

    const result = await executeMacro(target, host, freshRunState(), { mode: 'guided' });

    const statuses = result.outcomes.map((o) => o.status);
    expect(statuses).toEqual(['ok', 'failed', 'skipped']);
    expect(result.outcomes[1]!.error).toMatch(/step 2/);
    expect(result.outcomes[1]!.error).toMatch(/bank\.example is on your excluded sites/);
    expect(host.trace.some((t) => t.includes('bank.example') && t.startsWith('open:'))).toBe(false);
  });
});

describe('macro parameter values are redacted', () => {
  it('drops emails, uuids, long hex and opaque tokens; keeps short ids and slugs', () => {
    expect(redactParamValue('a.b@c.com')).toBe('');
    expect(redactParamValue('123e4567-e89b-12d3-a456-426614174000')).toBe('');
    expect(redactParamValue('9f86d081884c7d659a2feaa0c55ad015')).toBe('');
    expect(redactParamValue('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms')).toBe('');
    expect(redactParamValue('4242424242424242')).toBe('');
    expect(redactParamValue('1234')).toBe('1234');
    expect(redactParamValue('my-repo')).toBe('my-repo');
    expect(looksLikeOpaqueId('quarterly-planning-doc-final')).toBe(false);
  });

  it('keeps at most the last 3 clean examples and clears a sensitive lastValue', () => {
    const out = sanitizeParam({ name: 'pull', examples: ['1', '2', 'x@y.com', '3', '4', '5'], lastValue: 'x@y.com' });
    expect(out.examples).toEqual(['3', '4', '5']);
    expect(out.lastValue).toBe('');
  });
});

describe('typed-value gate', () => {
  it('refuses secrets, excluded pages and payment/password selectors; allows plain text', () => {
    expect(checkTypedStep({ text: '4242 4242 4242 4242' }, blocklist).ok).toBe(false);
    expect(checkTypedStep({ text: 'hello', url: 'https://bank.example/x' }, blocklist).ok).toBe(false);
    expect(checkTypedStep({ text: 'hello', selector: '#card-number' }, blocklist).ok).toBe(false);
    expect(checkTypedStep({ text: 'hello', url: 'https://a.com', selector: '#q' }, blocklist).ok).toBe(true);
  });
});

describe('standup and coverage input drop excluded domains', () => {
  const range = { from: 0, to: 10 * 86_400_000, label: 'x' };
  const spaces = [{ id: 1, name: 'Proj', status: 'accepted', createdAt: 0, updatedAt: 0 }] as never;
  const spaceUrls = [
    { id: 1, spaceId: 1, url: 'https://bank.example/acct', title: 'My account', source: 'auto' },
    { id: 2, spaceId: 1, url: 'https://docs.example/a', title: 'Doc', source: 'auto' },
  ] as never;
  const rituals = [
    {
      seriesKey: 's',
      title: 'Sync',
      status: 'accepted',
      urls: [
        { url: 'https://bank.example/pay', pageTitle: 'Pay' },
        { url: 'https://docs.example/n', pageTitle: 'Notes' },
      ],
    },
  ] as never;

  it('coverage: no excluded URL anywhere in the serialized input', () => {
    const input = buildCoverageInput({
      events: [],
      calendar: [
        { id: '1', seriesKey: 's', title: 'Sync', start: 1000, end: 2000 },
        { id: '2', seriesKey: 's', title: 'Sync', start: 86_400_000, end: 86_401_000 },
      ] as never,
      rituals,
      spaces,
      spaceUrls,
      blocklist,
      out: { from: 0, to: 5 * 86_400_000 },
      now: 6 * 86_400_000,
    });
    const text = JSON.stringify(input);
    expect(text).not.toContain('bank.example');
    expect(text).toContain('docs.example');
  });

  it('standup: space time is not credited through an excluded URL', () => {
    const input = buildStandupInput({
      events: [],
      spaces,
      spaceUrls,
      calendar: [],
      blocklist,
      range,
      now: 1000,
    });
    expect(JSON.stringify(input)).not.toContain('bank.example');
  });
});

describe('Leader R: last completed segment, else last-run macro', () => {
  const act = (ts: number, target: string): ObservedAction => ({ ts, kind: 'open_url', target, deliberate: true });
  const now = 1_000_000;

  it('builds from a completed recent segment', () => {
    const c = lastCompletedSegment([act(now - 20_000, A), act(now - 15_000, B)], now);
    expect(c).not.toBeNull();
    expect(planRepeat(c, []).via).toBe('segment');
  });

  it('ignores a segment still in progress, or too old', () => {
    expect(lastCompletedSegment([act(now - 2000, A), act(now - 1000, B)], now)).toBeNull();
    expect(lastCompletedSegment([act(now - 3_600_000, A), act(now - 3_599_000, B)], now)).toBeNull();
  });

  it('falls back to the most recently run macro, then to nothing', () => {
    const older = { ...macro({ steps: [openStep(A)] }), id: 1, lastRunAt: 10 };
    const newer = { ...macro({ steps: [openStep(B)] }), id: 2, lastRunAt: 99 };
    const plan = planRepeat(null, [older, newer]);
    expect(plan.via).toBe('last-macro');
    expect(plan.via === 'last-macro' && plan.macro.id).toBe(2);
    expect(planRepeat(null, [{ ...older, lastRunAt: undefined }]).via).toBe('none');
    expect(planRepeat(null, [{ ...newer, status: 'never' }]).via).toBe('none');
  });
});
