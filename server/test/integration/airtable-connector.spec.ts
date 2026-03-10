// Set the URL override before any connector modules are imported, so the
// interceptor is configured when createApiClient() is first called.
const FAKE_AIRTABLE_PORT = 14_646;
process.env.API_URL_OVERRIDES = `https://api.airtable.com=http://localhost:${FAKE_AIRTABLE_PORT}`;

import http from 'http';
import { createApp } from '../../../test-api-fakes/airtable/src/index';
import { store } from '../../../test-api-fakes/airtable/src/store';

// Break the circular import chain: connector.ts → display-names.ts → all connectors → connector.ts
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { AirtableConnector } from 'src/remote-service/connectors/library/airtable/airtable-connector';
import { BaseJsonTableSpec, ConnectorFile, EntityId } from 'src/remote-service/connectors/types';

// ─── Test Setup ──────────────────────────────────────────────────────────────

let server: http.Server;

const TEST_BASE = {
  id: 'appTEST123',
  name: 'Test Base',
  permissionLevel: 'create' as const,
};

const TEST_TABLE = {
  id: 'tblTEST456',
  name: 'Tasks',
  description: 'A test table',
  primaryFieldId: 'fldName',
  fields: [
    { id: 'fldName', name: 'Name', type: 'singleLineText' },
    { id: 'fldStatus', name: 'Status', type: 'singleSelect' },
    { id: 'fldCount', name: 'Count', type: 'autoNumber' },
  ],
  views: [{ id: 'viwGrid', name: 'Grid view', type: 'grid' }],
};

const TEST_ENTITY_ID: EntityId = {
  wsId: 'tasks',
  remoteId: [TEST_BASE.id, TEST_TABLE.id],
};

function createConnector(): AirtableConnector {
  return new AirtableConnector('fake-test-api-key');
}

async function seedTestData() {
  store.reset();
  store.addBase(TEST_BASE);
  store.addTable(TEST_BASE.id, TEST_TABLE);
}

async function seedRecords(records: { fields: Record<string, unknown> }[]) {
  for (const record of records) {
    store.addRecord(TEST_BASE.id, TEST_TABLE.id, record.fields);
  }
}

/** Collect all files from a pull operation into a flat array. */
async function collectPulledFiles(
  connector: AirtableConnector,
  tableSpec: BaseJsonTableSpec,
  options: Record<string, unknown> = {},
): Promise<ConnectorFile[]> {
  const allFiles: ConnectorFile[] = [];
  await connector.pullRecordFiles(
    tableSpec,
    async ({ files }) => {
      allFiles.push(...files);
    },
    {},
    options,
  );
  return allFiles;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll((done) => {
  const app = createApp();
  server = app.listen(FAKE_AIRTABLE_PORT, done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(async () => {
  await seedTestData();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AirtableConnector with fake API', () => {
  describe('testConnection', () => {
    it('succeeds when API is reachable', async () => {
      const connector = createConnector();
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('throws when auth is invalid', async () => {
      // Simulate a 401 on the next request
      store.queueError(401, {
        error: { type: 'AUTHENTICATION_REQUIRED', message: 'Invalid API key' },
      });

      const connector = createConnector();
      await expect(connector.testConnection()).rejects.toThrow();
    });
  });

  describe('listTables', () => {
    it('returns table previews for all bases', async () => {
      const connector = createConnector();
      const tables = await connector.listTables();

      expect(tables).toHaveLength(1);
      expect(tables[0]).toMatchObject({
        id: {
          wsId: expect.any(String),
          remoteId: [TEST_BASE.id, TEST_TABLE.id],
        },
        displayName: 'Tasks',
        metadata: { baseName: 'Test Base' },
      });
    });

    it('returns tables across multiple bases', async () => {
      const secondBase = { id: 'appSECOND', name: 'Second Base', permissionLevel: 'create' as const };
      const secondTable = {
        id: 'tblSECOND',
        name: 'Projects',
        description: '',
        primaryFieldId: 'fldTitle',
        fields: [{ id: 'fldTitle', name: 'Title', type: 'singleLineText' }],
        views: [],
      };
      store.addBase(secondBase);
      store.addTable(secondBase.id, secondTable);

      const connector = createConnector();
      const tables = await connector.listTables();

      expect(tables).toHaveLength(2);
      const names = tables.map((t) => t.displayName);
      expect(names).toContain('Tasks');
      expect(names).toContain('Projects');
    });
  });

  describe('fetchJsonTableSpec', () => {
    it('returns a valid table spec with schema', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);

      expect(spec.name).toBe('Tasks');
      expect(spec.id).toEqual(TEST_ENTITY_ID);
      expect(spec.idColumnRemoteId).toBe('id');
      expect(spec.basePath).toEqual(['Test Base']);
      expect(spec.schema).toBeDefined();
      // Schema should have id, fields, and createdTime properties
      expect(spec.schema.properties).toHaveProperty('id');
      expect(spec.schema.properties).toHaveProperty('fields');
      expect(spec.schema.properties).toHaveProperty('createdTime');
      // Fields should contain our defined fields
      expect(spec.schema.properties.fields.properties).toHaveProperty('Name');
      expect(spec.schema.properties.fields.properties).toHaveProperty('Status');
    });

    it('throws for unknown base', async () => {
      const connector = createConnector();
      const badId: EntityId = { wsId: 'bad', remoteId: ['appNONE', 'tblNONE'] };
      await expect(connector.fetchJsonTableSpec(badId)).rejects.toThrow('Base appNONE not found');
    });

    it('throws for unknown table', async () => {
      const connector = createConnector();
      const badId: EntityId = { wsId: 'bad', remoteId: [TEST_BASE.id, 'tblNONE'] };
      await expect(connector.fetchJsonTableSpec(badId)).rejects.toThrow('Table tblNONE not found');
    });
  });

  describe('pullRecordFiles', () => {
    it('pulls all records from a table', async () => {
      await seedRecords([
        { fields: { Name: 'Task 1', Status: 'Done' } },
        { fields: { Name: 'Task 2', Status: 'Todo' } },
        { fields: { Name: 'Task 3', Status: 'In Progress' } },
      ]);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);
      const files = await collectPulledFiles(connector, spec);

      expect(files).toHaveLength(3);
      const names = files.map((f: any) => f.fields.Name);
      expect(names).toContain('Task 1');
      expect(names).toContain('Task 2');
      expect(names).toContain('Task 3');
    });

    it('returns empty array when no records exist', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);
      const files = await collectPulledFiles(connector, spec);

      expect(files).toHaveLength(0);
    });

    it('handles pagination transparently', async () => {
      // Create 150 records (page size is 100)
      const records = Array.from({ length: 150 }, (_, i) => ({
        fields: { Name: `Record ${i}` },
      }));
      await seedRecords(records);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);

      // Collect files across all pages
      const batches: ConnectorFile[][] = [];
      await connector.pullRecordFiles(
        spec,
        async ({ files }) => {
          batches.push(files);
        },
        {},
        {},
      );

      // Should have been called in multiple batches
      expect(batches.length).toBeGreaterThan(1);
      // Total should be 150
      const totalFiles = batches.reduce((sum, batch) => sum + batch.length, 0);
      expect(totalFiles).toBe(150);
    });
  });

  describe('pullRecordFilesByIds', () => {
    it('pulls only the requested records', async () => {
      await seedRecords([
        { fields: { Name: 'Task A' } },
        { fields: { Name: 'Task B' } },
        { fields: { Name: 'Task C' } },
      ]);

      const allRecords = store.listRecords(TEST_BASE.id, TEST_TABLE.id);
      const targetIds = [allRecords[0].id, allRecords[2].id];

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);

      const files: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(spec, targetIds, async ({ files: batch }) => {
        files.push(...batch);
      });

      expect(files).toHaveLength(2);
      const names = files.map((f: any) => f.fields.Name);
      expect(names).toContain('Task A');
      expect(names).toContain('Task C');
      expect(names).not.toContain('Task B');
    });
  });

  describe('createRecords', () => {
    it('creates records and returns them with assigned IDs', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);

      const files: ConnectorFile[] = [
        { fields: { Name: 'New Task 1', Status: 'Todo' } },
        { fields: { Name: 'New Task 2', Status: 'Done' } },
      ];

      const created = await connector.createRecords(spec, files);

      expect(created).toHaveLength(2);
      expect((created[0] as any).id).toMatch(/^rec/);
      expect((created[1] as any).id).toMatch(/^rec/);
      expect((created[0] as any).fields.Name).toBe('New Task 1');
      expect((created[1] as any).fields.Name).toBe('New Task 2');

      // Verify they're actually in the store
      const stored = store.listRecords(TEST_BASE.id, TEST_TABLE.id);
      expect(stored).toHaveLength(2);
    });

    it('filters out readonly fields', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);

      // Count is an autoNumber field (readonly) — should be filtered out
      const files: ConnectorFile[] = [{ fields: { Name: 'Task', Count: 42 } }];

      const created = await connector.createRecords(spec, files);

      // The created record should not have the Count field sent to the API
      expect(created).toHaveLength(1);
      expect((created[0] as any).fields).not.toHaveProperty('Count');
    });
  });

  describe('updateRecords', () => {
    it('updates existing records', async () => {
      // Create a record first
      await seedRecords([{ fields: { Name: 'Original', Status: 'Todo' } }]);
      const records = store.listRecords(TEST_BASE.id, TEST_TABLE.id);
      const recordId = records[0].id;

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);

      const files: ConnectorFile[] = [{ id: recordId, fields: { Name: 'Updated', Status: 'Done' } }];

      await connector.updateRecords(spec, files);

      // Verify the update
      const updated = store.getRecord(TEST_BASE.id, TEST_TABLE.id, recordId);
      expect(updated?.fields.Name).toBe('Updated');
      expect(updated?.fields.Status).toBe('Done');
    });
  });

  describe('deleteRecords', () => {
    it('deletes records from the table', async () => {
      await seedRecords([{ fields: { Name: 'Doomed' } }, { fields: { Name: 'Safe' } }]);

      const records = store.listRecords(TEST_BASE.id, TEST_TABLE.id);
      const doomedId = records[0].id;

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);

      await connector.deleteRecords(spec, [{ id: doomedId } as ConnectorFile]);

      const remaining = store.listRecords(TEST_BASE.id, TEST_TABLE.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].fields.Name).toBe('Safe');
    });

    it('handles deleting already-deleted records gracefully', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);

      // Should not throw
      await expect(connector.deleteRecords(spec, [{ id: 'recNONEXISTENT' } as ConnectorFile])).resolves.toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('retries on 429 rate limit and eventually succeeds', async () => {
      // Simulate 2 rate-limited requests, then succeed
      store.queueRateLimit(2, 0);

      await seedRecords([{ fields: { Name: 'Test' } }]);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(TEST_ENTITY_ID);

      // The pull should succeed after retrying past the rate limits
      // (the fetchJsonTableSpec above consumed the 2 rate limits, so seed fresh ones)
      store.queueRateLimit(2, 0);
      const files = await collectPulledFiles(connector, spec);
      expect(files).toHaveLength(1);
    }, 15000);

    it('surfaces auth errors via extractConnectorErrorDetails', async () => {
      const connector = createConnector();

      store.queueError(401, {
        error: { type: 'AUTHENTICATION_REQUIRED', message: 'Invalid API key' },
      });

      try {
        await connector.testConnection();
        fail('Should have thrown');
      } catch (error) {
        const details = connector.extractConnectorErrorDetails(error);
        expect(details.userFriendlyMessage).toBeDefined();
        expect(details.userFriendlyMessage.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getBatchSize', () => {
    it('returns 10', () => {
      const connector = createConnector();
      expect(connector.getBatchSize()).toBe(10);
    });
  });

  describe('supportsFilters', () => {
    it('returns true', () => {
      const connector = createConnector();
      expect(connector.supportsFilters()).toBe(true);
    });
  });
});
