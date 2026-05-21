/**
 * Standalone driver for the ported apiget library. Used to iterate on real
 * services without going through the full NestJS / GENERIC_API connector
 * stack — the only inputs are a fixture JSON (same shape the AI agent
 * returns to the user) and an API key from an env var.
 *
 * Usage:
 *   API_KEY=... yarn apiget:driver <service>             # uses scripts/apiget-fixtures/<service>.json
 *   API_KEY=... yarn apiget:driver --config <path>       # arbitrary path
 *   API_KEY=... yarn apiget:driver <service> --endpoint Tasks
 *   API_KEY=... yarn apiget:driver <service> --max-pages 3
 *   API_KEY=... yarn apiget:driver <service> --page-size 2   # force tiny pages
 *
 * The driver writes one JSON file per page plus a summary.json under
 * `server/apiget-output/<service>-<timestamp>/<endpoint-name>/`. The
 * summary captures detected pagination, record counts, the first record's
 * keys, etc. Pre-existing output dirs are NEVER overwritten — each run
 * gets its own timestamped folder so you can diff across iterations.
 *
 * Fixture shape (same as GenericApiConnectorExtras post-validator):
 *   {
 *     "apiType": "rest",
 *     "authHeader": { "style": "bearer" },
 *     "endpoints": [
 *       { "id": "ep_projects", "name": "Projects", "method": "GET",
 *         "url": "https://api.todoist.com/api/v1/projects" }
 *     ]
 *   }
 *
 * The driver also accepts the AI's wire-shape (`"authHeader": "Bearer"`
 * as a string) and normalizes it via the shared paste-validator so
 * fixtures can be created directly from AI responses.
 */

import type { GenericApiConnectorExtras } from '@spinner/shared-types';
import { isGenericApiConnectorExtras, validatePastedConfig } from '@spinner/shared-types';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApigetSettings,
  apigetStream,
  ApigetStreamYield,
  FetchFn,
  HttpStatusError,
  MaxPagesReachedError,
  NonJsonResponseError,
  PaginationLoopError,
  ssrfSafeFetch,
  Strategy,
} from '../remote-service/connectors/library/generic-api/apiget';
import { applyOverridesToSettings } from '../remote-service/connectors/library/generic-api/apply-overrides';
import { buildAuthHeaders } from '../remote-service/connectors/library/generic-api/generic-api-connector';

interface DriverArgs {
  service: string | null;
  configPath: string | null;
  endpointFilter: string | null;
  maxPages: number;
  pageSize: number | null;
  outputRoot: string;
}

interface EndpointReport {
  endpointId: string;
  endpointName: string;
  url: string;
  detectedPagination: Strategy | null;
  detectedIdField: string | null;
  pagesWalked: number;
  totalRecords: number;
  firstRecordKeys: string[] | null;
  durationMs: number;
  error?: { name: string; message: string };
}

interface DriverReport {
  service: string;
  fixturePath: string;
  outputDir: string;
  apiType: 'rest' | 'graphql';
  endpoints: EndpointReport[];
}

const SCRIPTS_DIR = __dirname;
const FIXTURES_DIR = join(SCRIPTS_DIR, 'apiget-fixtures');
const DEFAULT_OUTPUT_ROOT = join(SCRIPTS_DIR, '..', '..', 'apiget-output');
const DEFAULT_MAX_PAGES = 5;

function parseArgs(argv: string[]): DriverArgs {
  const args: DriverArgs = {
    service: null,
    configPath: null,
    endpointFilter: null,
    maxPages: DEFAULT_MAX_PAGES,
    pageSize: null,
    outputRoot: DEFAULT_OUTPUT_ROOT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') {
      args.configPath = argv[++i];
    } else if (a === '--endpoint') {
      args.endpointFilter = argv[++i];
    } else if (a === '--max-pages') {
      args.maxPages = Number(argv[++i]);
      if (!Number.isFinite(args.maxPages) || args.maxPages < 1) {
        throw new Error('--max-pages must be a positive integer');
      }
    } else if (a === '--page-size') {
      args.pageSize = Number(argv[++i]);
      if (!Number.isFinite(args.pageSize) || (args.pageSize ?? 0) < 1) {
        throw new Error('--page-size must be a positive integer');
      }
    } else if (a === '--output-root') {
      args.outputRoot = argv[++i];
    } else if (!a.startsWith('--') && args.service === null) {
      args.service = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function resolveFixturePath(args: DriverArgs): string {
  if (args.configPath) return args.configPath;
  if (!args.service) {
    throw new Error(
      'Provide either a service name (e.g. "todoist") that resolves to apiget-fixtures/<service>.json, or --config <path>.',
    );
  }
  const path = join(FIXTURES_DIR, `${args.service}.json`);
  if (!existsSync(path)) {
    throw new Error(`Fixture not found: ${path}`);
  }
  return path;
}

function readApiKey(service: string | null): string {
  const candidates: string[] = [];
  if (service) candidates.push(`${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`);
  candidates.push('API_KEY');
  for (const name of candidates) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value.trim();
  }
  throw new Error(
    `No API key found. Set one of: ${candidates.join(', ')}. Example: API_KEY=abc123 yarn apiget:driver <service>`,
  );
}

function loadAndNormalizeExtras(fixturePath: string): GenericApiConnectorExtras {
  const raw = readFileSync(fixturePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Fixture ${fixturePath} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Fixture ${fixturePath} top-level must be an object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const apiType = obj.apiType;
  if (apiType !== 'rest' && apiType !== 'graphql') {
    throw new Error(`Fixture ${fixturePath} must include "apiType": "rest" | "graphql".`);
  }

  // Canonical shape — accept directly.
  if (isGenericApiConnectorExtras(parsed)) return parsed;

  // Wire shape (authHeader is a string like "Bearer") — normalize via the paste validator.
  // We feed JUST the AI-output fields (no apiType key — the validator gets that as a separate arg).
  const { apiType: _ignored, ...wireShape } = obj;
  void _ignored;
  const wireJson = JSON.stringify(wireShape);
  const result = validatePastedConfig(wireJson, apiType);
  if (!result.ok) {
    throw new Error(`Fixture ${fixturePath} failed shape validation: ${result.error.message}`);
  }
  return result.extras;
}

function composeApigetSettings(
  extras: GenericApiConnectorExtras,
  apiKey: string,
  endpointIndex: number,
  maxPages: number,
  runtimePageSize: number | null,
): ApigetSettings {
  const endpoint = extras.endpoints[endpointIndex];
  const isRest = extras.apiType === 'rest';
  const headers = buildAuthHeaders(extras, apiKey);
  const baseSettings: ApigetSettings = {
    url: endpoint.url,
    method: isRest ? ((endpoint as { method?: 'GET' | 'POST' }).method ?? 'GET') : 'POST',
    headers,
    body: isRest ? (endpoint as { body?: unknown }).body : { query: (endpoint as { query: string }).query },
    maxPages,
  };
  // Honor per-endpoint overrides — same path the connector uses. The runtime
  // pageSize (driver --page-size) is passed through to drive strategy.limit;
  // it's clamped to overrides.request.maxPageSize inside applyOverridesToSettings.
  return applyOverridesToSettings(baseSettings, endpoint.overrides, {
    pageSize: runtimePageSize ?? undefined,
  });
}

function sanitizeForFs(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

async function runEndpoint(opts: {
  extras: GenericApiConnectorExtras;
  apiKey: string;
  endpointIndex: number;
  maxPages: number;
  pageSize: number | null;
  outputDir: string;
}): Promise<EndpointReport> {
  const { extras, apiKey, endpointIndex, maxPages, pageSize, outputDir } = opts;
  const endpoint = extras.endpoints[endpointIndex];
  const endpointName = endpoint.name?.trim() || `endpoint-${endpointIndex + 1}`;
  const endpointDir = join(outputDir, sanitizeForFs(endpointName));
  await mkdir(endpointDir, { recursive: true });

  const report: EndpointReport = {
    endpointId: endpoint.id,
    endpointName,
    url: endpoint.url,
    detectedPagination: null,
    detectedIdField: null,
    pagesWalked: 0,
    totalRecords: 0,
    firstRecordKeys: null,
    durationMs: 0,
  };

  const startedAt = Date.now();
  // Capture each raw HTTP response so we can write both raw + mapped files
  // per page. Stored by call-order; index N is page N's raw response.
  const rawResponses: { status: number; body: string }[] = [];
  const capturingFetch = makeCapturingFetch(rawResponses);

  try {
    const settings = composeApigetSettings(extras, apiKey, endpointIndex, maxPages, pageSize);
    let pageIndex = 0;
    for await (const page of apigetStream(settings, { fetch: capturingFetch })) {
      pageIndex++;
      const page_: ApigetStreamYield = page;
      if (page_.detected) {
        report.detectedPagination = page_.detected.pagination;
        report.detectedIdField = page_.detected.idField;
      }
      report.pagesWalked = pageIndex;
      report.totalRecords += page_.records.length;
      if (report.firstRecordKeys === null && page_.records.length > 0) {
        const first = page_.records[0];
        report.firstRecordKeys =
          first !== null && typeof first === 'object' && !Array.isArray(first)
            ? Object.keys(first as Record<string, unknown>).slice(0, 30)
            : ['<not an object>'];
      }
      const pageNum = String(pageIndex).padStart(3, '0');
      // Mapped: what apiget gave us — records extracted + pagination state promoted.
      await writeFile(
        join(endpointDir, `page-${pageNum}-mapped.json`),
        JSON.stringify({ pageIndex, cursor: page_.cursor, offset: page_.offset, records: page_.records }, null, 2),
        'utf-8',
      );
      // Raw: the unmodified response body the API returned (pretty-printed if JSON).
      const raw = rawResponses[pageIndex - 1];
      if (raw) {
        let prettyBody = raw.body;
        try {
          prettyBody = JSON.stringify(JSON.parse(raw.body), null, 2);
        } catch {
          // not JSON — write as-is
        }
        await writeFile(join(endpointDir, `page-${pageNum}-raw.json`), prettyBody, 'utf-8');
      }
    }
  } catch (e) {
    const err = e as Error;
    report.error = { name: err.name, message: err.message };
    // Include a more detailed body excerpt for HttpStatusError so we can diagnose.
    if (e instanceof HttpStatusError) {
      report.error.message = `HTTP ${e.status}: ${e.body.slice(0, 1000)}`;
    } else if (
      e instanceof NonJsonResponseError ||
      e instanceof MaxPagesReachedError ||
      e instanceof PaginationLoopError
    ) {
      report.error.message = err.message;
    }
  }
  report.durationMs = Date.now() - startedAt;

  await writeFile(join(endpointDir, 'summary.json'), JSON.stringify(report, null, 2), 'utf-8');
  return report;
}

function printReport(report: DriverReport): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(`apiget driver report — ${report.service}`);
  lines.push(`  fixture:  ${report.fixturePath}`);
  lines.push(`  output:   ${report.outputDir}`);
  lines.push(`  apiType:  ${report.apiType}`);
  lines.push('');
  for (const ep of report.endpoints) {
    const status = ep.error ? `FAIL` : `OK`;
    lines.push(`  [${status}] ${ep.endpointName}  (${ep.url})`);
    if (ep.error) {
      lines.push(`    error: ${ep.error.name}: ${ep.error.message}`);
      continue;
    }
    const pagType = ep.detectedPagination?.type ?? 'none';
    lines.push(
      `    pagination=${pagType}  idField=${ep.detectedIdField ?? '?'}  ` +
        `pages=${ep.pagesWalked}  records=${ep.totalRecords}  duration=${ep.durationMs}ms`,
    );
    if (ep.firstRecordKeys) {
      lines.push(`    first record keys: [${ep.firstRecordKeys.join(', ')}]`);
    }
  }
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixturePath = resolveFixturePath(args);
  const apiKey = readApiKey(args.service);
  const extras = loadAndNormalizeExtras(fixturePath);
  // --page-size flows through `runtime.pageSize` to apiget — no need to
  // pre-patch URLs anymore. apiget builds page 1's URL with offset/limit
  // the same way it builds page 2+.

  const serviceLabel = args.service ?? 'custom';
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = join(args.outputRoot, `${serviceLabel}-${runId}`);
  await mkdir(outputDir, { recursive: true });

  // Persist the resolved extras alongside the output so the run is fully
  // reproducible from disk (minus the API key).
  await writeFile(join(outputDir, 'resolved-extras.json'), JSON.stringify(extras, null, 2), 'utf-8');

  const targetIndices: number[] = [];
  extras.endpoints.forEach((ep, i) => {
    if (args.endpointFilter && ep.name?.toLowerCase() !== args.endpointFilter.toLowerCase()) return;
    targetIndices.push(i);
  });
  if (targetIndices.length === 0) {
    throw new Error(
      args.endpointFilter
        ? `No endpoint matched --endpoint "${args.endpointFilter}".`
        : 'Fixture contains no endpoints.',
    );
  }

  const endpointReports: EndpointReport[] = [];
  for (const i of targetIndices) {
    const r = await runEndpoint({
      extras,
      apiKey,
      endpointIndex: i,
      maxPages: args.maxPages,
      pageSize: args.pageSize,
      outputDir,
    });
    endpointReports.push(r);
  }

  const report: DriverReport = {
    service: serviceLabel,
    fixturePath,
    outputDir,
    apiType: extras.apiType,
    endpoints: endpointReports,
  };
  await writeFile(join(outputDir, 'driver-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  printReport(report);
}

/**
 * Wrap native fetch so we can capture each raw response body in call-order.
 * Behavior mirrors apiget's internal default fetch (POST with body, redirect:
 * follow, lowercase header keys, body as text) — we just additionally push
 * each response into the supplied array.
 */
function makeCapturingFetch(capture: { status: number; body: string }[]): FetchFn {
  return async (request) => {
    // Route through the same SSRF-guarded transport prod uses. The driver now
    // exercises the full guard path (URL validation + DNS + private-IP blocklist
    // + pinned-connect undici Agent + redirect re-validation + body cap) so any
    // regression in those layers fails the driver against real fixtures — same
    // surface the client hits.
    const response = await ssrfSafeFetch(request);
    capture.push({ status: response.status, body: response.body });
    return response;
  };
}

main().catch((e: unknown) => {
  const err = e as Error;
  process.stderr.write(`\napiget-driver failed: ${err.message}\n${err.stack ?? ''}\n`);
  process.exit(1);
});
