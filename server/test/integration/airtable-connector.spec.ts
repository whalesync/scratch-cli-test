/**
 * Airtable connector live API integration test.
 *
 * Exercises the real Airtable API: validates credentials, discovers bases and
 * tables, builds a schema, pulls records, and runs a create→update→delete
 * round-trip (cleaning up after itself).
 *
 * Requires AIRTABLE_API_KEY in .env.integration.
 * Run via: cd server && yarn test:integration -- airtable-connector
 */

// Break the circular import chain: connector.ts → display-names.ts → all connectors → connector.ts
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { AirtableConnector } from 'src/remote-service/connectors/library/airtable/airtable-connector';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

jest.setTimeout(60_000);

const API_KEY = process.env.AIRTABLE_API_KEY;

function createConnector(): AirtableConnector {
  return new AirtableConnector(API_KEY!);
}

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('AirtableConnector — live API', () => {
  let connector: AirtableConnector;
  let allTables: TablePreview[];
  let firstTable: TablePreview;
  let firstSpec: BaseJsonTableSpec;

  beforeAll(async () => {
    connector = createConnector();
    allTables = await connector.listTables();
    firstTable = allTables[0];
    firstSpec = await connector.fetchJsonTableSpec(firstTable.id);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Connection
  // ─────────────────────────────────────────────────────────────────────────

  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects an obviously invalid key', async () => {
      const badConnector = new AirtableConnector('not-a-real-airtable-key');
      await expect(badConnector.testConnection()).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Table discovery
  // ─────────────────────────────────────────────────────────────────────────

  describe('listTables', () => {
    it('returns at least one table', () => {
      expect(allTables.length).toBeGreaterThan(0);
    });

    it('every table has a valid EntityId and a display name', () => {
      for (const table of allTables) {
        expect(table.id.wsId).toBeDefined();
        expect(table.id.remoteId).toHaveLength(2); // [baseId, tableId]
        expect(table.id.remoteId[0]).toMatch(/^app/);
        expect(table.id.remoteId[1]).toMatch(/^tbl/);
        expect(table.displayName.length).toBeGreaterThan(0);
      }
    });

    it('groups tables by base name', () => {
      // Every table should have a parentPath (the base name)
      for (const table of allTables) {
        expect(table.parentPath).toBeDefined();
        expect(table.parentPath!.length).toBeGreaterThan(0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Schema discovery
  // ─────────────────────────────────────────────────────────────────────────

  describe('fetchJsonTableSpec', () => {
    it('builds a spec with the expected top-level structure', () => {
      expect(firstSpec.id).toEqual(firstTable.id);
      expect(firstSpec.name).toBe(firstTable.displayName);
      expect(firstSpec.idColumnRemoteId).toBe('id');
      expect(firstSpec.schema).toBeDefined();

      const props = (firstSpec.schema as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(props).toHaveProperty('fields');
      expect(props).toHaveProperty('createdTime');
    });

    it('includes at least one field in the schema', () => {
      const props = (firstSpec.schema as { properties: Record<string, unknown> }).properties;
      const fieldsProps = (props.fields as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(fieldsProps).length).toBeGreaterThan(0);
    });

    it('throws for an unknown base', async () => {
      const badId = { wsId: 'bad', remoteId: ['appNONEXISTENT999', 'tblNONE'] };
      await expect(connector.fetchJsonTableSpec(badId)).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Pull records
  // ─────────────────────────────────────────────────────────────────────────

  describe('pullRecordFiles', () => {
    it('pulls records from the first table', async () => {
      const allFiles: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        firstSpec,
        async ({ files }) => {
          allFiles.push(...files);
        },
        {},
        {},
      );

      // We don't know how many records exist, but the pull should complete
      // without error. If the table has records, each should have an id.
      for (const file of allFiles) {
        expect((file as Record<string, unknown>).id).toBeDefined();
      }

      console.log(`\nAirtable pull: ${allFiles.length} records from "${firstSpec.name}"\n`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Create → Update → Delete round-trip
  // ─────────────────────────────────────────────────────────────────────────

  describe('create → update → delete round-trip', () => {
    // Find the primary field name from the schema so we can create a valid record.
    let primaryFieldName: string;

    beforeAll(() => {
      const props = (firstSpec.schema as { properties: Record<string, unknown> }).properties;
      const fieldsProps = (props.fields as { properties: Record<string, unknown> }).properties;
      // Use the first field name — it's typically the primary field
      primaryFieldName = Object.keys(fieldsProps)[0];
    });

    it('creates a record, updates it, then deletes it', async () => {
      const testValue = `Scratch integration test ${Date.now()}`;
      const updatedValue = `${testValue} (updated)`;

      // Create
      const created = await connector.createRecords(firstSpec, [
        { fields: { [primaryFieldName]: testValue } } as ConnectorFile,
      ]);

      expect(created).toHaveLength(1);
      const recordId = (created[0] as Record<string, unknown>).id as string;
      expect(recordId).toMatch(/^rec/);
      expect((created[0] as Record<string, unknown>).fields).toHaveProperty(primaryFieldName, testValue);

      // Update
      await connector.updateRecords(
        firstSpec,
        [{ id: recordId, fields: { [primaryFieldName]: updatedValue } } as unknown as ConnectorFile],
        [{ fields: { [primaryFieldName]: updatedValue } }],
      );

      // Verify update via pullRecordFilesByIds
      const pulledFiles: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(firstSpec, [recordId], async ({ files }) => {
        pulledFiles.push(...files);
      });
      expect(pulledFiles).toHaveLength(1);
      expect((pulledFiles[0] as Record<string, unknown>).fields).toHaveProperty(primaryFieldName, updatedValue);

      // Delete (cleanup)
      await connector.deleteRecords(firstSpec, [{ id: recordId } as ConnectorFile]);

      // Verify deletion — pullRecordFilesByIds should return nothing for a deleted record
      const afterDelete: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(firstSpec, [recordId], async ({ files }) => {
        afterDelete.push(...files);
      });
      expect(afterDelete).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // API Quota
  // ─────────────────────────────────────────────────────────────────────────

  describe('getApiQuota', () => {
    it('returns a dashboardUrl pointing to the workspace billing page', async () => {
      const result = await connector.getApiQuota();

      expect(result).toBeDefined();
      expect(result).toHaveProperty('dashboardUrl');

      const { dashboardUrl } = result as { dashboardUrl: string };
      expect(dashboardUrl).toMatch(/^https:\/\/airtable\.com\/wsp[A-Za-z0-9]+\/workspace\/billing$/);

      console.log(`\nAirtable API quota dashboard: ${dashboardUrl}\n`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Connector properties
  // ─────────────────────────────────────────────────────────────────────────

  describe('connector properties', () => {
    it('getBatchSize returns 10', () => {
      expect(connector.getBatchSize()).toBe(10);
    });

    it('supportsFilters returns true', () => {
      expect(connector.supportsFilters()).toBe(true);
    });

    it('supportsFieldSelection returns false', () => {
      expect(connector.supportsFieldSelection()).toBe(false);
    });
  });
});
