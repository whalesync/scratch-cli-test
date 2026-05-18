/**
 * Port of apiget/expander/expander.go.
 *
 * "Expansion" = for hierarchical APIs (Notion blocks, Shopify product variants,
 * etc.), recursively fetch each record's children via a templated URL and
 * inline them under a configured field. Bounded by `maxDepth`.
 */

import { isArray, isRecord } from './internal-helpers';
import type { ExpanderConfig, FetchFn } from './types';

/**
 * Recursively expand nested content in a list of records, in place.
 *
 * For each record where `shouldExpand` returns true, fetch its children from
 * the templated URL (handling that URL's own pagination internally) and
 * insert the resulting array under `config.childrenField`. Then recurse into
 * those children, stopping at `config.maxDepth` (0 = unlimited).
 *
 * Mirrors Go's `ExpandNested`. Modifies `records` in place; throws on URL
 * construction or fetch failure.
 */
export async function expandNested(
  records: unknown[],
  config: ExpanderConfig,
  fetch: FetchFn,
  currentDepth = 0,
): Promise<void> {
  if (!config.enabled) return;
  if (config.maxDepth > 0 && currentDepth >= config.maxDepth) return;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!isRecord(record)) continue;

    if (!shouldExpand(record, config)) continue;

    const childrenURL = buildChildrenURL(config.baseURL, config.childrenURLPattern, record);
    const children = await fetchAllChildren(childrenURL, fetch);
    await expandNested(children, config, fetch, currentDepth + 1);
    record[config.childrenField] = children;
    records[i] = record;
  }
}

/**
 * Does this record carry nested content per the config? Either the field
 * exists (when no expected value is set) or the field's value matches the
 * expected value. Mirrors Go's `shouldExpand`.
 */
function shouldExpand(record: Record<string, unknown>, config: ExpanderConfig): boolean {
  if (config.hasNestedField === '') return false;
  if (!(config.hasNestedField in record)) return false;
  const value = record[config.hasNestedField];
  if (config.hasNestedValue === undefined || config.hasNestedValue === null) return true;
  return value === config.hasNestedValue;
}

/**
 * Fetch all child records for one parent, handling that endpoint's own
 * pagination. Uses a conservative built-in scheme (`has_more` boolean +
 * `next_cursor`-style fields) — this is the simple expansion-internal
 * paginator, NOT the full apiget pagination engine. Mirrors Go's
 * `fetchAllChildren`.
 *
 * If/when a customer needs richer pagination for the children themselves,
 * we can swap this to call apigetStream recursively — out of scope for v1.
 */
async function fetchAllChildren(initialURL: string, fetch: FetchFn): Promise<unknown[]> {
  const all: unknown[] = [];
  let currentURL = initialURL;

  for (;;) {
    const response = await fetch({ url: currentURL, method: 'GET', headers: {} });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Fetching children from ${currentURL}: HTTP ${response.status}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch (err) {
      throw new Error(`Parsing children response: ${(err as Error).message}`);
    }
    if (!isRecord(parsed)) {
      throw new Error('No data array found in children response (expected JSON object).');
    }

    const children = extractDataArray(parsed);
    if (children === null) {
      throw new Error('No data array found in children response.');
    }
    all.push(...children);

    if (!hasMorePages(parsed)) break;

    const nextCursor = extractNextCursor(parsed);
    if (nextCursor === '') break;

    const u = new URL(currentURL);
    u.searchParams.set('start_cursor', nextCursor);
    currentURL = u.toString();
  }

  return all;
}

/** Locate the children array under common field names. Mirrors Go's
 *  `extractDataArray`. Returns null when no recognized field carries an array. */
function extractDataArray(response: Record<string, unknown>): unknown[] | null {
  const dataFields = ['results', 'data', 'items', 'records', 'entries'];
  for (const field of dataFields) {
    const value = response[field];
    if (isArray(value)) return value;
  }
  return null;
}

/** "Are there more pages of children?" — checks `has_more` then falls back to
 *  cursor presence. Mirrors Go's `hasMorePages` (in expander.go specifically). */
function hasMorePages(response: Record<string, unknown>): boolean {
  if (typeof response['has_more'] === 'boolean') {
    return response['has_more'];
  }
  return extractNextCursor(response) !== '';
}

/** Common cursor field names for the expander's built-in paginator (smaller
 *  set than the main pagination module — matches Go expander.go). */
function extractNextCursor(response: Record<string, unknown>): string {
  const fields = ['next_cursor', 'nextCursor', 'cursor', 'next'];
  for (const field of fields) {
    const v = response[field];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/**
 * Build the children URL by substituting `{fieldName}` placeholders in
 * `pattern` with the corresponding values from `record`. Mirrors Go's
 * `buildChildrenURL`.
 *
 * Throws if any placeholder is left unresolved (e.g. record is missing the
 * field the pattern references).
 *
 * Example:
 *   baseURL = "https://api.notion.com"
 *   pattern = "/v1/blocks/{id}/children"
 *   record  = { id: "abc123", ... }
 *   result  = "https://api.notion.com/v1/blocks/abc123/children"
 */
export function buildChildrenURL(baseURL: string, pattern: string, record: Record<string, unknown>): string {
  let path = pattern;
  for (const [key, value] of Object.entries(record)) {
    const placeholder = `{${key}}`;
    if (path.includes(placeholder)) {
      // Match Go's `fmt.Sprintf("%v", value)` semantics — non-primitive values
      // get JSON-ish stringified. URL-encode to avoid path issues.
      // Explicit per-type stringification (avoids String(unknown) which the lint rule flags).
      let valueStr: string;
      if (value === undefined || value === null) valueStr = '';
      else if (typeof value === 'string') valueStr = value;
      else if (typeof value === 'number') valueStr = value.toString(10);
      else if (typeof value === 'boolean') valueStr = value ? 'true' : 'false';
      else if (typeof value === 'bigint') valueStr = value.toString();
      else if (typeof value === 'symbol') valueStr = value.toString();
      else valueStr = JSON.stringify(value) ?? ''; // object / array
      path = path.split(placeholder).join(encodeURIComponent(valueStr));
    }
  }

  if (path.includes('{') && path.includes('}')) {
    throw new Error(`Unresolved placeholders in URL pattern: ${path}`);
  }

  const u = new URL(baseURL);
  u.pathname = path;
  return u.toString();
}
