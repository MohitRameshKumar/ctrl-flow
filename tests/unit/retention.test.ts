import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RETENTION, RETENTION_OPTIONS, isExpired, isRetentionSetting, retentionCutoff, retentionMs } from '../../lib/retention.ts';
import { DEFAULT_BLOCKLIST, isBlocklisted, mergeDefaultDomains, normalizeDomainInput } from '../../lib/privacy.ts';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

test('options: 10 min, 1 h, 24 h (default), 7 days', () => {
  assert.deepEqual(RETENTION_OPTIONS.map((o) => o.value), ['10m', '1h', '24h', '7d']);
  assert.equal(DEFAULT_RETENTION, '24h');
  assert.deepEqual(RETENTION_OPTIONS.map((o) => o.ms), [10 * MIN, 60 * MIN, 24 * 60 * MIN, 7 * 24 * 60 * MIN]);
  assert.equal(isRetentionSetting('1h'), true);
  assert.equal(isRetentionSetting('2h'), false);
});

test('unknown / missing settings fall back to the 24 h default', () => {
  assert.equal(retentionMs(undefined), 24 * 60 * MIN);
  assert.equal(retentionMs('bogus'), 24 * 60 * MIN);
});

test('cutoff deletion: only events strictly older than the setting are expired', () => {
  const events = [
    { id: 'old', ts: NOW - 11 * MIN },
    { id: 'edge', ts: NOW - 10 * MIN },
    { id: 'recent', ts: NOW - 2 * MIN },
  ];
  assert.equal(retentionCutoff('10m', NOW), NOW - 10 * MIN);
  const kept = events.filter((e) => !isExpired(e.ts, '10m', NOW)).map((e) => e.id);
  assert.deepEqual(kept, ['edge', 'recent']);
  // The same events under 1 h: nothing expires.
  assert.equal(events.filter((e) => isExpired(e.ts, '1h', NOW)).length, 0);
  // 7 days keeps a 6-day-old event, drops an 8-day-old one.
  assert.equal(isExpired(NOW - 6 * 24 * 60 * MIN, '7d', NOW), false);
  assert.equal(isExpired(NOW - 8 * 24 * 60 * MIN, '7d', NOW), true);
});

test('exclusions: domain input is normalized, junk rejected', () => {
  assert.equal(normalizeDomainInput('https://www.Chase.com/login?x=1'), 'chase.com');
  assert.equal(normalizeDomainInput('  Example.org  '), 'example.org');
  assert.equal(normalizeDomainInput('app.example.com:8080/path'), 'app.example.com');
  for (const bad of ['', 'localhost', 'not a domain', '..', '-bad.com']) assert.equal(normalizeDomainInput(bad), null, bad);
});

test('exclusions: banking and password managers are on by default, subdomains match', () => {
  for (const d of ['chase.com', 'paypal.com', '1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com']) {
    assert.ok(DEFAULT_BLOCKLIST.domains.includes(d), d);
  }
  assert.equal(isBlocklisted('vault.bitwarden.com', DEFAULT_BLOCKLIST), true);
  assert.equal(isBlocklisted('news.test', DEFAULT_BLOCKLIST), false);
});

test('older saved blocklists gain the new defaults once, keeping the user\'s own entries', () => {
  const stored = { domains: ['chase.com', 'my-private.test'], substrings: ['mychart'] };
  const merged = mergeDefaultDomains(stored);
  assert.ok(merged.domains.includes('my-private.test'));
  assert.ok(merged.domains.includes('1password.com'));
  assert.equal(merged.domains.filter((d) => d === 'chase.com').length, 1);
  assert.deepEqual(merged.substrings, ['mychart']);
});
