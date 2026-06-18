/**
 * Affinity connector live API integration test (read-only).
 *
 * Exercises the real Affinity v2 API: validates credentials, discovers
 * tenant-wide tables and user-created lists, builds schemas, pulls records,
 * and verifies the v2 inline-fields optimization.
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

// All workspace-wide (non-user-list) table sentinels — used to separate the
// fixed tenant tables from the user-created lists. Keep in sync with the
// `TENANT_*_ID` constants in affinity-connector.ts.
const TENANT_TABLE_IDS = new Set(['persons', 'companies', 'opportunities', 'notes', 'entity-files', 'users']);

// Stable fixture list (DEV-10130): the list-dependent assertions used to key off
// `listTables[0]`, which is order- and content-dependent and drifts as the workspace
// changes. They now anchor to a dedicated, preserved list whose name carries this
// marker — `[Do Not Touch] People (Scratch Int Test)` (a person-type list seeded with
// a few `[Do Not Touch] … (Scratch Int Test)` persons). See affinity/STATE.md → Test account.
const FIXTURE_LIST_MARKER = '(Scratch Int Test)';

function createConnector(): AffinityConnector {
  return new AffinityConnector(API_KEY!);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** By-id pull → the single person record (or undefined when Affinity reports it absent). */
async function pullPersonById(
  connector: AffinityConnector,
  tableSpec: BaseJsonTableSpec,
  id: number,
): Promise<Record<string, unknown> | undefined> {
  const files: ConnectorFile[] = [];
  await connector.pullRecordFilesByIds(tableSpec, [String(id)], ({ files: batch }) => {
    files.push(...batch);
    return Promise.resolve();
  });
  return files[0] as unknown as Record<string, unknown> | undefined;
}

/**
 * Poll a fresh by-id read until `predicate` holds. Affinity's GET lags a write
 * (read-after-write), so an immediate read right after a PUT/DELETE can still
 * return the stale record — poll until the change lands rather than trusting a
 * single read. Returns the last record seen (undefined when the person is gone).
 */
async function waitForPerson(
  connector: AffinityConnector,
  tableSpec: BaseJsonTableSpec,
  id: number,
  predicate: (person: Record<string, unknown> | undefined) => boolean,
  { tries = 8, delayMs = 2000 } = {},
): Promise<Record<string, unknown> | undefined> {
  let person: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < tries; attempt++) {
    person = await pullPersonById(connector, tableSpec, id);
    if (predicate(person)) return person;
    await sleep(delayMs);
  }
  return person;
}

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('AffinityConnector — live API', () => {
  let connector: AffinityConnector;
  let allTables: TablePreview[];
  let tenantTables: TablePreview[];
  let listTables: TablePreview[];
  let fixtureList: TablePreview;

  beforeAll(async () => {
    connector = createConnector();
    allTables = await connector.listTables();
    tenantTables = allTables.filter((t) => TENANT_TABLE_IDS.has(t.id.remoteId[0]));
    listTables = allTables.filter((t) => !TENANT_TABLE_IDS.has(t.id.remoteId[0]));

    // Anchor the list-dependent assertions to the preserved fixture list (not listTables[0]).
    const found = listTables.find((t) => t.displayName.includes(FIXTURE_LIST_MARKER));
    if (!found) {
      throw new Error(
        `Affinity fixture list not found — expected a list whose name contains "${FIXTURE_LIST_MARKER}" ` +
          `(e.g. "[Do Not Touch] People (Scratch Int Test)"). It must be preserved in the test workspace; ` +
          `see server/src/remote-service/connectors/library/affinity/STATE.md → Test account for how to recreate it.`,
      );
    }
    fixtureList = found;
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
  // Table discovery
  // -------------------------------------------------------------------------

  describe('listTables', () => {
    it('returns all the tenant-wide tables', () => {
      expect(tenantTables).toHaveLength(TENANT_TABLE_IDS.size);
      const ids = new Set(tenantTables.map((t) => t.id.remoteId[0]));
      expect(ids).toEqual(TENANT_TABLE_IDS);
    });

    it('tenant tables have no parentPath', () => {
      for (const table of tenantTables) {
        expect(table.parentPath).toBeUndefined();
      }
    });

    it('returns at least one user-created list', () => {
      expect(listTables.length).toBeGreaterThan(0);
    });

    it('every user list has a numeric remote id and is grouped under Lists/', () => {
      for (const table of listTables) {
        expect(table.id.wsId).toMatch(/^list_\d+$/);
        expect(table.id.remoteId).toHaveLength(1);
        expect(Number.isFinite(parseInt(table.id.remoteId[0], 10))).toBe(true);
        expect(table.parentPath).toBe('Lists');

        const meta = table.metadata as { listType: string; listId: number; isPublic: boolean } | undefined;
        expect(meta).toBeDefined();
        expect(['company', 'person', 'opportunity']).toContain(meta!.listType);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Schema discovery — user list
  // -------------------------------------------------------------------------

  describe('fetchJsonTableSpec (user list)', () => {
    let listSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      listSpec = await connector.fetchJsonTableSpec(fixtureList.id);
    });

    it('builds a spec with list-entry top-level fields', () => {
      expect(listSpec.id).toEqual(fixtureList.id);
      expect(listSpec.name).toBe(fixtureList.displayName);
      expect(listSpec.idColumnRemoteId).toBe('id');

      const props = (listSpec.schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('type');
      expect(props).toHaveProperty('listId');
      expect(props).toHaveProperty('createdAt');
      expect(props).toHaveProperty('creatorId');
      expect(props).toHaveProperty('entity');
    });

    it('points titleColumnRemoteId at a real entity field', () => {
      const path = listSpec.titleColumnRemoteId;
      expect(path?.[0]).toBe('entity');
      expect(['name', 'firstName']).toContain(path?.[1]);
    });

    it('mounts list-specific fields under entity.fields keyed by remote id', () => {
      const entitySchema = (
        listSpec.schema as unknown as { properties: { entity: { properties: Record<string, unknown> } } }
      ).properties.entity;
      expect(entitySchema.properties).toHaveProperty('fields');

      const fieldsSchema = entitySchema.properties.fields as { properties?: Record<string, unknown>; type: string };
      expect(fieldsSchema.type).toBe('object');
      expect(fieldsSchema.properties).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Schema discovery — tenant tables
  // -------------------------------------------------------------------------

  describe('fetchJsonTableSpec (tenant tables)', () => {
    it('builds a spec for Companies', async () => {
      const table = tenantTables.find((t) => t.id.remoteId[0] === 'companies')!;
      const spec = await connector.fetchJsonTableSpec(table.id);

      expect(spec.name).toBe('Companies');
      expect(spec.idColumnRemoteId).toBe('id');

      const props = (spec.schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('name');
    });

    it('builds a spec for People', async () => {
      const table = tenantTables.find((t) => t.id.remoteId[0] === 'persons')!;
      const spec = await connector.fetchJsonTableSpec(table.id);

      expect(spec.name).toBe('People');
      expect(spec.idColumnRemoteId).toBe('id');

      const props = (spec.schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('firstName');
      expect(props).toHaveProperty('lastName');
    });

    it('builds a spec for Opportunities', async () => {
      const table = tenantTables.find((t) => t.id.remoteId[0] === 'opportunities')!;
      const spec = await connector.fetchJsonTableSpec(table.id);

      expect(spec.name).toBe('Opportunities');
      expect(spec.idColumnRemoteId).toBe('id');

      const props = (spec.schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('name');
    });
  });

  // -------------------------------------------------------------------------
  // Record pull — user list (one page only to keep it cheap)
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (user list)', () => {
    it('streams the first page of list entries with field data inline', async () => {
      const tableSpec = await connector.fetchJsonTableSpec(fixtureList.id);

      const allFiles: ConnectorFile[] = [];
      let callbacks = 0;

      try {
        await connector.pullRecordFiles(
          tableSpec,
          // eslint-disable-next-line @typescript-eslint/require-await
          async ({ files }) => {
            callbacks += 1;
            allFiles.push(...files);
            throw new EarlyExit();
          },
          {},
          { forceFull: false },
        );
      } catch (error) {
        if (!(error instanceof EarlyExit)) throw error;
      }

      expect(callbacks).toBe(1);

      if (allFiles.length === 0) {
        console.warn(
          `Affinity list "${tableSpec.name}" returned 0 entries — schema/auth validated, record-shape assertions skipped.`,
        );
        return;
      }

      const sample = allFiles[0] as {
        id: number;
        type: string;
        listId: number;
        createdAt: string;
        entity: { id: number; fields?: Record<string, unknown> };
      };

      expect(typeof sample.id).toBe('number');
      expect(['company', 'person', 'opportunity']).toContain(sample.type);
      expect(typeof sample.listId).toBe('number');
      expect(typeof sample.createdAt).toBe('string');
      expect(sample.entity).toBeDefined();
      expect(typeof sample.entity.id).toBe('number');

      // Confirm the array → keyed-object transformation ran.
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
      const tableSpec = await connector.fetchJsonTableSpec(fixtureList.id);

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

      if (sampleFiles.length === 0) return;

      const names = connector.getSuggestedRecordFileNames(sampleFiles, tableSpec);
      expect(names).toHaveLength(sampleFiles.length);
      expect(names.some((n) => typeof n === 'string' && n.length > 0)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // API Quota
  // -------------------------------------------------------------------------

  describe('getApiQuota', () => {
    it('returns quota data with per-minute and monthly buckets', async () => {
      const result = await connector.getApiQuota();

      expect(result).toHaveProperty('quota');
      const quota = (result as { quota: { rate: Record<string, unknown> } }).quota;
      expect(quota.rate).toBeDefined();

      const rate = quota.rate as {
        api_key_per_minute: { limit: number; remaining: number; used: number; reset: number };
        org_monthly: { limit: number; remaining: number; used: number; reset: number };
      };

      for (const bucket of [rate.api_key_per_minute, rate.org_monthly]) {
        expect(bucket.limit).toBeGreaterThan(0);
        expect(bucket.remaining).toBeGreaterThanOrEqual(0);
        expect(bucket.used).toBeGreaterThanOrEqual(0);
        expect(Math.abs(bucket.used + bucket.remaining - bucket.limit)).toBeLessThanOrEqual(1);
      }

      console.log(
        [
          '',
          'Affinity quota snapshot:',
          `  Per-minute: ${rate.api_key_per_minute.used}/${rate.api_key_per_minute.limit} used` +
            ` — ${rate.api_key_per_minute.remaining} remaining`,
          `  Monthly:    ${rate.org_monthly.used}/${rate.org_monthly.limit} used` +
            ` — ${rate.org_monthly.remaining} remaining, resets in ${Math.round(rate.org_monthly.reset / 86400)}d`,
          '',
        ].join('\n'),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// v2 inline-fields verification (separate describe — heavier test)
// ---------------------------------------------------------------------------

describeIfKey('AffinityConnector — v2 inline-fields verification', () => {
  const MAX_PAGES = 5;
  const PAGE_SIZE = 100;

  it('fetches list entries with field data inline (no per-record N+1)', async () => {
    const connector = new AffinityConnector(API_KEY!);

    const apiClient = (connector as unknown as { client: AffinityApiClient }).client;
    const http = (apiClient as unknown as { http: AxiosInstance }).http;

    const requestsByPath = new Map<string, number>();
    const interceptorId = http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      const url = config.url ?? '';
      const normalized = url.split('?')[0].replace(/\/\d+/g, '/{id}');
      requestsByPath.set(normalized, (requestsByPath.get(normalized) ?? 0) + 1);
      return config;
    });

    try {
      // Pick the first user list that has entries — skip tenant tables.
      const allTables = await connector.listTables();
      const userLists = allTables.filter((t) => !TENANT_TABLE_IDS.has(t.id.remoteId[0]));
      // Prefer the stable fixture list (deterministic + always seeded with entries) so the
      // N+1 verification doesn't depend on whichever other workspace list happens to have data.
      userLists.sort(
        (a, b) =>
          Number(b.displayName.includes(FIXTURE_LIST_MARKER)) - Number(a.displayName.includes(FIXTURE_LIST_MARKER)),
      );

      let chosenSpec: BaseJsonTableSpec | undefined;
      let chosenName: string | undefined;
      let chosenRecords: ConnectorFile[] = [];

      for (const table of userLists) {
        const spec = await connector.fetchJsonTableSpec(table.id);
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

      const listEntriesCalls = requestsByPath.get('/v2/lists/{id}/list-entries') ?? 0;
      const expectedPages = Math.ceil(chosenRecords.length / PAGE_SIZE);
      expect(listEntriesCalls).toBe(expectedPages);
      expect(totalRequests).toBeLessThanOrEqual(expectedPages + 2);
      expect(totalRequests).toBeLessThan(chosenRecords.length);

      const fieldsSchema = (
        chosenSpec.schema as unknown as {
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

// ---------------------------------------------------------------------------
// P2 — v1 write round-trip (DEV-10298): create → basics update → delete.
//
// Drives the real connector code (createRecords / updateRecords / deleteRecords)
// against the live Affinity API — the end-to-end proof that doesn't depend on
// the Scratch CLI publish path (GCS). Uses a throwaway person and deletes it in
// a finally block so it never litters the org.
// ---------------------------------------------------------------------------

describeIfKey('AffinityConnector — v1 write round-trip (P2)', () => {
  it('creates, updates basics, and deletes a person through the connector', async () => {
    const connector = createConnector();
    const personsTable = (await connector.listTables()).find((t) => t.id.remoteId[0] === 'persons');
    if (!personsTable) throw new Error('persons table not found');
    const tableSpec = await connector.fetchJsonTableSpec(personsTable.id);

    const newPersonFile = {
      firstName: 'ZZZ-Integration',
      lastName: 'DeleteMe',
      primaryEmailAddress: 'zzz-integration-deleteme@example.com',
      emailAddresses: ['zzz-integration-deleteme@example.com'],
      type: 'external',
      fields: {},
    } as unknown as ConnectorFile;

    let createdId: number | undefined;
    try {
      // CREATE
      const [created] = await connector.createRecords(tableSpec, [newPersonFile]);
      createdId = (created as unknown as { id: number }).id;
      if (typeof createdId !== 'number') {
        throw new Error(`createRecords returned no numeric id (got ${String(createdId)})`);
      }
      const personId = createdId;
      expect((created as unknown as { firstName: string }).firstName).toBe('ZZZ-Integration');

      // UPDATE basics (firstName → v1 PUT)
      const fileWithId = { ...newPersonFile, id: createdId, firstName: 'ZZZ-Integration-Renamed' } as ConnectorFile;
      await connector.updateRecords(tableSpec, [fileWithId], [{ firstName: 'ZZZ-Integration-Renamed' }]);
      // Affinity's GET lags the PUT (read-after-write), so updateRecords' immediate
      // re-fetch can hand back the stale name. Poll a fresh by-id read until the
      // rename lands rather than asserting on that one (possibly stale) response.
      const renamedPerson = await waitForPerson(
        connector,
        tableSpec,
        personId,
        (person) => person?.firstName === 'ZZZ-Integration-Renamed',
      );
      expect(renamedPerson?.firstName).toBe('ZZZ-Integration-Renamed');

      // DELETE
      await connector.deleteRecords(tableSpec, [fileWithId]);
      createdId = undefined; // deleted; skip the finally cleanup

      // Verify gone: poll a by-id read until it yields nothing (Affinity's GET can
      // briefly still return a just-deleted record — read-after-write lag again).
      const deletedPerson = await waitForPerson(connector, tableSpec, personId, (person) => person === undefined);
      expect(deletedPerson).toBeUndefined();
    } finally {
      if (createdId !== undefined) {
        // Best-effort cleanup if an assertion failed before the delete.
        await connector
          .deleteRecords(tableSpec, [{ id: createdId } as unknown as ConnectorFile])
          .catch(() => undefined);
      }
    }
  });
});
