/**
 * Tests for pagination.ts — pure functions only (no HTTP).
 *
 * Covers:
 *   - detectStrategy / detectStrategyFromResponse for each pagination shape
 *   - parseNextLink (RFC 5988)
 *   - extractData, extractNextCursor, hasMorePages, buildNextURL
 *   - Audit-driven failure-mode fixtures (Klaviyo, Pipedrive, Trello, Hostex)
 *     where detection must either succeed correctly OR return null (NOT a
 *     false positive)
 *
 * Runner-level safety tests (cycle detection, maxPages backstop, resume
 * protocol per pagination type) live in fetch.spec.ts because they exercise
 * the apigetStream loop with mocked HTTP.
 */

import {
  buildNextURL,
  detectStrategy,
  detectStrategyFromResponse,
  extractData,
  extractNextCursor,
  hasMorePages,
  parseNextLink,
} from './pagination';

describe('detectStrategy — cursor shapes', () => {
  it('detects top-level next_cursor (Notion-style)', () => {
    const body = JSON.stringify({
      results: [{ id: 1 }, { id: 2 }],
      next_cursor: 'abc123',
      has_more: true,
    });
    const s = detectStrategy(body, 'https://api.example.com/v1/items');
    expect(s).not.toBeNull();
    expect(s?.type).toBe('cursor');
    expect(s?.cursorPath).toBe('next_cursor');
    expect(s?.dataPath).toBe('results');
  });

  it('detects nested HubSpot-style cursor (paging.next.after)', () => {
    const body = JSON.stringify({
      results: [{ id: 'c1' }],
      paging: { next: { after: 'token_xyz', link: 'https://api.hubspot.com/x?after=token_xyz' } },
    });
    const s = detectStrategy(body, 'https://api.hubapi.com/crm/v3/objects/contacts');
    expect(s?.type).toBe('cursor');
    // Should find the cursor under paging.next.after
    expect(s?.cursorPath).toBe('paging.next.after');
    expect(s?.dataPath).toBe('results');
  });

  it('detects cursor under pagination wrapper', () => {
    const body = JSON.stringify({
      data: [{ id: 1 }],
      pagination: { next_cursor: 'xyz' },
    });
    const s = detectStrategy(body, 'https://api.example.com/x');
    expect(s?.type).toBe('cursor');
    expect(s?.cursorPath).toBe('pagination.next_cursor');
    expect(s?.dataPath).toBe('data');
  });
});

describe('detectStrategy — offset shape (Webflow-style)', () => {
  it('detects offset/limit with total in metadata', () => {
    const body = JSON.stringify({
      items: [{ id: 1 }, { id: 2 }],
      pagination: { total: 50, offset: 0, limit: 2 },
    });
    const s = detectStrategy(body, 'https://api.webflow.com/v2/collections/x/items');
    expect(s?.type).toBe('offset');
    expect(s?.dataPath).toBe('items');
    expect(s?.limit).toBe(2);
    expect(s?.offsetParam).toBe('offset');
    expect(s?.limitParam).toBe('limit');
  });

  it('defaults limit to 100 when metadata has no explicit limit', () => {
    const body = JSON.stringify({
      items: [{ id: 1 }],
      pagination: { total: 500, offset: 0 },
    });
    const s = detectStrategy(body, 'https://api.example.com/x');
    expect(s?.type).toBe('offset');
    expect(s?.limit).toBe(100);
  });

  it('honors explicit query params (skip / take) over defaults', () => {
    // Body uses limit/offset (the keys our detector recognizes) so detection
    // fires; URL uses skip/take so guessOffsetLimitParams picks those names.
    const body = JSON.stringify({
      records: [{ id: 1 }],
      pagination: { total: 200, limit: 50, offset: 0 },
    });
    const s = detectStrategy(body, 'https://api.example.com/x?skip=0&take=50');
    expect(s?.type).toBe('offset');
    expect(s?.offsetParam).toBe('skip');
    expect(s?.limitParam).toBe('take');
  });
});

describe('detectStrategy — GraphQL Relay shape (Linear-style)', () => {
  it('detects nodes + pageInfo.hasNextPage + pageInfo.endCursor', () => {
    const body = JSON.stringify({
      data: {
        issues: {
          pageInfo: { hasNextPage: true, endCursor: 'cur1' },
          nodes: [{ id: 'i1' }, { id: 'i2' }],
        },
      },
    });
    const s = detectStrategy(body, 'https://api.linear.app/graphql');
    expect(s?.type).toBe('graphql');
    expect(s?.cursorPath).toBe('data.issues.pageInfo.endCursor');
    expect(s?.dataPath).toBe('data.issues.nodes');
    expect(s?.cursorParam).toBe('after');
  });

  it('detects edges variant when nodes is absent', () => {
    const body = JSON.stringify({
      data: {
        repos: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [{ node: { id: 'r1' } }],
        },
      },
    });
    const s = detectStrategy(body, 'https://api.github.com/graphql');
    expect(s?.type).toBe('graphql');
    expect(s?.dataPath).toBe('data.repos.edges');
  });

  it('skips queries without endCursor + hasNextPage (not Relay)', () => {
    const body = JSON.stringify({
      data: {
        notRelay: {
          nodes: [{ id: 1 }],
          // no pageInfo
        },
      },
    });
    const s = detectStrategy(body, 'https://api.example.com/graphql');
    expect(s).toBeNull();
  });
});

describe('detectStrategy — no-pagination responses', () => {
  it('returns null for a plain object with no pagination shape', () => {
    const body = JSON.stringify({ data: { name: 'x' } });
    expect(detectStrategy(body, 'https://api.example.com/x')).toBeNull();
  });

  it('returns null for non-JSON body (matches Go: nil, nil)', () => {
    expect(detectStrategy('not json at all', 'https://api.example.com/x')).toBeNull();
  });

  it('returns null for JSON array response (no envelope to inspect)', () => {
    expect(detectStrategy('[{"id":1}]', 'https://api.example.com/x')).toBeNull();
  });
});

describe('detectStrategyFromResponse — RFC 5988 Link header (NEW in TS port)', () => {
  it('detects link-header strategy when Link: ...; rel="next" is present', () => {
    const s = detectStrategyFromResponse({
      body: '[{"id":1}]',
      headers: {
        link: '<https://api.github.com/repos?page=2>; rel="next", <https://api.github.com/repos?page=10>; rel="last"',
      },
      url: 'https://api.github.com/users/foo/repos',
    });
    expect(s).toEqual({ type: 'link-header' });
  });

  it('falls back to body-only detection when Link header is absent', () => {
    const s = detectStrategyFromResponse({
      body: JSON.stringify({ results: [], next_cursor: 'x' }),
      headers: {},
      url: 'https://api.example.com/x',
    });
    expect(s?.type).toBe('cursor');
  });

  it('falls back to body-only detection when Link has no rel="next"', () => {
    const s = detectStrategyFromResponse({
      body: JSON.stringify({ items: [] }),
      headers: { link: '<https://api.example.com/x?page=1>; rel="prev"' },
      url: 'https://api.example.com/x?page=2',
    });
    expect(s).toBeNull();
  });
});

describe('parseNextLink', () => {
  it('extracts the rel="next" URL', () => {
    const link =
      '<https://api.github.com/users/foo/repos?page=2>; rel="next", <https://api.github.com/users/foo/repos?page=5>; rel="last"';
    expect(parseNextLink(link)).toBe('https://api.github.com/users/foo/repos?page=2');
  });

  it('returns null when only rel="prev" / rel="first" are present', () => {
    const link =
      '<https://api.github.com/users/foo/repos?page=1>; rel="prev", <https://api.github.com/users/foo/repos?page=1>; rel="first"';
    expect(parseNextLink(link)).toBeNull();
  });

  it('handles rel without quotes (rel=next)', () => {
    expect(parseNextLink('<https://api.example.com/x?p=2>; rel=next')).toBe('https://api.example.com/x?p=2');
  });

  it('handles space-separated rel tokens (rel="prev next")', () => {
    expect(parseNextLink('<https://api.example.com/x?p=2>; rel="prev next"')).toBe('https://api.example.com/x?p=2');
  });

  it('returns null on empty Link header', () => {
    expect(parseNextLink('')).toBeNull();
  });

  it('returns null when Link header is malformed', () => {
    expect(parseNextLink('not a link header at all')).toBeNull();
  });
});

describe('extractNextCursor', () => {
  it('extracts top-level cursor', () => {
    const body = JSON.stringify({ next_cursor: 'abc' });
    const cursor = extractNextCursor(body, {
      type: 'cursor',
      cursorPath: 'next_cursor',
      dataPath: 'results',
      cursorParam: 'cursor',
    });
    expect(cursor).toBe('abc');
  });

  it('walks nested cursor path (HubSpot paging.next.after)', () => {
    const body = JSON.stringify({ paging: { next: { after: 'xyz' } } });
    const cursor = extractNextCursor(body, {
      type: 'cursor',
      cursorPath: 'paging.next.after',
      dataPath: 'results',
      cursorParam: 'after',
    });
    expect(cursor).toBe('xyz');
  });

  it('GraphQL: returns endCursor when hasNextPage=true', () => {
    const body = JSON.stringify({
      data: { issues: { pageInfo: { hasNextPage: true, endCursor: 'gc1' } } },
    });
    const cursor = extractNextCursor(body, {
      type: 'graphql',
      cursorPath: 'data.issues.pageInfo.endCursor',
      dataPath: 'data.issues.nodes',
      cursorParam: 'after',
    });
    expect(cursor).toBe('gc1');
  });

  it('GraphQL: returns "" when hasNextPage=false (even if endCursor present)', () => {
    const body = JSON.stringify({
      data: { issues: { pageInfo: { hasNextPage: false, endCursor: 'ignored' } } },
    });
    const cursor = extractNextCursor(body, {
      type: 'graphql',
      cursorPath: 'data.issues.pageInfo.endCursor',
      dataPath: 'data.issues.nodes',
      cursorParam: 'after',
    });
    expect(cursor).toBe('');
  });

  it('returns "" when strategy is offset (cursor only applies to cursor/graphql)', () => {
    const body = JSON.stringify({ next_cursor: 'x' });
    expect(extractNextCursor(body, { type: 'offset' })).toBe('');
  });

  it('returns "" when path is not present in the response', () => {
    const body = JSON.stringify({ results: [] });
    expect(extractNextCursor(body, { type: 'cursor', cursorPath: 'next_cursor', cursorParam: 'cursor' })).toBe('');
  });
});

describe('extractData', () => {
  it('returns records from the configured dataPath', () => {
    const body = JSON.stringify({ items: [{ id: 1 }, { id: 2 }] });
    const records = extractData(body, { type: 'cursor', dataPath: 'items', cursorPath: 'x', cursorParam: 'c' });
    expect(records).toHaveLength(2);
  });

  it('walks nested dataPath (GraphQL data.issues.nodes)', () => {
    const body = JSON.stringify({ data: { issues: { nodes: [{ id: 1 }] } } });
    const records = extractData(body, {
      type: 'graphql',
      dataPath: 'data.issues.nodes',
      cursorPath: 'data.issues.pageInfo.endCursor',
      cursorParam: 'after',
    });
    expect(records).toHaveLength(1);
  });

  it('falls back to common field scan when strategy.dataPath is empty', () => {
    const body = JSON.stringify({ results: [{ id: 'a' }] });
    const records = extractData(body, null);
    expect(records).toEqual([{ id: 'a' }]);
  });

  it('returns the whole object as a single record when nothing matches', () => {
    const body = JSON.stringify({ name: 'standalone' });
    const records = extractData(body, null);
    expect(records).toEqual([{ name: 'standalone' }]);
  });

  it('returns a raw JSON array body as-is', () => {
    const records = extractData('[{"id":1},{"id":2}]', null);
    expect(records).toHaveLength(2);
  });

  it('throws when dataPath is set but the path leads nowhere', () => {
    const body = JSON.stringify({ items: 'not an array' });
    expect(() => extractData(body, { type: 'cursor', dataPath: 'items', cursorPath: 'c', cursorParam: 'c' })).toThrow(
      /items/,
    );
  });
});

describe('hasMorePages (offset only)', () => {
  it('honors explicit hasNext boolean', () => {
    const body = JSON.stringify({ pagination: { hasNext: false, total: 100, limit: 10 } });
    expect(
      hasMorePages(
        body,
        { type: 'offset', limit: 10, dataPath: 'items', offsetParam: 'offset', limitParam: 'limit' },
        0,
      ),
    ).toBe(false);
  });

  it('returns true when offset + limit < total', () => {
    const body = JSON.stringify({ pagination: { total: 100, limit: 10 }, items: [] });
    expect(
      hasMorePages(
        body,
        { type: 'offset', limit: 10, dataPath: 'items', offsetParam: 'offset', limitParam: 'limit' },
        0,
      ),
    ).toBe(true);
  });

  it('returns false when offset + limit >= total', () => {
    const body = JSON.stringify({ pagination: { total: 20, limit: 10 }, items: [] });
    expect(
      hasMorePages(
        body,
        { type: 'offset', limit: 10, dataPath: 'items', offsetParam: 'offset', limitParam: 'limit' },
        10,
      ),
    ).toBe(false);
  });

  it('falls back to full-page heuristic when no metadata', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const body = JSON.stringify({ items: records });
    expect(
      hasMorePages(
        body,
        { type: 'offset', limit: 10, dataPath: 'items', offsetParam: 'offset', limitParam: 'limit' },
        0,
      ),
    ).toBe(true);

    const partialBody = JSON.stringify({ items: records.slice(0, 7) });
    expect(
      hasMorePages(
        partialBody,
        { type: 'offset', limit: 10, dataPath: 'items', offsetParam: 'offset', limitParam: 'limit' },
        0,
      ),
    ).toBe(false);
  });

  it('returns false for non-offset strategies', () => {
    expect(hasMorePages('{}', { type: 'cursor' }, 0)).toBe(false);
  });
});

describe('buildNextURL', () => {
  it('appends cursor as query param', () => {
    const url = buildNextURL('https://api.example.com/x', 'abc', {
      type: 'cursor',
      cursorPath: 'next_cursor',
      cursorParam: 'cursor',
    });
    expect(url).toBe('https://api.example.com/x?cursor=abc');
  });

  it('passes through cursor that is already a full URL (Twilio/Asana pattern)', () => {
    const url = buildNextURL('https://api.example.com/x', 'https://api.twilio.com/x?next=abc', {
      type: 'cursor',
      cursorParam: 'cursor',
    });
    expect(url).toBe('https://api.twilio.com/x?next=abc');
  });

  it('updates offset + limit for offset pagination', () => {
    const url = buildNextURL('https://api.example.com/x', '50', {
      type: 'offset',
      offsetParam: 'offset',
      limitParam: 'limit',
      limit: 50,
    });
    expect(url).toContain('offset=50');
    expect(url).toContain('limit=50');
  });

  it('returns "" for type=link-header (caller must use parseNextLink instead)', () => {
    expect(buildNextURL('https://api.example.com/x', '', { type: 'link-header' })).toBe('');
  });

  it('returns "" for type=graphql (cursor injection is body-level, not URL)', () => {
    expect(buildNextURL('https://api.example.com/x', 'after_x', { type: 'graphql' })).toBe('');
  });

  it('returns "" for empty cursor', () => {
    expect(buildNextURL('https://api.example.com/x', '', { type: 'cursor', cursorParam: 'c' })).toBe('');
  });
});

// ============================================================================
// All 15 common cursor field names — ported from Go's
// TestDetectStrategy_AllCursorFields. Each fixture exercises one field name
// from COMMON_CURSOR_FIELDS and asserts the resulting Strategy.cursorPath +
// cursorParam (the latter exercises guessCursorParam's field-name heuristic).
// ============================================================================

describe('detectStrategy — all common cursor field names (Go parity)', () => {
  const cases: Array<{ name: string; body: Record<string, unknown>; cursor: string; param: string }> = [
    { name: 'next_cursor', body: { next_cursor: 'abc123', data: [{ id: 1 }] }, cursor: 'next_cursor', param: 'cursor' },
    {
      name: 'nextCursor (camelCase)',
      body: { nextCursor: 'abc123', data: [{ id: 1 }] },
      cursor: 'nextCursor',
      param: 'cursor',
    },
    { name: 'cursor', body: { cursor: 'abc123', data: [{ id: 1 }] }, cursor: 'cursor', param: 'cursor' },
    { name: 'after', body: { after: 'abc123', data: [{ id: 1 }] }, cursor: 'after', param: 'after' },
    {
      name: 'next (URL)',
      body: { next: 'https://api.example.com/page2', results: [{ id: 1 }] },
      cursor: 'next',
      param: 'cursor',
    },
    {
      name: 'link',
      body: { link: 'https://api.example.com/page2', data: [{ id: 1 }] },
      cursor: 'link',
      param: 'cursor',
    },
    {
      name: 'next_link',
      body: { next_link: 'https://api.example.com/page2', data: [{ id: 1 }] },
      cursor: 'next_link',
      param: 'cursor',
    },
    {
      name: 'nextLink (camelCase)',
      body: { nextLink: 'https://api.example.com/page2', data: [{ id: 1 }] },
      cursor: 'nextLink',
      param: 'cursor',
    },
    {
      name: 'continuation_token',
      body: { continuation_token: 'abc123', data: [{ id: 1 }] },
      cursor: 'continuation_token',
      param: 'cursor',
    },
    {
      name: 'continuationToken (camelCase)',
      body: { continuationToken: 'abc123', data: [{ id: 1 }] },
      cursor: 'continuationToken',
      param: 'continuation_token',
    },
    { name: 'page_token', body: { page_token: 'abc123', data: [{ id: 1 }] }, cursor: 'page_token', param: 'cursor' },
    {
      name: 'pageToken (camelCase)',
      body: { pageToken: 'abc123', data: [{ id: 1 }] },
      cursor: 'pageToken',
      param: 'page_token',
    },
    { name: 'next_page', body: { next_page: 'abc123', data: [{ id: 1 }] }, cursor: 'next_page', param: 'cursor' },
    {
      name: 'nextPage (camelCase)',
      body: { nextPage: 'abc123', data: [{ id: 1 }] },
      cursor: 'nextPage',
      param: 'cursor',
    },
    {
      name: 'offset (Airtable opaque cursor)',
      body: { offset: 'itrABC123', records: [{ id: 1 }] },
      cursor: 'offset',
      param: 'offset',
    },
  ];

  for (const c of cases) {
    it(`detects ${c.name} → cursorPath=${c.cursor}, cursorParam=${c.param}`, () => {
      const s = detectStrategy(JSON.stringify(c.body), 'https://api.example.com/items');
      expect(s).not.toBeNull();
      expect(s?.type).toBe('cursor');
      expect(s?.cursorPath).toBe(c.cursor);
      expect(s?.cursorParam).toBe(c.param);
    });
  }
});

// ============================================================================
// Real-world API fixtures — ported from Go's TestDetectStrategy_RealWorldAPIs.
// Confirms detection against actual response shapes from PokeAPI / Webflow /
// HubSpot / Airtable. GitHub-no-pagination edge case included (its REST
// pagination is via Link header, which our body-only detector doesn't see —
// covered separately by the detectStrategyFromResponse tests above).
// ============================================================================

describe('detectStrategy — real-world API fixtures (Go parity)', () => {
  it('PokeAPI: count + next URL + results → cursor', () => {
    const body = JSON.stringify({
      count: 1154,
      next: 'https://pokeapi.co/api/v2/pokemon?offset=20&limit=20',
      previous: null,
      results: [{ name: 'bulbasaur' }],
    });
    const s = detectStrategy(body, 'https://pokeapi.co/api/v2/pokemon');
    expect(s?.type).toBe('cursor');
    expect(s?.cursorPath).toBe('next');
  });

  it('Webflow: pagination wrapper with total/offset/limit → offset', () => {
    const body = JSON.stringify({
      pagination: { limit: 100, offset: 0, total: 651 },
      items: [{ id: '123' }],
    });
    const s = detectStrategy(body, 'https://api.webflow.com/v2/collections/x/items');
    expect(s?.type).toBe('offset');
    expect(s?.limit).toBe(100);
  });

  it('HubSpot: paging.next.after → cursor (nested two levels)', () => {
    const body = JSON.stringify({
      paging: { next: { after: '1343', link: 'https://api.hubapi.com/crm/v3/contacts?after=1343' } },
      results: [{ id: 1 }],
    });
    const s = detectStrategy(body, 'https://api.hubapi.com/crm/v3/objects/contacts');
    expect(s?.type).toBe('cursor');
    expect(s?.cursorPath).toBe('paging.next.after');
    expect(s?.dataPath).toBe('results');
  });

  it('Airtable: top-level `offset` as opaque cursor token → cursor (not offset)', () => {
    // Airtable's `offset` is an opaque cursor string, not a numeric offset.
    // Detection should pick it up via the cursor-field scan and use offsetParam='offset'.
    const body = JSON.stringify({
      offset: 'itrABC123/recDEF456',
      records: [{ id: 'rec1', fields: { Name: 'A' } }],
    });
    const s = detectStrategy(body, 'https://api.airtable.com/v0/appXXX/Table1');
    expect(s?.type).toBe('cursor');
    expect(s?.cursorPath).toBe('offset');
    expect(s?.cursorParam).toBe('offset');
  });

  it('GitHub body alone (no Link header) → null; pagination only visible via Link header', () => {
    // GitHub returns the records as a raw JSON array with NO body-level
    // pagination signal. Body-only detectStrategy returns null (correct).
    // detectStrategyFromResponse picks up the Link header — covered above.
    const body = JSON.stringify([{ id: 1, name: 'repo1' }]);
    expect(detectStrategy(body, 'https://api.github.com/users/foo/repos')).toBeNull();
  });
});

// ============================================================================
// Audit-driven failure-mode fixtures
//
// These confirm that detection produces a clear "needs override" signal for
// APIs the audit flagged as ⚠️ — detection should EITHER auto-detect
// correctly OR return null (which the connector surfaces to the user). The
// silent-failure mode (false positive) is what we're guarding against.
// ============================================================================

describe('audit failure-mode fixtures', () => {
  it('Klaviyo: JSON:API page[cursor] — detection produces a cursor strategy, user must override cursorParam', () => {
    // Klaviyo returns: { data: [...], links: { next: "https://...?page[cursor]=abc" } }
    // Our default cursor field detection doesn't pick this up (`links` isn't in
    // the cursor field list) — should return null so the user knows to override.
    const body = JSON.stringify({
      data: [{ id: 'p_1', type: 'profile' }],
      links: {
        next: 'https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=abc',
      },
    });
    const s = detectStrategy(body, 'https://a.klaviyo.com/api/profiles/');
    // We accept either: null (best — user must override) OR a strategy without
    // the right cursorPath (which would silently break — we DON'T want this).
    // Today's heuristic returns null because `links` isn't a known cursor wrapper.
    expect(s).toBeNull();
  });

  it('Pipedrive: more_items_in_collection nested under additional_data — not auto-detected by heuristic', () => {
    // Pipedrive's hasMore flag is at additional_data.pagination.more_items_in_collection.
    // That's a non-standard wrapper key ('additional_data'), so detection returns null.
    // User must supply a manual offset strategy.
    const body = JSON.stringify({
      data: [{ id: 1 }],
      additional_data: {
        pagination: { start: 0, limit: 100, more_items_in_collection: true },
      },
    });
    const s = detectStrategy(body, 'https://api.pipedrive.com/v1/deals?api_token=X');
    expect(s).toBeNull();
  });

  it('Trello: no pagination metadata at all — must return null (NOT a false positive)', () => {
    // Trello caps at 1000 and gives you no signal. We MUST NOT pretend pagination
    // exists.
    const body = JSON.stringify([
      { id: 'card1', name: 'A' },
      { id: 'card2', name: 'B' },
    ]);
    expect(detectStrategy(body, 'https://api.trello.com/1/boards/x/cards')).toBeNull();
  });

  it('Hostex: nonstandard wrapper key + off-by-one — must return null', () => {
    // Hostex returns data under a non-standard wrapper. detectStrategy should
    // not pretend it found pagination here.
    const body = JSON.stringify({
      result: {
        total_count: 47,
        data: [{ id: 'r1' }, { id: 'r2' }],
      },
    });
    const s = detectStrategy(body, 'https://api.hostex.io/v3/reservations');
    expect(s).toBeNull();
  });
});
