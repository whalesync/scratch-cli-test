/**
 * Affinity connector live API integration test (read-only).
 *
 * Exercises the real Affinity v2 API: validates credentials, discovers lists,
 * builds a schema for the first list, and pulls one page of list entries.
 *
 * Requires AFFINITY_API_KEY in .env.integration.
 * Run via: cd server && yarn test:integration -- affinity-connector
 */

// Break the circular import chain that pulls in display-names → registry → DB.
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { AffinityApiClient } from 'src/remote-service/connectors/library/affinity/affinity-api-client';
import { AffinityConnector } from 'src/remote-service/connectors/library/affinity/affinity-connector';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

jest.setTimeout(60_000);

const API_KEY = process.env.AFFINITY_API_KEY;

function createConnector(): AffinityConnector {
  return new AffinityConnector(API_KEY!);
}

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('AffinityConnector — live API', () => {
  let connector: AffinityConnector;
  let allTables: TablePreview[];

  beforeAll(async () => {
    connector = createConnector();
    allTables = await connector.listTables();
  });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects an obviously invalid key', async () => {
      const badConnector = new AffinityConnector('not-a-real-affinity-key');
      await expect(badConnector.testConnection()).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // List discovery (each Affinity list = one Scratch table)
  // -------------------------------------------------------------------------

  describe('listTables', () => {
    it('returns at least one list', () => {
      expect(allTables.length).toBeGreaterThan(0);
    });

    it('every table has a numeric remote id and a typed parent path', () => {
      for (const table of allTables) {
        expect(table.id.wsId).toMatch(/^list_\d+$/);
        expect(table.id.remoteId).toHaveLength(1);
        expect(Number.isFinite(parseInt(table.id.remoteId[0], 10))).toBe(true);

        // listTables groups by entity type — every parentPath ends in "lists".
        expect(table.parentPath).toMatch(/lists$/);

        const meta = table.metadata as { listType: string; listId: number; isPublic: boolean } | undefined;
        expect(meta).toBeDefined();
        expect(['company', 'person', 'opportunity']).toContain(meta!.listType);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Schema discovery (per-list field metadata via /v2/lists/{id}/fields)
  // -------------------------------------------------------------------------

  describe('fetchJsonTableSpec', () => {
    let firstSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      firstSpec = await connector.fetchJsonTableSpec(allTables[0].id);
    });

    it('builds a spec with the expected top-level fields', () => {
      expect(firstSpec.id).toEqual(allTables[0].id);
      expect(firstSpec.name).toBe(allTables[0].displayName);
      expect(firstSpec.idColumnRemoteId).toBe('id');

      const props = (firstSpec.schema as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('type');
      expect(props).toHaveProperty('listId');
      expect(props).toHaveProperty('createdAt');
      expect(props).toHaveProperty('creatorId');
      expect(props).toHaveProperty('entity');
    });

    it('points titleColumnRemoteId at a real entity field', () => {
      const path = firstSpec.titleColumnRemoteId;
      expect(path?.[0]).toBe('entity');
      expect(['name', 'firstName']).toContain(path?.[1]);
    });

    it('mounts list-specific fields under entity.fields keyed by remote id', () => {
      const entitySchema = (firstSpec.schema as { properties: { entity: { properties: Record<string, unknown> } } })
        .properties.entity;
      expect(entitySchema.properties).toHaveProperty('fields');

      // entity.fields is an object whose keys are field ids — even an empty
      // list passes since the schema is built from /v2/lists/{id}/fields,
      // not from any record.
      const fieldsSchema = entitySchema.properties.fields as { properties?: Record<string, unknown>; type: string };
      expect(fieldsSchema.type).toBe('object');
      expect(fieldsSchema.properties).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Record pull (one page only — keeps the test cheap on large lists)
  // -------------------------------------------------------------------------

  describe('pullRecordFiles', () => {
    it('streams the first page of list entries with field data inline', async () => {
      const tableSpec = await connector.fetchJsonTableSpec(allTables[0].id);

      const allFiles: ConnectorFile[] = [];
      let firstCheckpoint: { cursor?: string } | undefined;
      let callbacks = 0;

      // Throw out of the iterator after the first batch — we don't want to pull
      // every record on every test run, just confirm the shape is right.
      try {
        await connector.pullRecordFiles(
          tableSpec,
          // eslint-disable-next-line @typescript-eslint/require-await
          async ({ files, connectorProgress }) => {
            callbacks += 1;
            allFiles.push(...files);
            if (firstCheckpoint === undefined) {
              firstCheckpoint = connectorProgress;
            }
            throw new EarlyExit();
          },
          {},
          { forceFull: false },
        );
      } catch (error) {
        if (!(error instanceof EarlyExit)) throw error;
      }

      expect(callbacks).toBe(1);

      // Empty lists are valid — just confirm the call returned successfully and
      // that any records we did get have the expected shape.
      if (allFiles.length === 0) {
        console.warn(
          `Affinity list "${tableSpec.name}" returned 0 entries — schema/auth still validated, but record-shape assertions skipped.`,
        );
        return;
      }

      const sample = allFiles[0] as {
        id: number;
        type: string;
        listId: number;
        createdAt: string;
        creatorId: number | null;
        entity: { id: number; fields?: Record<string, unknown> };
      };

      expect(typeof sample.id).toBe('number');
      expect(['company', 'person', 'opportunity']).toContain(sample.type);
      expect(typeof sample.listId).toBe('number');
      expect(typeof sample.createdAt).toBe('string');
      expect(sample.entity).toBeDefined();
      expect(typeof sample.entity.id).toBe('number');

      // Most importantly: confirm the array → keyed-object transformation ran.
      // entity.fields must NOT be an array.
      expect(Array.isArray(sample.entity.fields)).toBe(false);
      if (sample.entity.fields) {
        for (const [key, rawValue] of Object.entries(sample.entity.fields)) {
          expect(typeof key).toBe('string');
          const value = rawValue as { id?: unknown; name?: unknown; type?: unknown };
          expect(value.id).toBe(key);
          expect(typeof value.name).toBe('string');
          expect(typeof value.type).toBe('string');
        }
      }
    });

    it('produces a non-empty filename suggestion for at least one record', async () => {
      const tableSpec = await connector.fetchJsonTableSpec(allTables[0].id);

      const sampleFiles: ConnectorFile[] = [];
      try {
        await connector.pullRecordFiles(
          tableSpec,
          // eslint-disable-next-line @typescript-eslint/require-await
          async ({ files }) => {
            sampleFiles.push(...files);
            throw new EarlyExit();
          },
          {},
          { forceFull: false },
        );
      } catch (error) {
        if (!(error instanceof EarlyExit)) throw error;
      }

      if (sampleFiles.length === 0) return; // Empty list — nothing to suggest.

      const names = connector.getSuggestedRecordFileNames(sampleFiles, tableSpec);
      expect(names).toHaveLength(sampleFiles.length);
      // At least one should be a non-empty string (depends on entity having a name).
      expect(names.some((n) => typeof n === 'string' && n.length > 0)).toBe(true);
    });
  });
});

describeIfKey('AffinityApiClient — getQuota (v1 /rate-limit endpoint)', () => {
  // Not exposed on the Connector interface yet — reach into the private client
  // the same way the other low-level tests in this file do. Once `getQuota` is
  // surfaced (e.g. on connection settings UI), this test should switch to
  // calling the public path.
  it('returns both per-minute and monthly quota buckets with sane values', async () => {
    const connector = new AffinityConnector(API_KEY!);
    const apiClient = (connector as unknown as { client: AffinityApiClient }).client;

    const quota = await apiClient.getQuota();

    // Shape: two buckets, each with limit/remaining/used/reset.
    expect(quota.rate).toBeDefined();
    expect(quota.rate.api_key_per_minute).toBeDefined();
    expect(quota.rate.org_monthly).toBeDefined();

    for (const bucket of [quota.rate.api_key_per_minute, quota.rate.org_monthly]) {
      expect(typeof bucket.limit).toBe('number');
      expect(typeof bucket.remaining).toBe('number');
      expect(typeof bucket.used).toBe('number');
      expect(typeof bucket.reset).toBe('number');

      expect(bucket.limit).toBeGreaterThan(0);
      expect(bucket.remaining).toBeGreaterThanOrEqual(0);
      expect(bucket.used).toBeGreaterThanOrEqual(0);
      expect(bucket.reset).toBeGreaterThanOrEqual(0);

      // Internal consistency: used + remaining should equal limit (give or take
      // 1 for the request we just made not yet being fully accounted for).
      expect(Math.abs(bucket.used + bucket.remaining - bucket.limit)).toBeLessThanOrEqual(1);
    }

    // Affinity's documented caps for the standard tier — relax these if you
    // ever upgrade to Enterprise (unlimited org).
    expect(quota.rate.api_key_per_minute.limit).toBe(900);
    expect(quota.rate.org_monthly.limit).toBeGreaterThanOrEqual(100_000);

    console.log(
      [
        '',
        'Affinity quota snapshot (via v1 GET /rate-limit):',
        `  Per-minute (API key): ${quota.rate.api_key_per_minute.used}/${quota.rate.api_key_per_minute.limit} used` +
          ` — ${quota.rate.api_key_per_minute.remaining} remaining, resets in ${quota.rate.api_key_per_minute.reset}s`,
        `  Per-month (org):      ${quota.rate.org_monthly.used}/${quota.rate.org_monthly.limit} used` +
          ` — ${quota.rate.org_monthly.remaining} remaining, resets in ${Math.round(quota.rate.org_monthly.reset / 86400)}d`,
        '',
      ].join('\n'),
    );
  });
});

describeIfKey('AffinityConnector — v1 N+1 vs v2 inline-fields verification', () => {
  // Hard cap: don't pull more than this many pages from any one list, to keep
  // the test cheap and avoid burning quota on huge lists.
  const MAX_PAGES = 5;
  const PAGE_SIZE = 100;

  it('fetches list entries with field data inline (no per-record N+1)', async () => {
    const connector = new AffinityConnector(API_KEY!);

    // Reach into the connector to attach an axios interceptor that counts every
    // outbound HTTP request, bucketed by URL path.
    const apiClient = (connector as unknown as { client: AffinityApiClient }).client;
    const http = (apiClient as unknown as { http: AxiosInstance }).http;

    const requestsByPath = new Map<string, number>();
    const interceptorId = http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      const url = config.url ?? '';
      // Strip the query string and any numeric ids so similar requests bucket together.
      const normalized = url.split('?')[0].replace(/\/\d+/g, '/{id}');
      requestsByPath.set(normalized, (requestsByPath.get(normalized) ?? 0) + 1);
      return config;
    });

    try {
      // Pick the first list that actually has entries — empty lists prove nothing.
      const tables = await connector.listTables();
      let chosenSpec: BaseJsonTableSpec | undefined;
      let chosenName: string | undefined;
      let chosenRecords: ConnectorFile[] = [];

      for (const table of tables) {
        const spec = await connector.fetchJsonTableSpec(table.id);

        // Reset the counter — we want a clean count for the pull only.
        requestsByPath.clear();

        const records: ConnectorFile[] = [];
        let pages = 0;
        try {
          await connector.pullRecordFiles(
            spec,
            // eslint-disable-next-line @typescript-eslint/require-await
            async ({ files }) => {
              records.push(...files);
              pages += 1;
              if (pages >= MAX_PAGES) throw new EarlyExit();
            },
            {},
            { forceFull: false },
          );
        } catch (error) {
          if (!(error instanceof EarlyExit)) throw error;
        }

        if (records.length > 0) {
          chosenSpec = spec;
          chosenName = table.displayName;
          chosenRecords = records;
          break;
        }
      }

      if (!chosenSpec) {
        console.warn('All Affinity lists were empty — N+1 verification skipped.');
        return;
      }

      // ----- Report ---------------------------------------------------------
      const totalRequests = Array.from(requestsByPath.values()).reduce((a, b) => a + b, 0);
      const breakdown = Array.from(requestsByPath.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([path, count]) => `    ${count.toString().padStart(4)}  ${path}`)
        .join('\n');
      const recordsWithFieldData = chosenRecords.filter((r) => {
        const entity = (r as { entity?: { fields?: Record<string, unknown> } }).entity;
        return entity?.fields && Object.keys(entity.fields).length > 0;
      }).length;

      console.log(
        [
          '',
          `Affinity v2 inline-fields verification — list "${chosenName}" (id ${chosenSpec.id.remoteId[0]})`,
          `  Records pulled:           ${chosenRecords.length}`,
          `  Records with field data:  ${recordsWithFieldData}/${chosenRecords.length}`,
          `  Total HTTP requests:      ${totalRequests}`,
          `  v1 equivalent (~N+1):     ${chosenRecords.length + 1}`,
          `  Reduction factor:         ~${(chosenRecords.length + 1 > 0 ? (chosenRecords.length + 1) / Math.max(totalRequests, 1) : 0).toFixed(1)}x`,
          '  Request breakdown:',
          breakdown,
          '',
        ].join('\n'),
      );

      // ----- Assertions -----------------------------------------------------
      // 1. The pull should hit the list-entries endpoint exactly ceil(records / PAGE_SIZE)
      //    times — one request per page, no per-record fetches.
      const listEntriesCalls = requestsByPath.get('/v2/lists/{id}/list-entries') ?? 0;
      const expectedPages = Math.ceil(chosenRecords.length / PAGE_SIZE);
      expect(listEntriesCalls).toBe(expectedPages);

      // 2. Total requests must be no more than (pages + a small constant), NOT proportional
      //    to record count. The v1 N+1 path would be ~N requests; we should be ~N/100.
      expect(totalRequests).toBeLessThanOrEqual(expectedPages + 2);
      expect(totalRequests).toBeLessThan(chosenRecords.length); // sanity: must beat v1 even on tiny lists

      // 3. The field data MUST actually be present inline. If `recordsWithFieldData` is 0,
      //    the connector is silently dropping fields and we'd have a v1-style problem in
      //    disguise. (Note: an empty `fields` is legitimate if the list has zero defined
      //    fields, so we only assert > 0 if the schema has any field columns.)
      const fieldsSchema = (
        chosenSpec.schema as {
          properties: { entity: { properties: { fields?: { properties?: Record<string, unknown> } } } };
        }
      ).properties.entity.properties.fields;
      const fieldColumnCount = Object.keys(fieldsSchema?.properties ?? {}).length;
      if (fieldColumnCount > 0) {
        expect(recordsWithFieldData).toBeGreaterThan(0);
      }
    } finally {
      http.interceptors.request.eject(interceptorId);
    }
  });
});

/** Sentinel error used to bail out of the pull iterator after the first batch. */
class EarlyExit extends Error {
  constructor() {
    super('early-exit');
    this.name = 'EarlyExit';
  }
}
