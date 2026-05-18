/**
 * Port of apiget/pagination/pagination.go.
 *
 * Five exported functions, mirroring the Go API 1:1 so the persisted
 * Strategy JSON is portable between this TS port and the original Go CLI:
 *   - detectStrategy(body, url)        — analyze first response, return Strategy or null
 *   - extractData(body, strategy?)     — pull the records array out of a response
 *   - extractNextCursor(body, strategy?) — get the next page cursor (cursor / graphql)
 *   - hasMorePages(body, strategy, currentOffset) — for offset pagination
 *   - buildNextURL(baseURL, cursor, strategy) — construct the next request URL
 *
 * NEW in the TS port (not in Go yet):
 *   - link-header detection in detectStrategyFromResponse (response wrapper)
 *
 * The Go code passes only the response body + request URL to detection. To
 * support RFC 5988 Link-header pagination we also need access to response
 * headers, so we add a thin wrapper `detectStrategyFromResponse` that takes
 * `{ body, headers, url }`. The legacy body-only `detectStrategy` is kept for
 * compatibility with the body-only Go shape and for tests.
 */

import { extractIntValue, hasAnyKey, isArray, isRecord } from './internal-helpers';
import type { Strategy } from './types';

// =============================================================================
// Common field name lists — mirror the Go const blocks exactly.
// =============================================================================

/** Cursor field names checked in order. Mirrors `commonCursorFields`. */
export const COMMON_CURSOR_FIELDS = [
  'next_cursor',
  'nextCursor',
  'cursor',
  'after',
  'next', // Can be a cursor string or full URL
  'link', // HubSpot and others use "link" for next page URL
  'next_link',
  'nextLink',
  'continuation_token',
  'continuationToken',
  'page_token',
  'pageToken',
  'next_page',
  'nextPage',
  'offset', // Airtable uses "offset" for cursor-based pagination (opaque token)
];

/** Common data field names. Mirrors `commonDataFields`. */
export const COMMON_DATA_FIELDS = ['data', 'results', 'items', 'records', 'entries', 'list', 'posts'];

/** Common cursor query-parameter names. Mirrors `commonCursorParams`. */
export const COMMON_CURSOR_PARAMS = ['cursor', 'after', 'next_cursor', 'page_token', 'continuation_token', 'offset'];

/** Pagination metadata wrapper keys. */
const PAGINATION_KEYS = ['pagination', 'paging', 'page_info', 'pageInfo', 'meta', 'metaData', 'pagingMetadata'];

// =============================================================================
// Detection: pick a Strategy from a first-response body (+ optional headers)
// =============================================================================

/**
 * Body-only detection — mirrors Go's `DetectStrategy(responseBody, requestURL)`.
 * Returns null on non-JSON bodies (Go: also returns nil, nil) and on
 * unrecognized shapes. For Link-header detection use `detectStrategyFromResponse`.
 */
export function detectStrategy(responseBody: string, requestURL: string): Strategy | null {
  let data: unknown;
  try {
    data = JSON.parse(responseBody);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  // GraphQL first (most specific shape)
  const graphqlStrategy = detectGraphQLPagination(data);
  if (graphqlStrategy) return graphqlStrategy;

  // Then cursor-based
  const [cursorField, cursorPath] = findCursorField(data);
  if (cursorField) {
    const dataField = findDataField(data);
    const cursorParam = guessCursorParam(requestURL, cursorField);
    return {
      type: 'cursor',
      cursorPath,
      dataPath: dataField,
      cursorParam,
    };
  }

  // Then offset/limit
  const offsetStrategy = detectOffsetPagination(data, requestURL);
  if (offsetStrategy) return offsetStrategy;

  return null;
}

/**
 * NEW in TS port: detection that also considers RFC 5988 `Link: <url>; rel="next"`
 * response headers. Call this with the full response. Falls back to body-only
 * detection when no Link header is present.
 *
 * Header names should be lowercased (matches `FetchResponse.headers`).
 */
export function detectStrategyFromResponse(response: {
  body: string;
  headers: Record<string, string>;
  url: string;
}): Strategy | null {
  // RFC 5988 Link-header check first — highest specificity.
  const linkHeader = response.headers['link'];
  if (linkHeader && parseNextLink(linkHeader) !== null) {
    return { type: 'link-header' };
  }
  return detectStrategy(response.body, response.url);
}

/**
 * Parse an RFC 5988 `Link` header and return the value of the `rel="next"`
 * URI, or null if no `rel="next"` link is present.
 *
 * Example input:
 *   <https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=10>; rel="last"
 * Returns:
 *   "https://api.github.com/x?page=2"
 *
 * Exported for use by fetch.ts when iterating link-header pagination.
 */
export function parseNextLink(linkHeader: string): string | null {
  // Split on commas at the top level (not inside <>) and look for rel="next".
  // RFC 5988 grammar is more elaborate; this covers GitHub / GitLab / SendGrid /
  // most servers in the wild.
  const parts = linkHeader.split(',');
  for (const rawPart of parts) {
    const part = rawPart.trim();
    // Pattern: <url>; rel="next"  (or rel=next without quotes)
    const match = part.match(/^<([^>]+)>\s*;\s*(.*)$/);
    if (!match) continue;
    const [, url, params] = match;
    // The rel param can be: rel="next" | rel='next' | rel=next | rel="prev next"
    const relMatch = params.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/);
    if (!relMatch) continue;
    const rel = (relMatch[1] ?? relMatch[2] ?? relMatch[3] ?? '').toLowerCase();
    // rel can be space-separated tokens per RFC; "next" is what we want.
    if (rel.split(/\s+/).includes('next')) {
      return url;
    }
  }
  return null;
}

// =============================================================================
// Internal detection helpers
// =============================================================================

function detectGraphQLPagination(data: Record<string, unknown>): Strategy | null {
  const dataField = data['data'];
  if (!isRecord(dataField)) return null;

  for (const [queryName, queryResult] of Object.entries(dataField)) {
    if (!isRecord(queryResult)) continue;

    const pageInfo = queryResult['pageInfo'];
    if (!isRecord(pageInfo)) continue;

    if (!('endCursor' in pageInfo) || !('hasNextPage' in pageInfo)) continue;

    let dataArrayField = '';
    if (isArray(queryResult['nodes'])) {
      dataArrayField = 'nodes';
    } else if (isArray(queryResult['edges'])) {
      dataArrayField = 'edges';
    } else {
      for (const [fieldName, fieldValue] of Object.entries(queryResult)) {
        if (fieldName === 'pageInfo') continue;
        if (isArray(fieldValue)) {
          dataArrayField = fieldName;
          break;
        }
      }
    }

    if (dataArrayField === '') continue;

    return {
      type: 'graphql',
      cursorPath: `data.${queryName}.pageInfo.endCursor`,
      dataPath: `data.${queryName}.${dataArrayField}`,
      cursorParam: 'after',
    };
  }

  return null;
}

function detectOffsetPagination(data: Record<string, unknown>, requestURL: string): Strategy | null {
  for (const pagKey of PAGINATION_KEYS) {
    const pagObj = data[pagKey];
    if (!isRecord(pagObj)) continue;

    const hasTotal = hasAnyKey(pagObj, 'total', 'count', 'totalCount', 'total_count');
    const hasLimit = hasAnyKey(pagObj, 'limit', 'pageSize', 'page_size', 'perPage', 'per_page');
    const hasOffset = hasAnyKey(pagObj, 'offset');
    const hasNext = hasAnyKey(pagObj, 'hasNext', 'has_next');

    if (hasTotal && (hasLimit || hasOffset || hasNext)) {
      let limit = extractIntValue(pagObj, 'limit', 'pageSize', 'page_size', 'perPage', 'per_page');
      if (limit === 0) limit = 100; // default for Webflow and similar

      const dataField = findDataField(data);
      const { offsetParam, limitParam } = guessOffsetLimitParams(requestURL);

      return {
        type: 'offset',
        dataPath: dataField,
        offsetParam,
        limitParam,
        limit,
      };
    }
  }
  return null;
}

/**
 * Find the first cursor field present in the response. Checks top-level first,
 * then nested under pagination wrapper keys (including HubSpot's
 * `paging.next.after` two-level nesting). Returns [fieldName, fullPath].
 */
function findCursorField(data: Record<string, unknown>): [string, string] {
  // Top-level scan
  for (const field of COMMON_CURSOR_FIELDS) {
    const v = data[field];
    if (typeof v === 'string' && v !== '') {
      return [field, field];
    }
  }

  // Nested under pagination wrappers
  const wrappers = ['pagination', 'paging', 'page_info', 'pageInfo', 'meta'];
  for (const pagKey of wrappers) {
    const pagObj = data[pagKey];
    if (!isRecord(pagObj)) continue;

    // direct child fields
    for (const field of COMMON_CURSOR_FIELDS) {
      const v = pagObj[field];
      if (typeof v === 'string' && v !== '') {
        return [field, `${pagKey}.${field}`];
      }
    }

    // nested `next` object (HubSpot's paging.next.after)
    const nextObj = pagObj['next'];
    if (isRecord(nextObj)) {
      for (const field of COMMON_CURSOR_FIELDS) {
        const v = nextObj[field];
        if (typeof v === 'string' && v !== '') {
          return [field, `${pagKey}.next.${field}`];
        }
      }
    }
  }

  return ['', ''];
}

function findDataField(data: Record<string, unknown>): string {
  for (const field of COMMON_DATA_FIELDS) {
    if (isArray(data[field])) return field;
  }
  return '';
}

function guessCursorParam(requestURL: string, cursorField: string): string {
  try {
    const u = new URL(requestURL);
    for (const param of COMMON_CURSOR_PARAMS) {
      if (u.searchParams.has(param)) return param;
    }
  } catch {
    // Unparseable URL — fall through to field-name heuristic
  }

  const lower = cursorField.toLowerCase();
  for (const param of COMMON_CURSOR_PARAMS) {
    if (lower.includes(param.replaceAll('_', ''))) return param;
  }

  return 'cursor';
}

function guessOffsetLimitParams(requestURL: string): { offsetParam: string; limitParam: string } {
  let offsetParam = 'offset';
  let limitParam = 'limit';
  try {
    const u = new URL(requestURL);
    const offsetNames = ['offset', 'skip', 'start'];
    for (const name of offsetNames) {
      if (u.searchParams.has(name)) {
        offsetParam = name;
        break;
      }
    }
    const limitNames = ['limit', 'count', 'per_page', 'perPage', 'page_size', 'pageSize', 'take'];
    for (const name of limitNames) {
      if (u.searchParams.has(name)) {
        limitParam = name;
        break;
      }
    }
  } catch {
    // Unparseable URL — keep defaults
  }
  return { offsetParam, limitParam };
}

// =============================================================================
// Per-page extraction: cursor + records out of a response body
// =============================================================================

/** Extract the next-page cursor from a response. Returns "" when there is no
 *  next page (or strategy is not cursor/graphql). Mirrors `ExtractNextCursor`. */
export function extractNextCursor(responseBody: string, strategy: Strategy | null): string {
  if (!strategy) return '';
  if (strategy.type !== 'cursor' && strategy.type !== 'graphql') return '';

  let data: unknown;
  try {
    data = JSON.parse(responseBody);
  } catch (err) {
    throw new Error(`Parsing response: ${(err as Error).message}`);
  }
  if (!isRecord(data)) return '';

  const cursorPath = strategy.cursorPath ?? '';
  if (cursorPath === '') return '';

  const parts = cursorPath.split('.');

  if (strategy.type === 'graphql') {
    if (parts.length < 2) return '';
    // Navigate to pageInfo (all parts except the last)
    let current: Record<string, unknown> = data;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = current[parts[i]];
      if (!isRecord(next)) return '';
      current = next;
    }
    // current is now the pageInfo object
    if (typeof current['hasNextPage'] === 'boolean' && current['hasNextPage'] === false) {
      return '';
    }
    const endCursor = current['endCursor'];
    return typeof endCursor === 'string' ? endCursor : '';
  }

  // Regular cursor pagination
  let current: Record<string, unknown> = data;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === parts.length - 1) {
      const val = current[part];
      return typeof val === 'string' ? val : '';
    }
    const next = current[part];
    if (!isRecord(next)) return '';
    current = next;
  }
  return '';
}

/**
 * Extract the records array from a response body. If `strategy` is null OR has
 * no `dataPath`, falls back to scanning common field names (then returns the
 * whole object as a single-record array as last resort, matching Go).
 *
 * Raw-array responses (the body is a JSON array, not an object) are returned
 * as-is — this is the Go behavior too.
 */
export function extractData(responseBody: string, strategy: Strategy | null): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch (err) {
    throw new Error(`Parsing response: ${(err as Error).message}`);
  }

  // Raw array response
  if (isArray(parsed)) return parsed;

  if (!isRecord(parsed)) {
    throw new Error('Response is neither a JSON object nor a JSON array.');
  }

  // No strategy or no data path — fall back to common-field scan
  if (!strategy || !strategy.dataPath) {
    for (const field of COMMON_DATA_FIELDS) {
      const val = parsed[field];
      if (isArray(val)) return val;
    }
    return [parsed];
  }

  // Walk the dataPath
  const parts = strategy.dataPath.split('.');
  let current: Record<string, unknown> = parsed;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === parts.length - 1) {
      const val = current[part];
      if (isArray(val)) return val;
      throw new Error(`data field '${strategy.dataPath}' not found or not an array`);
    }
    const next = current[part];
    if (!isRecord(next)) {
      throw new Error(`path '${strategy.dataPath}' not found in response`);
    }
    current = next;
  }
  throw new Error(`data field '${strategy.dataPath}' not found or not an array`);
}

/**
 * For offset-style pagination: do more pages exist beyond `currentOffset`?
 *
 * Checks (in order):
 *   1. Explicit `hasNext` / `has_next` boolean in the pagination metadata
 *   2. `total` > 0 in metadata: compare `currentOffset + limit < total`
 *   3. Fallback: did we get a full page? (`records.length >= limit`)
 *
 * Returns false for non-offset strategies. Mirrors Go's `HasMorePages`.
 */
export function hasMorePages(responseBody: string, strategy: Strategy | null, currentOffset: number): boolean {
  if (!strategy || strategy.type !== 'offset') return false;

  let data: unknown;
  try {
    data = JSON.parse(responseBody);
  } catch (err) {
    throw new Error(`Parsing response: ${(err as Error).message}`);
  }
  if (!isRecord(data)) return false;

  for (const pagKey of PAGINATION_KEYS) {
    const pagObj = data[pagKey];
    if (!isRecord(pagObj)) continue;

    if (typeof pagObj['hasNext'] === 'boolean') return pagObj['hasNext'];
    if (typeof pagObj['has_next'] === 'boolean') return pagObj['has_next'];

    const total = extractIntValue(pagObj, 'total', 'count', 'totalCount', 'total_count');
    if (total > 0) {
      return currentOffset + (strategy.limit ?? 0) < total;
    }
  }

  // Fallback: full-page heuristic
  const records = extractData(responseBody, strategy);
  return records.length >= (strategy.limit ?? 0);
}

/**
 * Construct the URL for the NEXT page, given the cursor (or offset value as a
 * string) and the strategy. For cursor pagination, if the cursor is itself a
 * full http(s) URL we return it directly (Asana / Twilio / HubSpot's "next as
 * full URL" pattern). Returns "" when the cursor is empty.
 *
 * For type=link-header this function is NOT used — the next URL comes from
 * the previous response's `Link` header, not from a cursor. fetch.ts iterates
 * link-header pagination separately.
 *
 * Mirrors Go's `BuildNextURL`.
 */
export function buildNextURL(baseURL: string, cursor: string, strategy: Strategy | null): string {
  if (!strategy) return '';

  if (strategy.type === 'link-header') {
    // Caller should be using parseNextLink + the response Link header instead;
    // BuildNextURL doesn't apply. Return empty to signal "use the link-header path".
    return '';
  }

  let u: URL;
  try {
    u = new URL(baseURL);
  } catch (err) {
    throw new Error(`parsing URL: ${(err as Error).message}`);
  }

  if (strategy.type === 'cursor') {
    if (cursor === '') return '';
    if (cursor.startsWith('http://') || cursor.startsWith('https://')) {
      return cursor;
    }
    u.searchParams.set(strategy.cursorParam ?? 'cursor', cursor);
  } else if (strategy.type === 'offset') {
    if (cursor === '') return '';
    u.searchParams.set(strategy.offsetParam ?? 'offset', cursor);
    if (strategy.limit && strategy.limit > 0) {
      u.searchParams.set(strategy.limitParam ?? 'limit', String(strategy.limit));
    }
  } else if (strategy.type === 'graphql') {
    // GraphQL is POST; this helper isn't the right tool for it. The fetch loop
    // injects the `after` cursor into the request body, not the URL. Return
    // empty so callers don't accidentally rebuild the URL for a GraphQL call.
    return '';
  }

  return u.toString();
}
