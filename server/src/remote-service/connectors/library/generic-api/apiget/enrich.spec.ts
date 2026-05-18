/**
 * Tests for enrich.ts.
 */

import { COMMON_ID_FIELDS, enrichRecords, findIdField, inferDetailURL } from './enrich';
import type { FetchFn, FetchResponse } from './types';

describe('findIdField', () => {
  it('finds id field with each of the common names in order', () => {
    for (const field of COMMON_ID_FIELDS) {
      const record = { [field]: 'value-' + field };
      const [foundField, foundValue] = findIdField(record);
      expect(foundField).toBe(field);
      expect(foundValue).toBe('value-' + field);
    }
  });

  it('prefers `id` when multiple ID-like fields are present', () => {
    const record = { uid: 'u1', _id: 'i1', id: 'I_WIN' };
    const [field, value] = findIdField(record);
    expect(field).toBe('id');
    expect(value).toBe('I_WIN');
  });

  it('returns [null, null] when no ID field exists', () => {
    const [field, value] = findIdField({ name: 'no id here' });
    expect(field).toBeNull();
    expect(value).toBeNull();
  });
});

describe('inferDetailURL', () => {
  it('strips query params and appends the ID', () => {
    expect(inferDetailURL('https://api.example.com/items?status=active', 12345)).toBe(
      'https://api.example.com/items/12345',
    );
  });

  it('handles trailing slash in path', () => {
    expect(inferDetailURL('https://api.example.com/items/', 'abc')).toBe('https://api.example.com/items/abc');
  });

  it('URL-encodes IDs with reserved characters', () => {
    expect(inferDetailURL('https://api.example.com/items', 'a/b c?d')).toBe(
      'https://api.example.com/items/a%2Fb%20c%3Fd',
    );
  });

  it('SAFETY: throws on null / undefined record ID', () => {
    expect(() => inferDetailURL('https://api.example.com/x', null)).toThrow(/null or undefined/);
    expect(() => inferDetailURL('https://api.example.com/x', undefined)).toThrow(/null or undefined/);
  });

  it('SAFETY: throws on object record ID (composite-ID guard for Attio-style APIs)', () => {
    // Per eng review: composite IDs like { record_id, workspace_id } would
    // produce "[object Object]" in the URL without this guard.
    expect(() => inferDetailURL('https://api.example.com/x', { record_id: 'a', workspace_id: 'b' })).toThrow(
      /composite-ID|not supported/i,
    );
  });

  it('accepts number IDs', () => {
    expect(inferDetailURL('https://api.example.com/x', 42)).toBe('https://api.example.com/x/42');
  });

  it('accepts boolean IDs (edge case but should not crash)', () => {
    expect(inferDetailURL('https://api.example.com/x', true)).toBe('https://api.example.com/x/true');
  });
});

describe('enrichRecords', () => {
  it('replaces each record in place with the full detail-endpoint version', async () => {
    const calls: string[] = [];
    const fetch: FetchFn = (req) => {
      calls.push(req.url);
      const id = req.url.split('/').pop();
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ id, name: `Full record ${id}`, extra: 'detail-only-field' }),
      });
    };

    const records: unknown[] = [
      { id: 'a', name: 'shallow A' },
      { id: 'b', name: 'shallow B' },
    ];
    await enrichRecords(records, 'https://api.example.com/items', fetch);

    expect(records[0]).toEqual({ id: 'a', name: 'Full record a', extra: 'detail-only-field' });
    expect(records[1]).toEqual({ id: 'b', name: 'Full record b', extra: 'detail-only-field' });
    expect(calls).toEqual(['https://api.example.com/items/a', 'https://api.example.com/items/b']);
  });

  it('unwraps `data` wrapper if the detail response has one', async () => {
    const fetch: FetchFn = (req) => {
      const id = req.url.split('/').pop();
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ data: { id, name: `Wrapped ${id}` } }),
      });
    };
    const records: unknown[] = [{ id: 'a' }];
    await enrichRecords(records, 'https://api.example.com/items', fetch);
    expect(records[0]).toEqual({ id: 'a', name: 'Wrapped a' });
  });

  it('throws when a record has no detectable ID field', async () => {
    const fetch: FetchFn = () => Promise.resolve<FetchResponse>({ status: 200, headers: {}, body: '{}' });
    const records: unknown[] = [{ name: 'no id here' }];
    await expect(enrichRecords(records, 'https://api.example.com/x', fetch)).rejects.toThrow(/ID field/);
  });

  it('throws when the detail endpoint returns a non-2xx', async () => {
    const fetch: FetchFn = () => Promise.resolve<FetchResponse>({ status: 404, headers: {}, body: 'not found' });
    const records: unknown[] = [{ id: 'a' }];
    await expect(enrichRecords(records, 'https://api.example.com/x', fetch)).rejects.toThrow(/HTTP 404/);
  });

  it('calls progressFn after each successful enrichment', async () => {
    const fetch: FetchFn = (req) =>
      Promise.resolve<FetchResponse>({
        status: 200,
        headers: {},
        body: JSON.stringify({ id: req.url.split('/').pop() }),
      });
    const progress: Array<[number, number]> = [];
    const records: unknown[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    await enrichRecords(records, 'https://api.example.com/x', fetch, (current, total) => {
      progress.push([current, total]);
    });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('returns silently on empty records array', async () => {
    const fetch: FetchFn = () => {
      throw new Error('should not be called');
    };
    await expect(enrichRecords([], 'https://api.example.com/x', fetch)).resolves.toBeUndefined();
  });

  it('skips non-record entries (e.g. raw strings) without throwing', async () => {
    const fetch: FetchFn = (req) =>
      Promise.resolve<FetchResponse>({
        status: 200,
        headers: {},
        body: JSON.stringify({ id: req.url.split('/').pop(), enriched: true }),
      });
    const records: unknown[] = ['not a record', { id: 'a' }];
    await enrichRecords(records, 'https://api.example.com/x', fetch);
    expect(records[0]).toBe('not a record');
    expect(records[1]).toEqual({ id: 'a', enriched: true });
  });
});
