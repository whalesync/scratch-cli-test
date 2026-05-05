/**
 * Attio connector live API integration test.
 *
 * Two suites:
 *
 *   1. Read-only smoke: validates credentials, discovers the three standard
 *      objects + user-created lists, builds schemas, and pulls a single page
 *      of records/entries to confirm response shapes match our types.
 *   2. CRUD round-trips: creates / reads / updates / deletes one record per
 *      standard object and one list entry, with each test record loaded with
 *      one value of every relevant field type — so field-type coverage falls
 *      out of the same 4-tests-per-object matrix instead of multiplying.
 *
 * Requires ATTIO_API_KEY in .env.integration and the workspace must be
 * bootstrapped via `npx ts-node scripts/bootstrap-attio-test-data.ts` (which
 * provisions the `spinner_test_<type>_field` custom attrs on every object).
 *
 * Run via: cd server && yarn test:integration -- attio-connector
 */

// Break the circular import chain that pulls in display-names → registry → DB.
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import axios from 'axios';
import { randomUUID } from 'crypto';
import { AttioConnector } from 'src/remote-service/connectors/library/attio/attio-connector';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';
import { buildTestValues, expectValuesRoundTrip } from './attio-roundtrip-helpers';

/** Generate a short suffix unique to the current test, used to dodge uniqueness
 * constraints on `domains` (companies) and `email_addresses` (people). */
function freshSuffix(): string {
  return randomUUID().slice(0, 8);
}

jest.setTimeout(60_000);

const API_KEY = process.env.ATTIO_API_KEY;

const STANDARD_OBJECT_SLUGS = new Set(['companies', 'people', 'deals']);

function createConnector(): AttioConnector {
  return new AttioConnector(API_KEY!);
}

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('AttioConnector — live API', () => {
  let connector: AttioConnector;
  let allTables: TablePreview[];
  let objectTables: TablePreview[];
  let listTables: TablePreview[];

  beforeAll(async () => {
    connector = createConnector();
    allTables = await connector.listTables();
    objectTables = allTables.filter((t) => STANDARD_OBJECT_SLUGS.has(t.id.remoteId[0]));
    listTables = allTables.filter((t) => t.id.remoteId[0] === 'list');
  });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects an obviously invalid token', async () => {
      const badConnector = new AttioConnector('not-a-real-attio-token');
      await expect(badConnector.testConnection()).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Table discovery
  // -------------------------------------------------------------------------

  describe('listTables', () => {
    it('returns the three standard-object tables (companies, people, deals)', () => {
      expect(objectTables).toHaveLength(3);
      const slugs = new Set(objectTables.map((t) => t.id.remoteId[0]));
      expect(slugs).toEqual(STANDARD_OBJECT_SLUGS);
    });

    it('standard-object tables have no parentPath', () => {
      for (const table of objectTables) {
        expect(table.parentPath).toBeUndefined();
      }
    });

    it('every list table is grouped under Lists/ with a parent on a standard object', () => {
      for (const table of listTables) {
        expect(table.id.remoteId[0]).toBe('list');
        expect(table.id.remoteId[1]).toBeTruthy();
        expect(table.parentPath).toBe('Lists');

        const meta = table.metadata as { listSlug?: string; parentObjectSlug?: string } | undefined;
        expect(meta?.listSlug).toBe(table.id.remoteId[1]);
        expect(meta?.parentObjectSlug).toBeDefined();
        expect(STANDARD_OBJECT_SLUGS.has(meta!.parentObjectSlug!)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Schema discovery — standard objects
  // -------------------------------------------------------------------------

  describe('fetchJsonTableSpec (standard objects)', () => {
    it.each(['companies', 'people', 'deals'] as const)('builds a spec for %s', async (slug) => {
      const table = objectTables.find((t) => t.id.remoteId[0] === slug)!;
      const spec = await connector.fetchJsonTableSpec(table.id);

      expect(spec.idColumnRemoteId).toBe('id');
      expect(spec.titleColumnRemoteId).toEqual(['values', 'name']);

      const props = (spec.schema as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('created_at');
      expect(props).toHaveProperty('values');

      // The `values` schema should at minimum carry a `name` attribute for
      // every standard object — that's the api_slug for the personal-name /
      // text title field on each.
      const valuesProps = (props.values as { properties: Record<string, unknown> }).properties;
      expect(valuesProps).toHaveProperty('name');
    });
  });

  // -------------------------------------------------------------------------
  // Schema discovery — list (skipped if the workspace has no lists)
  // -------------------------------------------------------------------------

  describe('fetchJsonTableSpec (list)', () => {
    it('builds a thin spec with entry_values (no embedded parent_record)', async () => {
      if (listTables.length === 0) {
        console.warn('Attio workspace has no lists — list-spec assertions skipped.');
        return;
      }

      const spec = await connector.fetchJsonTableSpec(listTables[0].id);
      expect(spec.idColumnRemoteId).toBe('id');
      expect(spec.titleColumnRemoteId).toEqual(['parent_record_id']);

      const props = (spec.schema as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('parent_record_id');
      expect(props).toHaveProperty('parent_object');
      expect(props).toHaveProperty('created_at');
      expect(props).toHaveProperty('entry_values');

      // We deliberately do NOT embed the parent record — confirm it's absent.
      expect(props).not.toHaveProperty('parent_record');
    });
  });

  // -------------------------------------------------------------------------
  // Record pull — first page only on companies (cheap signal that pagination
  // and record-shape match our types).
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (companies)', () => {
    it('streams the first page and records carry an id triple + values map', async () => {
      const table = objectTables.find((t) => t.id.remoteId[0] === 'companies')!;
      const tableSpec = await connector.fetchJsonTableSpec(table.id);

      const allFiles = await pullFirstPage(connector, tableSpec);

      if (allFiles.length === 0) {
        console.warn('Attio workspace has no companies — record-shape assertions skipped.');
        return;
      }

      const sample = allFiles[0] as {
        id: { workspace_id: string; object_id: string; record_id: string };
        values: Record<string, unknown[]>;
        created_at: string;
      };

      expect(typeof sample.id).toBe('object');
      expect(typeof sample.id.workspace_id).toBe('string');
      expect(typeof sample.id.object_id).toBe('string');
      expect(typeof sample.id.record_id).toBe('string');
      expect(typeof sample.values).toBe('object');
      expect(typeof sample.created_at).toBe('string');

      // Every value in the bag should be an array (Attio's multi-value model).
      for (const [slug, value] of Object.entries(sample.values)) {
        expect(typeof slug).toBe('string');
        expect(Array.isArray(value)).toBe(true);
      }
    });

    it('produces a non-empty filename suggestion for at least one record', async () => {
      const table = objectTables.find((t) => t.id.remoteId[0] === 'companies')!;
      const tableSpec = await connector.fetchJsonTableSpec(table.id);
      const sampleFiles = await pullFirstPage(connector, tableSpec);

      if (sampleFiles.length === 0) return;

      const names = connector.getSuggestedRecordFileNames(sampleFiles, tableSpec);
      expect(names).toHaveLength(sampleFiles.length);
      expect(names.some((n) => typeof n === 'string' && n.length > 0)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Record pull — first page on a list (skipped if no lists with entries).
  // -------------------------------------------------------------------------

  describe('pullRecordFiles (list)', () => {
    it('streams entries that point at a parent record without embedding it', async () => {
      if (listTables.length === 0) {
        console.warn('Attio workspace has no lists — list-pull assertions skipped.');
        return;
      }

      const tableSpec = await connector.fetchJsonTableSpec(listTables[0].id);
      const allFiles = await pullFirstPage(connector, tableSpec);

      if (allFiles.length === 0) {
        console.warn(`Attio list "${tableSpec.name}" is empty — entry-shape assertions skipped.`);
        return;
      }

      const sample = allFiles[0] as {
        id: { workspace_id: string; list_id: string; entry_id: string };
        parent_record_id: string;
        parent_object: string;
        entry_values: Record<string, unknown[]>;
        parent_record?: unknown;
      };

      expect(typeof sample.id.entry_id).toBe('string');
      expect(typeof sample.parent_record_id).toBe('string');
      expect(typeof sample.parent_object).toBe('string');
      expect(typeof sample.entry_values).toBe('object');
      // Confirm we are NOT expanding the parent record.
      expect(sample.parent_record).toBeUndefined();
    });
  });
});

// ===========================================================================
// CRUD round-trips — the regression net for write-shape bugs.
//
// One test per (object, action). Each created record carries one value of
// every relevant field type, so write-shape correctness for all types is
// covered by the same 12 tests (3 objects × 4 actions) plus 4 list-entry
// tests, instead of multiplying out to 100+ (objects × actions × types).
//
// Every created record is named with a `Spinner Roundtrip ` prefix and gets
// queued for `afterAll` cleanup, so leftovers from failed runs are easy to
// find and bulk-delete in the Attio UI.
// ===========================================================================

describeIfKey('AttioConnector — CRUD round-trips', () => {
  let connector: AttioConnector;
  let ownerMemberId: string;
  const tableSpecsByObject = new Map<string, BaseJsonTableSpec>();
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    connector = createConnector();
    // /v2/self gives us the workspace member id we need for `actor-reference`
    // writes (deals.owner is required and must be an actor reference).
    const selfResponse = await axios.get<{ authorized_by_workspace_member_id: string | null }>(
      'https://api.attio.com/v2/self',
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    const memberId = selfResponse.data.authorized_by_workspace_member_id;
    if (!memberId) throw new Error('Token has no associated workspace member — cannot satisfy `owner` on deals');
    ownerMemberId = memberId;

    // Pre-fetch table specs once for all the per-object tests.
    const tables = await connector.listTables();
    for (const slug of ['companies', 'people', 'deals'] as const) {
      const t = tables.find((p) => p.id.remoteId[0] === slug);
      expect(t).toBeDefined();
      tableSpecsByObject.set(slug, await connector.fetchJsonTableSpec(t!.id));
    }
  });

  afterAll(async () => {
    // Best-effort cleanup; swallow any errors so a failure on one record
    // doesn't block the others. Anything that survives a failed run is
    // findable in the Attio UI by the `Spinner Roundtrip` prefix.
    await Promise.allSettled(cleanups.map((fn) => fn()));
  });

  // -------------------------------------------------------------------------
  // Object × CRUD — one describe per standard object, four tests inside.
  // -------------------------------------------------------------------------

  describe.each(['companies', 'people', 'deals'] as const)('object: %s', (objectSlug) => {
    let tableSpec: BaseJsonTableSpec;

    beforeAll(() => {
      tableSpec = tableSpecsByObject.get(objectSlug)!;
    });

    function queueCleanup(record: ConnectorFile): void {
      cleanups.push(async () => {
        await connector.deleteRecords(tableSpec, [record]);
      });
    }

    it('create — every written field type round-trips through read', async () => {
      const written = buildTestValues(objectSlug, 'a', { ownerMemberId, uniqueSuffix: freshSuffix() });
      const [created] = await connector.createRecords(tableSpec, [{ values: written }]);
      queueCleanup(created);

      // The create response *is* the read shape — assert directly.
      const readValues = (created as { values: Record<string, unknown[]> }).values;
      expectValuesRoundTrip(written, readValues);
    });

    it('read — pullRecordFilesByIds returns the just-created record with the same shape', async () => {
      const written = buildTestValues(objectSlug, 'a', { ownerMemberId, uniqueSuffix: freshSuffix() });
      const [created] = await connector.createRecords(tableSpec, [{ values: written }]);
      queueCleanup(created);
      const recordId = (created as { id: { record_id: string } }).id.record_id;

      const reread: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(tableSpec, [recordId], async ({ files }) => {
        reread.push(...files);
        return Promise.resolve();
      });

      expect(reread).toHaveLength(1);
      expectValuesRoundTrip(written, (reread[0] as { values: Record<string, unknown[]> }).values);
    });

    it('update — sparse changedFields applies only to the changed field, others preserved', async () => {
      const initial = buildTestValues(objectSlug, 'a', { ownerMemberId, uniqueSuffix: freshSuffix() });
      const [created] = await connector.createRecords(tableSpec, [{ values: initial }]);
      queueCleanup(created);

      // Sparse partial: change just `spinner_test_text_field`. Pass the full
      // alternate values too, so the connector can fall back to it if needed
      // (it shouldn't — `changedFields` should win).
      const alternate = buildTestValues(objectSlug, 'b', { ownerMemberId, uniqueSuffix: freshSuffix() });
      const sparseChange = { values: { spinner_test_text_field: alternate.spinner_test_text_field } };
      const fullAlternate = { ...created, values: alternate };
      await connector.updateRecords(tableSpec, [fullAlternate], [sparseChange]);

      // Re-read: the changed field should be the new value; everything else
      // should still be the *initial* (variant 'a') value, proving the partial
      // update didn't accidentally overwrite unrelated fields.
      const recordId = (created as { id: { record_id: string } }).id.record_id;
      const reread: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(tableSpec, [recordId], async ({ files }) => {
        reread.push(...files);
        return Promise.resolve();
      });

      const rereadValues = (reread[0] as { values: Record<string, unknown[]> }).values;
      // Expected: the one changed field carries variant 'b', all others variant 'a'.
      const expected = { ...initial, spinner_test_text_field: alternate.spinner_test_text_field };
      expectValuesRoundTrip(expected, rereadValues);
    });

    it('delete — record is gone after delete; subsequent fetch returns null', async () => {
      const written = buildTestValues(objectSlug, 'a', { ownerMemberId, uniqueSuffix: freshSuffix() });
      const [created] = await connector.createRecords(tableSpec, [{ values: written }]);
      // Don't queue cleanup — we're deleting in the test body.
      const recordId = (created as { id: { record_id: string } }).id.record_id;

      await connector.deleteRecords(tableSpec, [created]);

      const reread: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(tableSpec, [recordId], async ({ files }) => {
        reread.push(...files);
        return Promise.resolve();
      });
      // pullRecordFilesByIds silently skips 404s, so an empty result confirms
      // the record was actually deleted (not just unreachable).
      expect(reread).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // List-entry CRUD — one of each, on the bootstrap-provisioned test list.
  // -------------------------------------------------------------------------

  describe('list entry CRUD', () => {
    const TEST_LIST_REMOTE_ID = ['list', 'spinner_test_pipeline'];
    let listTableSpec: BaseJsonTableSpec;
    let parentRecordId: string;

    beforeAll(async () => {
      const tables = await connector.listTables();
      const listTable = tables.find(
        (t) => t.id.remoteId[0] === TEST_LIST_REMOTE_ID[0] && t.id.remoteId[1] === TEST_LIST_REMOTE_ID[1],
      );
      if (!listTable) {
        throw new Error(
          'Test list `spinner_test_pipeline` not found — run `npx ts-node scripts/bootstrap-attio-test-data.ts`',
        );
      }
      listTableSpec = await connector.fetchJsonTableSpec(listTable.id);

      // Use the first existing deal as the parent for entry tests. The
      // bootstrap guarantees at least three.
      const dealsSpec = tableSpecsByObject.get('deals')!;
      const dealFiles: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        dealsSpec,
        async ({ files }) => {
          dealFiles.push(...files);
          if (dealFiles.length > 0) throw new EarlyExit();
          return Promise.resolve();
        },
        {},
        { forceFull: false },
      ).catch((e) => {
        if (!(e instanceof EarlyExit)) throw e;
      });
      parentRecordId = (dealFiles[0] as { id: { record_id: string } }).id.record_id;
    });

    function queueCleanup(entry: ConnectorFile): void {
      cleanups.push(async () => {
        await connector.deleteRecords(listTableSpec, [entry]);
      });
    }

    it('create — list entry round-trips entry_values through read', async () => {
      const entryValues = { spinner_test_stage: [{ option: 'Lead' }] };
      const [created] = await connector.createRecords(listTableSpec, [
        { parent_record_id: parentRecordId, parent_object: 'deals', entry_values: entryValues },
      ]);
      queueCleanup(created);

      const readEntryValues = (created as { entry_values: Record<string, unknown[]> }).entry_values;
      expectValuesRoundTrip(entryValues, readEntryValues);
    });

    it('update — sparse change to a list-scoped attribute is reflected after re-read', async () => {
      const [created] = await connector.createRecords(listTableSpec, [
        { parent_record_id: parentRecordId, parent_object: 'deals', entry_values: { spinner_test_stage: [{ option: 'Lead' }] } },
      ]);
      queueCleanup(created);

      const newStage = { spinner_test_stage: [{ option: 'Closed' }] };
      await connector.updateRecords(listTableSpec, [created], [{ entry_values: newStage }]);

      const entryId = (created as { id: { entry_id: string } }).id.entry_id;
      const reread: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(listTableSpec, [entryId], async ({ files }) => {
        reread.push(...files);
        return Promise.resolve();
      });

      const rereadEntryValues = (reread[0] as { entry_values: Record<string, unknown[]> }).entry_values;
      expectValuesRoundTrip(newStage, rereadEntryValues);
    });

    it('delete — entry is gone after delete; subsequent fetch returns null', async () => {
      const [created] = await connector.createRecords(listTableSpec, [
        { parent_record_id: parentRecordId, parent_object: 'deals', entry_values: { spinner_test_stage: [{ option: 'Lead' }] } },
      ]);
      const entryId = (created as { id: { entry_id: string } }).id.entry_id;

      await connector.deleteRecords(listTableSpec, [created]);

      const reread: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(listTableSpec, [entryId], async ({ files }) => {
        reread.push(...files);
        return Promise.resolve();
      });
      expect(reread).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drive a single callback out of `pullRecordFiles`, then bail. Lets us assert
 * on first-page shape without paying for a full pull.
 */
async function pullFirstPage(connector: AttioConnector, tableSpec: BaseJsonTableSpec): Promise<ConnectorFile[]> {
  const files: ConnectorFile[] = [];
  try {
    await connector.pullRecordFiles(
      tableSpec,
      // eslint-disable-next-line @typescript-eslint/require-await
      async ({ files: batch }) => {
        files.push(...batch);
        throw new EarlyExit();
      },
      {},
      { forceFull: false },
    );
  } catch (error) {
    if (!(error instanceof EarlyExit)) throw error;
  }
  return files;
}

class EarlyExit extends Error {
  constructor() {
    super('EarlyExit');
    this.name = 'EarlyExit';
  }
}
