/**
 * Tests for expander.ts — port of apiget/expander/expander_test.go +
 * additional cases for the URL-encoding behavior.
 */

import { buildChildrenURL, expandNested } from './expander';
import type { ExpanderConfig, FetchFn, FetchResponse } from './types';

const noopFetch: FetchFn = () => {
  throw new Error('fetch should not be called for this case');
};

describe('buildChildrenURL', () => {
  it('substitutes {fieldName} placeholders from the record', () => {
    expect(buildChildrenURL('https://api.notion.com', '/v1/blocks/{id}/children', { id: 'abc123' })).toBe(
      'https://api.notion.com/v1/blocks/abc123/children',
    );
  });

  it('substitutes multiple placeholders', () => {
    expect(
      buildChildrenURL('https://api.example.com', '/v1/orgs/{org}/repos/{repo}', { org: 'whalesync', repo: 'spinner' }),
    ).toBe('https://api.example.com/v1/orgs/whalesync/repos/spinner');
  });

  it('URL-encodes substituted values', () => {
    expect(buildChildrenURL('https://api.example.com', '/v1/items/{id}', { id: 'a/b c' })).toBe(
      'https://api.example.com/v1/items/a%2Fb%20c',
    );
  });

  it('throws when a placeholder remains unresolved', () => {
    expect(() => buildChildrenURL('https://api.example.com', '/v1/items/{id}/sub/{missing}', { id: 'x' })).toThrow(
      /Unresolved placeholders/,
    );
  });

  it('handles numeric record IDs', () => {
    expect(buildChildrenURL('https://api.example.com', '/v1/items/{id}', { id: 42 })).toBe(
      'https://api.example.com/v1/items/42',
    );
  });

  it('handles boolean record IDs', () => {
    expect(buildChildrenURL('https://api.example.com', '/v1/items/{id}', { id: true })).toBe(
      'https://api.example.com/v1/items/true',
    );
  });
});

describe('expandNested', () => {
  const baseConfig: ExpanderConfig = {
    enabled: true,
    maxDepth: 0, // unlimited
    hasNestedField: 'has_children',
    hasNestedValue: true,
    childrenField: 'children',
    childrenURLPattern: '/v1/blocks/{id}/children',
    baseURL: 'https://api.notion.com',
  };

  it('no-op when disabled', async () => {
    const records: unknown[] = [{ id: 'a', has_children: true }];
    await expandNested(records, { ...baseConfig, enabled: false }, noopFetch);
    expect(records[0]).toEqual({ id: 'a', has_children: true });
  });

  it('no-op when no record has the hasNested field', async () => {
    const records: unknown[] = [{ id: 'a' }, { id: 'b' }];
    await expandNested(records, baseConfig, noopFetch);
    expect(records).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('skips records where hasNested field does not match hasNestedValue', async () => {
    const records: unknown[] = [{ id: 'a', has_children: false }];
    await expandNested(records, baseConfig, noopFetch);
    expect(records[0]).toEqual({ id: 'a', has_children: false });
  });

  it('inlines children under config.childrenField for records that have nested content', async () => {
    const fetch = makeFetchMap({
      'https://api.notion.com/v1/blocks/a/children': {
        results: [
          { id: 'a1', has_children: false },
          { id: 'a2', has_children: false },
        ],
        has_more: false,
      },
    });
    const records: unknown[] = [{ id: 'a', has_children: true }];
    await expandNested(records, baseConfig, fetch);
    expect(records[0]).toMatchObject({
      id: 'a',
      has_children: true,
      children: [
        { id: 'a1', has_children: false },
        { id: 'a2', has_children: false },
      ],
    });
  });

  it('recurses into children when they themselves have nested content', async () => {
    const fetch = makeFetchMap({
      'https://api.notion.com/v1/blocks/a/children': {
        results: [{ id: 'a1', has_children: true }],
        has_more: false,
      },
      'https://api.notion.com/v1/blocks/a1/children': {
        results: [{ id: 'a1a', has_children: false }],
        has_more: false,
      },
    });
    const records: unknown[] = [{ id: 'a', has_children: true }];
    await expandNested(records, baseConfig, fetch);
    // Two levels deep: a → a1 → a1a
    const root = records[0] as Record<string, unknown>;
    expect(root.id).toBe('a');
    const level1 = (root.children as Array<Record<string, unknown>>)[0];
    expect(level1.id).toBe('a1');
    const level2 = (level1.children as Array<Record<string, unknown>>)[0];
    expect(level2.id).toBe('a1a');
  });

  it('respects maxDepth (stops recursing at the limit)', async () => {
    const fetch = makeFetchMap({
      'https://api.notion.com/v1/blocks/a/children': {
        results: [{ id: 'a1', has_children: true }],
        has_more: false,
      },
      // a1's children would be fetched if recursion continued — but maxDepth=1 stops it
    });
    const records: unknown[] = [{ id: 'a', has_children: true }];
    await expandNested(records, { ...baseConfig, maxDepth: 1 }, fetch);
    const root = records[0] as Record<string, unknown>;
    const level1 = (root.children as Array<Record<string, unknown>>)[0];
    expect(level1.id).toBe('a1');
    // Level 2 was never fetched — a1 keeps its original has_children: true with no `children` key
    expect(level1.children).toBeUndefined();
  });

  it('walks the per-children pagination (has_more + next_cursor) within a single parent', async () => {
    const responses = [
      JSON.stringify({
        results: [{ id: 'a1', has_children: false }],
        has_more: true,
        next_cursor: 'cur1',
      }),
      JSON.stringify({
        results: [{ id: 'a2', has_children: false }],
        has_more: false,
      }),
    ];
    let i = 0;
    const fetch: FetchFn = () => Promise.resolve<FetchResponse>({ status: 200, headers: {}, body: responses[i++] });

    const records: unknown[] = [{ id: 'a', has_children: true }];
    await expandNested(records, baseConfig, fetch);
    const root = records[0] as Record<string, unknown>;
    expect(root.children).toHaveLength(2);
    expect(i).toBe(2);
  });

  it('treats hasNestedValue = undefined as "field exists is enough"', async () => {
    const fetch = makeFetchMap({
      'https://api.notion.com/v1/blocks/a/children': {
        results: [{ id: 'a1' }],
        has_more: false,
      },
    });
    const records: unknown[] = [{ id: 'a', has_children: 'literally anything' }];
    await expandNested(records, { ...baseConfig, hasNestedValue: undefined }, fetch);
    expect((records[0] as Record<string, unknown>).children).toEqual([{ id: 'a1' }]);
  });
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeFetchMap(map: Record<string, unknown>): FetchFn {
  return (req) => {
    if (!(req.url in map)) {
      return Promise.resolve<FetchResponse>({ status: 404, headers: {}, body: '' });
    }
    return Promise.resolve<FetchResponse>({ status: 200, headers: {}, body: JSON.stringify(map[req.url]) });
  };
}
