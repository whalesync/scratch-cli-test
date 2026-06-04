/**
 * Pipedrive connector live API integration test.
 *
 * Exercises the real Pipedrive v2 API: validates credentials, lists the three
 * entity types as tables, builds a schema for each, pulls records (full +
 * incremental), and runs a create→update→delete round-trip (cleaning up after
 * itself).
 *
 * Requires PIPEDRIVE_API_KEY in .env.integration. Any Pipedrive account works —
 * a free trial with the default sample data is enough; the suite creates and
 * deletes its own `persons` records and never depends on pre-seeded content.
 *
 * Run via: cd server && yarn test:integration -- pipedrive-connector
 */

import { IncrementalPullSupport } from '@spinner/shared-types';

// Break the circular import chain: connector.ts → display-names.ts → all
// connectors → connector.ts (same shim the Airtable/Notion live tests use).
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { PipedriveConnector } from 'src/remote-service/connectors/library/pipedrive/pipedrive-connector';
import { ENTITY_DISPLAY_NAMES, ENTITY_TYPES } from 'src/remote-service/connectors/library/pipedrive/pipedrive-types';
import {
  BaseJsonTableSpec,
  ConnectorFile,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from 'src/remote-service/connectors/types';

jest.setTimeout(120_000);

const API_KEY = process.env.PIPEDRIVE_API_KEY;

/**
 * The entity type the pull + CRUD suites operate on. `persons` is the safest
 * choice: its only required create field is `name`, and the suite always
 * creates and deletes its own records rather than touching existing data.
 */
const PRIMARY_ENTITY_TYPE = 'persons';

const ROUND_TRIP_NAME_PREFIX = 'Scratch integration test';

function createConnector(): PipedriveConnector {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return new PipedriveConnector(API_KEY!);
}

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

// ===========================================================================
// Read-only smoke + pull
// ===========================================================================

describeIfKey('PipedriveConnector — live API', () => {
  let connector: PipedriveConnector;
  let allTables: TablePreview[];
  let primaryTable: TablePreview;
  let primarySpec: BaseJsonTableSpec;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    connector = createConnector();
    allTables = await connector.listTables();
    const found = allTables.find((t) => t.id.wsId === PRIMARY_ENTITY_TYPE);
    if (!found) {
      throw new Error(`Expected a "${PRIMARY_ENTITY_TYPE}" table in listTables() — got ${allTables.length} tables.`);
    }
    primaryTable = found;
    primarySpec = await connector.fetchJsonTableSpec(primaryTable.id);
  });

  afterAll(async () => {
    // Best-effort cleanup; swallow individual failures so one bad delete
    // doesn't block the others. Leftovers are findable by ROUND_TRIP_NAME_PREFIX.
    await Promise.allSettled(cleanups.map((fn) => fn()));
  });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects an obviously invalid key', async () => {
      const badConnector = new PipedriveConnector('not-a-real-pipedrive-token');
      await expect(badConnector.testConnection()).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Table discovery
  // -------------------------------------------------------------------------

  describe('listTables', () => {
    it('returns exactly the three Pipedrive entity types', () => {
      const wsIds = allTables.map((t) => t.id.wsId).sort();
      expect(wsIds).toEqual([...ENTITY_TYPES].sort());
    });

    it('every table has a single-element remoteId matching its wsId and a display name', () => {
      for (const table of allTables) {
        expect(table.id.remoteId).toHaveLength(1);
        expect(table.id.remoteId[0]).toBe(table.id.wsId);
        expect(table.displayName).toBe(ENTITY_DISPLAY_NAMES[table.id.wsId as keyof typeof ENTITY_DISPLAY_NAMES]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Schema discovery
  // -------------------------------------------------------------------------

  describe('fetchJsonTableSpec', () => {
    it('builds a spec with the expected top-level structure for the primary table', () => {
      expect(primarySpec.id).toEqual(primaryTable.id);
      expect(primarySpec.name).toBe(ENTITY_DISPLAY_NAMES[PRIMARY_ENTITY_TYPE]);
      expect(primarySpec.idColumnRemoteId).toBe('id');
      expect(primarySpec.titleColumnRemoteId).toEqual(['name']);
      expect(primarySpec.schema).toBeDefined();

      const props = schemaProperties(primarySpec);
      // The Fields API always surfaces these system fields on a person.
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('update_time');
    });

    it('annotates `update_time` as the last-modified field used for incremental pulls', () => {
      const props = schemaProperties(primarySpec);
      const updateTime = props.update_time as Record<string, unknown>;
      expect(updateTime['x-scratch-last-modified-field']).toBe(true);
      expect(updateTime['x-scratch-readonly']).toBe(true);
    });

    it('builds a non-empty schema for every entity type', async () => {
      for (const entityType of ENTITY_TYPES) {
        const table = allTables.find((t) => t.id.wsId === entityType);
        if (!table) throw new Error(`Missing table for ${entityType}`);
        const spec = await connector.fetchJsonTableSpec(table.id);
        const props = schemaProperties(spec);
        expect(Object.keys(props).length).toBeGreaterThan(0);
        expect(props).toHaveProperty('id');
      }
    });

    it('throws for an unknown entity type', async () => {
      const badId = { wsId: 'not_an_entity', remoteId: ['not_an_entity'] };
      await expect(connector.fetchJsonTableSpec(badId)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Pull — full
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (full)', () => {
    it('streams every person, each carrying a numeric id', async () => {
      // Guarantee at least one record so the assertions below have something to
      // bite on, regardless of how empty the test account is.
      await createPerson(connector, primarySpec, `${ROUND_TRIP_NAME_PREFIX} full-pull ${Date.now()}`, cleanups);

      const { files } = await pullAll(connector, primarySpec, {});

      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(typeof file.id).toBe('number');
        expect(file).toHaveProperty('name');
      }

      console.log(`\nPipedrive full pull: ${files.length} ${PRIMARY_ENTITY_TYPE}\n`);
    });
  });

  // -------------------------------------------------------------------------
  // Pull — incremental
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (incremental)', () => {
    it('honors `since`: a freshly-created person is returned and a new watermark is issued', async () => {
      // Watermark a minute before the create. The created record's server-side
      // `update_time` will be at or after this, so the inclusive `updated_since`
      // filter (minus the connector's clock-skew margin) must include it. The
      // extra minute also absorbs the case where Pipedrive's server clock trails
      // ours, which would otherwise stamp `update_time` before `before`.
      const before = new Date(Date.now() - 60_000);
      const created = await createPerson(
        connector,
        primarySpec,
        `${ROUND_TRIP_NAME_PREFIX} incremental ${Date.now()}`,
        cleanups,
      );
      const createdId = created.id as number;

      // Pipedrive's `updated_since`-filtered list is eventually consistent: a
      // just-written record can take a few seconds to surface in the filter
      // index. Poll until it appears rather than asserting on the first pull.
      const { files, result } = await pollUntil(
        () => pullAll(connector, primarySpec, { pullMode: 'incremental', since: before }),
        ({ files: f }) => f.some((record) => record.id === createdId),
        { tries: 12, intervalMs: 3000 },
      );

      const ids = new Set(files.map((f) => f.id as number));
      expect(ids.has(createdId)).toBe(true);
      // A real incremental pull returns a fresh watermark for the job to persist.
      expect(result.newWatermark).toBeInstanceOf(Date);

      console.log(
        `\nPipedrive incremental: ${files.length} ${PRIMARY_ENTITY_TYPE} changed since ${before.toISOString()}\n`,
      );
    });

    it('excludes records when `since` is in the future', async () => {
      const created = await createPerson(
        connector,
        primarySpec,
        `${ROUND_TRIP_NAME_PREFIX} incremental-future ${Date.now()}`,
        cleanups,
      );
      const createdId = created.id as number;

      // One hour ahead — comfortably past the 60s clock-skew margin the
      // connector subtracts, so nothing edited "now" qualifies.
      const future = new Date(Date.now() + 60 * 60_000);
      const { files } = await pullAll(connector, primarySpec, {
        pullMode: 'incremental',
        since: future,
      });

      const ids = new Set(files.map((f) => f.id as number));
      expect(ids.has(createdId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Connector properties
  // -------------------------------------------------------------------------

  describe('connector properties', () => {
    it('getBatchSize returns 1 (no bulk API)', () => {
      expect(connector.getBatchSize()).toBe(1);
    });

    it('incrementalPullSupport returns SUPPORTED', () => {
      expect(connector.incrementalPullSupport()).toBe(IncrementalPullSupport.SUPPORTED);
    });
  });
});

// ===========================================================================
// CRUD round-trip
// ===========================================================================

describeIfKey('PipedriveConnector — CRUD round-trip', () => {
  let connector: PipedriveConnector;
  let tableSpec: BaseJsonTableSpec;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    connector = createConnector();
    const tables = await connector.listTables();
    const found = tables.find((t) => t.id.wsId === PRIMARY_ENTITY_TYPE);
    if (!found) throw new Error(`Expected a "${PRIMARY_ENTITY_TYPE}" table.`);
    tableSpec = await connector.fetchJsonTableSpec(found.id);
  });

  afterAll(async () => {
    await Promise.allSettled(cleanups.map((fn) => fn()));
  });

  it('creates a person, updates a writable field, then deletes it', async () => {
    const initialName = `${ROUND_TRIP_NAME_PREFIX} ${Date.now()}`;
    const updatedName = `${initialName} (updated)`;

    // ── Create ──
    const created = await connector.createRecords(tableSpec, [{ name: initialName } as ConnectorFile]);
    expect(created).toHaveLength(1);
    const createdRecord = created[0] as Record<string, unknown>;
    const recordId = createdRecord.id as number;
    expect(typeof recordId).toBe('number');
    expect(createdRecord.name).toBe(initialName);
    cleanups.push(async () => {
      await connector.deleteRecords(tableSpec, [{ id: recordId } as unknown as ConnectorFile]);
    });

    // Verify create via pullRecordFilesByIds (which fetches each entity by id).
    const afterCreate = await fetchById(connector, tableSpec, String(recordId));
    expect(afterCreate).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(afterCreate!.name).toBe(initialName);

    // ── Update — name (a writable system field) via changedFields ──
    await connector.updateRecords(tableSpec, [{ id: recordId } as unknown as ConnectorFile], [{ name: updatedName }]);

    const afterUpdate = await fetchById(connector, tableSpec, String(recordId));
    expect(afterUpdate).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(afterUpdate!.name).toBe(updatedName);

    // ── Delete (soft) ──
    await connector.deleteRecords(tableSpec, [{ id: recordId } as unknown as ConnectorFile]);

    // Pipedrive deletes are soft: the entity is still fetchable by id but comes
    // back flagged `is_deleted: true` (it 404s only after Pipedrive's async
    // purge, hours later). So verify the flag rather than expecting null.
    const afterDelete = await fetchById(connector, tableSpec, String(recordId));
    expect(afterDelete).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(afterDelete!.is_deleted).toBe(true);
  });
});

// ===========================================================================
// Helpers
// ===========================================================================

/** Pull the top-level `properties` bag out of a spec's JSON schema. */
function schemaProperties(spec: BaseJsonTableSpec): Record<string, unknown> {
  return (spec.schema as unknown as { properties: Record<string, unknown> }).properties;
}

/**
 * Re-run `fn` until `predicate` holds or the attempt budget is exhausted, with a
 * fixed delay between tries. Returns the last result regardless, so callers can
 * make a normal assertion that produces a clear diff when the condition never
 * became true. Used to ride out Pipedrive's eventually-consistent filter index.
 */
async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { tries, intervalMs }: { tries: number; intervalMs: number },
): Promise<T> {
  let last = await fn();
  for (let attempt = 1; attempt < tries; attempt++) {
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await fn();
  }
  return last;
}

/**
 * Drive `pullRecordFiles` to exhaustion and return everything in a flat array
 * alongside the result envelope (newWatermark / newCursor).
 */
async function pullAll(
  connector: PipedriveConnector,
  spec: BaseJsonTableSpec,
  options: Partial<PullRecordFilesOptions>,
): Promise<{ files: Array<Record<string, unknown>>; result: PullRecordFilesResult }> {
  const files: Array<Record<string, unknown>> = [];
  const result = await connector.pullRecordFiles(
    spec,
    async ({ files: batch }) => {
      files.push(...(batch as unknown as Array<Record<string, unknown>>));
      return Promise.resolve();
    },
    {},
    options as PullRecordFilesOptions,
  );
  return { files, result };
}

/**
 * Look up a single entity by ID via `pullRecordFilesByIds`. Returns `null` when
 * the connector yields nothing (it skips records that 404).
 */
async function fetchById(
  connector: PipedriveConnector,
  spec: BaseJsonTableSpec,
  id: string,
): Promise<Record<string, unknown> | null> {
  const got: ConnectorFile[] = [];
  await connector.pullRecordFilesByIds(spec, [id], async ({ files }) => {
    got.push(...files);
    return Promise.resolve();
  });
  return (got[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * Create a person and register its deletion on the given cleanups list. Returns
 * the created record (carrying the server-assigned numeric `id`).
 */
async function createPerson(
  connector: PipedriveConnector,
  spec: BaseJsonTableSpec,
  name: string,
  cleanups: Array<() => Promise<void>>,
): Promise<Record<string, unknown>> {
  const [created] = await connector.createRecords(spec, [{ name } as ConnectorFile]);
  const record = created as Record<string, unknown>;
  const id = record.id as number;
  cleanups.push(async () => {
    await connector.deleteRecords(spec, [{ id } as unknown as ConnectorFile]);
  });
  return record;
}
