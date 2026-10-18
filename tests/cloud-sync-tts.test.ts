import { describe, expect, it } from 'vitest';
import { MAX_TITLE_CHARS, SYNC_BATCH_SIZE, SYNCED_FIELDS, toRow } from '@/lib/cloud-sync';
import { base64ToBlob, ttsCacheKey } from '@/lib/tts';
import type { CadenceEvent } from '@/lib/types';

/** Matches MAX_BODY_BYTES in proxy/src/index.ts. */
const PROXY_BODY_LIMIT = 50 * 1024;

function event(over: Partial<CadenceEvent> = {}): CadenceEvent {
  return {
    id: 7,
    ts: 1_700_000_000_000,
    kind: 'navigated',
    domain: 'example.com',
    title: 'Some page',
    url: 'https://example.com/private/path?token=secret',
    selector: '#login > input.password',
    label: 'Sign in',
    fieldName: 'password',
    tabId: 3,
    keyCount: 42,
    ...over,
  };
}

describe('toRow', () => {
  it('keeps only the four fields the hypertable has columns for', () => {
    const row = toRow(event());
    expect(row).toEqual({
      localId: 7,
      ts: 1_700_000_000_000,
      kind: 'navigated',
      domain: 'example.com',
      title: 'Some page',
    });
  });

  it('never carries a URL, selector, click label or field name off the device', () => {
    const serialized = JSON.stringify(toRow(event()));
    for (const leak of ['example.com/private', 'secret', 'password', 'Sign in', '#login']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('only sends the fields the UI promises', () => {
    const row = toRow(event());
    // localId is bookkeeping for idempotent re-sync, not activity data.
    expect(Object.keys(row!).filter((k) => k !== 'localId').sort()).toEqual([...SYNCED_FIELDS].sort());
  });

  it('drops synthetic events so the debug page cannot pollute the time-series', () => {
    expect(toRow(event({ synthetic: true }))).toBeNull();
  });

  it('drops rows with no id, which could not take part in the high-water mark', () => {
    expect(toRow(event({ id: undefined }))).toBeNull();
  });

  it('substitutes empty strings for a missing domain or title', () => {
    expect(toRow(event({ domain: undefined, title: undefined }))).toMatchObject({ domain: '', title: '' });
  });
});

describe('sync batching', () => {
  it('truncates long titles to the documented cap', () => {
    expect(toRow(event({ title: 'T'.repeat(500) }))!.title).toHaveLength(MAX_TITLE_CHARS);
  });

  it('fits a worst-case batch inside the proxy body limit', () => {
    // Every row at the title cap with a long domain and a large id — the biggest batch possible.
    const rows = Array.from({ length: SYNC_BATCH_SIZE }, (_, i) =>
      toRow(
        event({
          id: 9_000_000 + i,
          title: 'T'.repeat(MAX_TITLE_CHARS * 2),
          domain: 'some-fairly-long-subdomain.example.com',
        }),
      ),
    );
    const body = JSON.stringify({ deviceId: '00000000-0000-4000-8000-000000000000', events: rows });
    expect(new TextEncoder().encode(body).length).toBeLessThan(PROXY_BODY_LIMIT);
  });
});

describe('tts cache key', () => {
  it('is stable for identical text', async () => {
    expect(await ttsCacheKey('Yesterday. Shipped the sync.')).toBe(await ttsCacheKey('Yesterday. Shipped the sync.'));
  });

  it('changes when the draft is edited, so an edit is re-spoken', async () => {
    expect(await ttsCacheKey('Yesterday. Shipped the sync.')).not.toBe(await ttsCacheKey('Yesterday. Shipped the syncs.'));
  });
});

describe('base64ToBlob', () => {
  it('round-trips the bytes the worker encoded', async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x42, 0xfb, 0x90, 0x13]);
    const base64 = Buffer.from(bytes).toString('base64');
    const blob = base64ToBlob(base64, 'audio/mpeg');
    expect(blob.type).toBe('audio/mpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
});
