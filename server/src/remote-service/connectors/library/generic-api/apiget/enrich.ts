/**
 * Port of apiget/enrich/enrich.go.
 *
 * Enrichment = "the list endpoint returns shallow records; fetch the full
 * record from a per-ID detail endpoint and replace each shallow record with
 * the full one". Used when the API has separate list and detail endpoints
 * and the user opts in.
 */

import { isRecord } from './internal-helpers';
import type { FetchFn } from './types';

/** Common ID field names checked in order. Mirrors `commonIDFields` in Go. */
export const COMMON_ID_FIELDS = ['id', '_id', 'ID', 'Id', 'uuid', 'UUID', 'uid', 'UID'] as const;

/**
 * Find the first matching ID field on a record. Returns `[fieldName, value]` or
 * `[null, null]` if no common ID field is present. Mirrors Go's `FindIDField`.
 */
export function findIdField(record: Record<string, unknown>): [string, unknown] | [null, null] {
  for (const field of COMMON_ID_FIELDS) {
    if (field in record) {
      return [field, record[field]];
    }
  }
  return [null, null];
}

/**
 * Build the per-record detail URL by appending the recordId to the list URL's
 * path (after stripping query params). Mirrors Go's `InferDetailURL`.
 *
 * Example:
 *   listURL  = "https://api.example.com/items?status=active"
 *   recordId = 12345
 *   result   = "https://api.example.com/items/12345"
 *
 * Throws if the recordId is not a primitive (string / number / boolean) — eng
 * review item: prevents `[object Object]` in URLs for composite-ID APIs
 * (Attio-style `{record_id, workspace_id}`).
 */
export function inferDetailURL(listURL: string, recordId: unknown): string {
  if (recordId === null || recordId === undefined) {
    throw new Error('Cannot infer detail URL: record ID is null or undefined.');
  }
  if (typeof recordId === 'object') {
    throw new Error(
      `Cannot infer detail URL: record ID is an object (${JSON.stringify(recordId)}). ` +
        `Composite-ID APIs (e.g. Attio) are not supported by automatic enrichment. ` +
        `Use a per-endpoint URL override with the right path template.`,
    );
  }

  // After the object/null/undefined guards above, recordId is string | number | boolean | bigint | symbol.
  // Symbol would still trip stringification — explicitly reject.
  if (typeof recordId === 'symbol') {
    throw new Error('Cannot infer detail URL: record ID is a symbol.');
  }
  // Explicit per-type conversion (avoids String(unknown) which the lint rule flags).
  let idStr: string;
  if (typeof recordId === 'string') idStr = recordId;
  else if (typeof recordId === 'number') idStr = recordId.toString(10);
  else if (typeof recordId === 'boolean') idStr = recordId ? 'true' : 'false';
  else if (typeof recordId === 'bigint') idStr = recordId.toString(10);
  else {
    // Unreachable given the guards above, but keeps the linter happy.
    throw new Error(`Cannot infer detail URL: unsupported record ID type ${typeof recordId}.`);
  }

  const u = new URL(listURL);
  u.search = ''; // strip query params — the detail endpoint typically doesn't need them
  const trimmedPath = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  u.pathname = `${trimmedPath}/${encodeURIComponent(idStr)}`;
  return u.toString();
}

/**
 * Extract a record from a per-detail response. Many APIs wrap the record in
 * a `data` field; we handle that. Mirrors Go's `extractDataFromResponse`.
 */
function extractDataFromResponse(responseBody: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch (err) {
    throw new Error(`Parsing detail response: ${(err as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Unexpected detail response format: expected JSON object.');
  }

  // Unwrap a `data` field if present
  if (isRecord(parsed['data'])) {
    return parsed['data'];
  }

  return parsed;
}

/**
 * For each record in `records`, fetch its full version from the inferred
 * detail URL and replace the shallow record in place. Mirrors Go's
 * `EnrichRecords`.
 *
 * @throws if any record has no detectable ID field, or if any detail fetch
 *         returns a non-2xx body the caller's `fetch` rejected, or if any
 *         response can't be parsed.
 */
export async function enrichRecords(
  records: unknown[],
  listURL: string,
  fetch: FetchFn,
  progressFn?: (current: number, total: number) => void,
): Promise<void> {
  if (records.length === 0) return;

  const total = records.length;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!isRecord(record)) continue;

    const [idField, idValue] = findIdField(record);
    if (idField === null) {
      throw new Error(`Could not find ID field in record (tried: ${COMMON_ID_FIELDS.join(', ')}).`);
    }

    const detailURL = inferDetailURL(listURL, idValue);
    const response = await fetch({ url: detailURL, method: 'GET', headers: {} });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Fetching detail for record ${String(idValue)}: HTTP ${response.status}`);
    }

    records[i] = extractDataFromResponse(response.body);
    progressFn?.(i + 1, total);
  }
}
