/**
 * Probe orchestrator for the GENERIC_API connector.
 *
 * Two entry points, both share the same primitives:
 *   - probeAuthOnly() — connection-save probe. ONE HTTP call against the first
 *     endpoint with auth. Confirms apiKey works before we persist the account.
 *     Used by ConnectorAccountService.create.
 *   - probeEndpointForTable() — table-pick probe. Page 1 + page 2 verification
 *     + walks every record to infer schema. Returns a ready-to-persist
 *     GenericApiFolderOptions.probe payload. Used by the add-table flow
 *     (PR 5 wiring) and the manual Re-probe action.
 *
 * No NestJS deps — pure function module so it's trivially testable. Callers
 * supply the apiKey + extras + endpoint id and get a result back.
 */

import {
  GenericApiConnectorExtras,
  GenericApiFolderOptions,
  GenericApiGraphqlEndpoint,
  GenericApiRestEndpoint,
} from '@spinner/shared-types';
import { ApigetSettings, apigetStream, FetchFn, FetchResponse, Header, Strategy } from './apiget';
import { buildAuthHeaders } from './generic-api-connector';
import { inferJsonSchema } from './generic-api-schema-inference';

/** Output of the per-endpoint probe — ready to persist as `genericApi.probe`. */
export interface ProbeResult {
  /** Persistable probe payload — matches GenericApiFolderOptions.probe shape. */
  probe: GenericApiFolderOptions['probe'];
  /** Total record count walked across both pages (helpful for status UI). */
  recordsWalked: number;
  /** Page 1 status — always 'ok' if probe didn't throw. */
  page1Status: 'ok';
  /** Page 2 status — 'ok' if reached, 'no-pagination' if endpoint is single-page, 'skipped' if probe disabled it. */
  page2Status: 'ok' | 'no-pagination';
  /** Records seen on page 2 (0 when page2Status='no-pagination'). */
  page2RecordCount: number;
}

/** Build the apiget settings for one endpoint. Shared between probe + the connector's pull path. */
function composeApigetSettings(
  extras: GenericApiConnectorExtras,
  apiKey: string,
  endpoint: GenericApiRestEndpoint | GenericApiGraphqlEndpoint,
  maxPages: number,
): ApigetSettings {
  const headers: Header[] = buildAuthHeaders(extras, apiKey);
  const isRest = extras.apiType === 'rest';
  const restEp = endpoint as GenericApiRestEndpoint;
  const gqlEp = endpoint as GenericApiGraphqlEndpoint;
  return {
    url: endpoint.url,
    method: isRest ? restEp.method : 'POST',
    headers,
    body: isRest ? restEp.body : { query: gqlEp.query },
    maxPages,
  };
}

/**
 * Connection-save probe. Validates auth + URL with ONE HTTP call against the
 * FIRST endpoint. Throws on any non-2xx / non-JSON / timeout — caller maps
 * the error to a user-facing message and refuses to create the connector
 * account row.
 *
 * No schema work, no pagination follow-through. The user just wants to know
 * "is my key valid before I get past the modal".
 */
export async function probeAuthOnly(opts: {
  extras: GenericApiConnectorExtras;
  apiKey: string;
  fetch?: FetchFn;
}): Promise<void> {
  if (opts.extras.endpoints.length === 0) {
    throw new Error('No endpoints configured — add at least one endpoint to the connection.');
  }
  const settings = composeApigetSettings(opts.extras, opts.apiKey, opts.extras.endpoints[0], 1);
  const iter = apigetStream(settings, { fetch: opts.fetch });
  const first = await iter.next();
  if (first.done) {
    throw new Error('Endpoint returned no response.');
  }
  // Drain remaining (won't fire since maxPages=1 + no follow-through) so the
  // generator can clean up its resources.
  await iter.return(undefined);
}

/**
 * Table-pick probe (PR 5). Page 1 + page 2 verification + schema inference.
 * Returns a ProbeResult the caller persists to DataFolder.options.genericApi.probe.
 *
 * Bounded by `maxPages=2` (page 1 + page 2 verification) and the schema-
 * inference module's own 500-record cap. The cycle detection + maxPages
 * backstop inside apigetStream provide additional safety.
 */
export async function probeEndpointForTable(opts: {
  extras: GenericApiConnectorExtras;
  apiKey: string;
  endpointId: string;
  /** Override the default extractionIdPath ('id'). */
  extractionIdPath?: string;
  fetch?: FetchFn;
}): Promise<ProbeResult> {
  const endpoint = opts.extras.endpoints.find((e) => e.id === opts.endpointId);
  if (!endpoint) {
    throw new Error(`Endpoint "${opts.endpointId}" not found on the connection.`);
  }

  const settings = composeApigetSettings(opts.extras, opts.apiKey, endpoint, 2);
  const iter = apigetStream(settings, { fetch: opts.fetch });

  // Page 1
  const page1 = await iter.next();
  if (page1.done) {
    throw new Error('Probe returned no pages — the endpoint may have rejected the request.');
  }
  const page1Records = page1.value.records;
  const detectedPagination: Strategy | null = page1.value.detected?.pagination ?? null;
  const idField = page1.value.detected?.idField ?? 'id';
  const extractionIdPath = opts.extractionIdPath ?? idField;

  // Page 2 — only if pagination was detected on page 1. If not, the endpoint
  // is single-page and we're done.
  let page2Records: unknown[] = [];
  let page2Status: ProbeResult['page2Status'] = 'no-pagination';
  if (detectedPagination !== null) {
    const page2 = await iter.next();
    if (!page2.done) {
      page2Records = page2.value.records;
      page2Status = 'ok';
    }
  }
  // Drain (no-op if already done) so the generator releases.
  await iter.return(undefined);

  // Walk every record from both pages through schema inference
  const allRecords = [...page1Records, ...page2Records];
  const inferredSchema = inferJsonSchema(allRecords);

  return {
    probe: {
      detectedPagination: strategyToPersisted(detectedPagination),
      extractionIdPath,
      inferredSchema,
      lastProbedAt: new Date().toISOString(),
    },
    recordsWalked: allRecords.length,
    page1Status: 'ok',
    page2Status,
    page2RecordCount: page2Records.length,
  };
}

/**
 * Compare two ProbeResults and surface diffs the caller (re-probe UI) needs
 * to decide whether to silent-overwrite or hard-stop.
 *
 * Per impl plan §5 re-probe diff handling:
 *   - Pagination Strategy unchanged → silent overwrite.
 *   - Pagination Strategy changed → silent overwrite + log (user can't see
 *     settings anyway in v1 since no schema UI).
 *   - Schema gained fields → silently add and save.
 *   - Schema removed fields → keep in saved schema, mark "not seen".
 *   - extractionIdPath resolves differently → HARD STOP, surface dialog.
 *     Caller must require explicit user confirmation before applying.
 */
export interface ProbeDiff {
  extractionIdPathChanged: boolean;
  paginationStrategyChanged: boolean;
  schemaFieldsAdded: string[];
  schemaFieldsRemoved: string[];
}

export function diffProbeResults(
  previous: GenericApiFolderOptions['probe'],
  next: GenericApiFolderOptions['probe'],
): ProbeDiff {
  const extractionIdPathChanged = previous.extractionIdPath !== next.extractionIdPath;
  const paginationStrategyChanged =
    JSON.stringify(previous.detectedPagination) !== JSON.stringify(next.detectedPagination);

  const prevFields = topLevelFieldNames(previous.inferredSchema);
  const nextFields = topLevelFieldNames(next.inferredSchema);
  const schemaFieldsAdded = nextFields.filter((f) => !prevFields.includes(f));
  const schemaFieldsRemoved = prevFields.filter((f) => !nextFields.includes(f));

  return { extractionIdPathChanged, paginationStrategyChanged, schemaFieldsAdded, schemaFieldsRemoved };
}

function topLevelFieldNames(schema: object): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties || typeof properties !== 'object') return [];
  return Object.keys(properties).sort();
}

/** Re-shape an apiget Strategy to the persisted-on-disk format. */
function strategyToPersisted(s: Strategy | null): GenericApiFolderOptions['probe']['detectedPagination'] {
  if (!s) return null;
  return {
    type: s.type,
    cursorPath: s.cursorPath,
    dataPath: s.dataPath,
    cursorParam: s.cursorParam,
    offsetParam: s.offsetParam,
    limitParam: s.limitParam,
    limit: s.limit,
  };
}

// Re-export for FetchResponse-using tests
export type { FetchResponse };
