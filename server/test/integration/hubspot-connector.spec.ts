// Set the URL override before any connector modules are imported, so the
// interceptor is configured when createApiClient() is first called.
const FAKE_HUBSPOT_PORT = 14_653;
process.env.API_URL_OVERRIDES = `https://api.hubapi.com=http://localhost:${FAKE_HUBSPOT_PORT}`;

import http from 'http';
import { createApp } from '../../../test-api-fakes/hubspot/src/index';
import { store } from '../../../test-api-fakes/hubspot/src/store';

// Break the circular import chain: connector.ts → display-names.ts → all connectors → connector.ts
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { HubspotConnector } from 'src/remote-service/connectors/library/hubspot/hubspot-connector';
import { BaseJsonTableSpec, ConnectorFile, EntityId } from 'src/remote-service/connectors/types';

// ─── Test Setup ──────────────────────────────────────────────────────────────

let server: http.Server;

const CONTACTS_ENTITY_ID: EntityId = {
  wsId: 'contacts',
  remoteId: ['contacts'],
};

const COMPANIES_ENTITY_ID: EntityId = {
  wsId: 'companies',
  remoteId: ['companies'],
};

const DEALS_ENTITY_ID: EntityId = {
  wsId: 'deals',
  remoteId: ['deals'],
};

function createConnector(): HubspotConnector {
  return new HubspotConnector('fake-test-token');
}

function seedContacts(contacts: Record<string, string | null>[]) {
  for (const properties of contacts) {
    store.addRecord('contacts', properties);
  }
}

function seedCompanies(companies: Record<string, string | null>[]) {
  for (const properties of companies) {
    store.addRecord('companies', properties);
  }
}

function seedDeals(deals: Record<string, string | null>[]) {
  for (const properties of deals) {
    store.addRecord('deals', properties);
  }
}

/** Collect all files from a pull operation into a flat array. */
async function collectPulledFiles(connector: HubspotConnector, tableSpec: BaseJsonTableSpec): Promise<ConnectorFile[]> {
  const allFiles: ConnectorFile[] = [];
  await connector.pullRecordFiles(
    tableSpec,
    async ({ files }) => {
      allFiles.push(...files);
    },
    {},
    {},
  );
  return allFiles;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll((done) => {
  const app = createApp();
  server = app.listen(FAKE_HUBSPOT_PORT, done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  store.reset();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('HubspotConnector with fake API', () => {
  describe('testConnection', () => {
    it('succeeds when API is reachable', async () => {
      const connector = createConnector();
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('throws when auth is invalid', async () => {
      store.queueError(401, {
        status: 'error',
        message: 'Authentication credentials not found',
        correlationId: 'fake-correlation-id',
        category: 'UNAUTHORIZED',
      });

      const connector = createConnector();
      await expect(connector.testConnection()).rejects.toThrow();
    });
  });

  describe('listTables', () => {
    it('returns standard object types', async () => {
      const connector = createConnector();
      const tables = await connector.listTables();

      const names = tables.map((t) => t.displayName);
      expect(names).toContain('Contacts');
      expect(names).toContain('Companies');
      expect(names).toContain('Deals');
      expect(names).toContain('Tickets');
    });

    it('includes custom objects when available', async () => {
      store.customObjectSchemas = [
        {
          fullyQualifiedName: 'p12345_Widgets',
          labels: { plural: 'Widgets', singular: 'Widget' },
          properties: [],
        },
      ];

      const connector = createConnector();
      const tables = await connector.listTables();

      const customTable = tables.find((t) => t.displayName === 'Widgets');
      expect(customTable).toBeDefined();
      expect(customTable!.id.remoteId).toEqual(['p12345_Widgets']);
      expect(customTable!.parentPath).toBe('Custom Objects');
    });
  });

  describe('fetchJsonTableSpec', () => {
    it('returns a valid table spec with dynamically discovered properties', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      expect(spec.name).toBe('Contacts');
      expect(spec.id).toEqual(CONTACTS_ENTITY_ID);
      expect(spec.idColumnRemoteId).toBe('id');
      expect(spec.schema).toBeDefined();
      expect(spec.schema.properties).toHaveProperty('id');
      expect(spec.schema.properties).toHaveProperty('properties');
      expect(spec.schema.properties.properties.properties).toHaveProperty('email');
      expect(spec.schema.properties.properties.properties).toHaveProperty('firstname');
    });

    it('includes associations schema for objects that support them', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      expect(spec.schema.properties).toHaveProperty('associations');
    });

    it('uses custom properties when set', async () => {
      store.setProperties('contacts', [
        {
          name: 'custom_field',
          label: 'Custom Field',
          type: 'string',
          fieldType: 'text',
          description: 'A custom field',
          hidden: false,
        },
      ]);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      expect(spec.schema.properties.properties.properties).toHaveProperty('custom_field');
      // Default properties should not be present since we overrode them
      expect(spec.schema.properties.properties.properties).not.toHaveProperty('email');
    });
  });

  describe('pullRecordFiles', () => {
    it('pulls all records from an object type', async () => {
      seedContacts([
        { email: 'alice@example.com', firstname: 'Alice' },
        { email: 'bob@example.com', firstname: 'Bob' },
        { email: 'charlie@example.com', firstname: 'Charlie' },
      ]);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const files = await collectPulledFiles(connector, spec);

      expect(files).toHaveLength(3);
      const emails = files.map((f) => (f as unknown as { properties: Record<string, string> }).properties.email);
      expect(emails).toContain('alice@example.com');
      expect(emails).toContain('bob@example.com');
      expect(emails).toContain('charlie@example.com');
    });

    it('returns empty when no records exist', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const files = await collectPulledFiles(connector, spec);

      expect(files).toHaveLength(0);
    });

    it('handles pagination transparently', async () => {
      // Create 150 records (page size is 100)
      const contacts = Array.from({ length: 150 }, (_, i) => ({
        email: `user${i}@example.com`,
        firstname: `User ${i}`,
      }));
      seedContacts(contacts);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const batches: ConnectorFile[][] = [];
      await connector.pullRecordFiles(
        spec,
        async ({ files }) => {
          batches.push(files);
        },
        {},
        {},
      );

      expect(batches.length).toBeGreaterThan(1);
      const totalFiles = batches.reduce((sum, batch) => sum + batch.length, 0);
      expect(totalFiles).toBe(150);
    });

    it('includes associations in pulled records', async () => {
      // Create a contact and a company, then associate them
      const contact = store.addRecord('contacts', { email: 'linked@example.com', firstname: 'Linked' });
      const company = store.addRecord('companies', { name: 'Acme Corp' });
      store.addAssociation('contacts', contact.id, 'companies', company.id);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const files = await collectPulledFiles(connector, spec);

      expect(files).toHaveLength(1);
      const record = files[0] as unknown as { associations?: Record<string, { results: { id: string }[] }> };
      expect(record.associations).toBeDefined();
      expect(record.associations!.companies.results).toHaveLength(1);
      expect(record.associations!.companies.results[0].id).toBe(company.id);
    });
  });

  describe('pullRecordFilesByIds', () => {
    it('pulls only the requested records', async () => {
      seedContacts([
        { email: 'a@example.com', firstname: 'A' },
        { email: 'b@example.com', firstname: 'B' },
        { email: 'c@example.com', firstname: 'C' },
      ]);

      const allRecords = store.listRecords('contacts');
      const targetIds = [allRecords[0].id, allRecords[2].id];

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(spec, targetIds, async ({ files: batch }) => {
        files.push(...batch);
      });

      expect(files).toHaveLength(2);
      const emails = files.map((f) => (f as unknown as { properties: Record<string, string> }).properties.email);
      expect(emails).toContain('a@example.com');
      expect(emails).toContain('c@example.com');
      expect(emails).not.toContain('b@example.com');
    });

    it('silently skips 404s for deleted records', async () => {
      seedContacts([{ email: 'exists@example.com', firstname: 'Exists' }]);
      const existingId = store.listRecords('contacts')[0].id;

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(spec, [existingId, '99999'], async ({ files: batch }) => {
        files.push(...batch);
      });

      expect(files).toHaveLength(1);
    });
  });

  describe('createRecords', () => {
    it('creates records and returns them with assigned IDs', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files: ConnectorFile[] = [
        { properties: { email: 'new1@example.com', firstname: 'New1' } } as unknown as ConnectorFile,
        { properties: { email: 'new2@example.com', firstname: 'New2' } } as unknown as ConnectorFile,
      ];

      const created = await connector.createRecords(spec, files);

      expect(created).toHaveLength(2);
      expect((created[0] as unknown as { id: string }).id).toBeDefined();
      expect((created[1] as unknown as { id: string }).id).toBeDefined();

      // Verify they're in the store
      const stored = store.listRecords('contacts');
      expect(stored).toHaveLength(2);
    });

    it('filters out read-only system properties', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files: ConnectorFile[] = [
        {
          properties: {
            email: 'test@example.com',
            hs_object_id: '999',
            createdate: '2024-01-01',
            lastmodifieddate: '2024-01-01',
          },
        } as unknown as ConnectorFile,
      ];

      const created = await connector.createRecords(spec, files);
      expect(created).toHaveLength(1);

      // The hs_object_id should be system-assigned, not '999'
      const record = store.listRecords('contacts')[0];
      expect(record.properties.email).toBe('test@example.com');
    });

    it('creates associations for new records', async () => {
      const company = store.addRecord('companies', { name: 'Partner Corp' });

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files: ConnectorFile[] = [
        {
          properties: { email: 'linked@example.com', firstname: 'Linked' },
          associations: {
            companies: { results: [{ id: company.id, type: 'contacts_to_companies' }] },
          },
        } as unknown as ConnectorFile,
      ];

      const created = await connector.createRecords(spec, files);
      expect(created).toHaveLength(1);

      // Verify the association was created
      const createdRecord = store.getRecord('contacts', (created[0] as unknown as { id: string }).id);
      expect(createdRecord?.associations?.companies?.results).toHaveLength(1);
      expect(createdRecord?.associations?.companies?.results[0].id).toBe(company.id);
    });
  });

  describe('updateRecords', () => {
    it('updates existing records', async () => {
      seedContacts([{ email: 'original@example.com', firstname: 'Original' }]);
      const recordId = store.listRecords('contacts')[0].id;

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files: ConnectorFile[] = [
        {
          id: recordId,
          properties: { email: 'updated@example.com', firstname: 'Updated' },
        } as unknown as ConnectorFile,
      ];

      await connector.updateRecords(spec, files);

      const updated = store.getRecord('contacts', recordId);
      expect(updated?.properties.email).toBe('updated@example.com');
      expect(updated?.properties.firstname).toBe('Updated');
    });

    it('syncs association changes on update', async () => {
      const contact = store.addRecord('contacts', { email: 'assoc@example.com', firstname: 'Assoc' });
      const company1 = store.addRecord('companies', { name: 'Old Corp' });
      const company2 = store.addRecord('companies', { name: 'New Corp' });
      store.addAssociation('contacts', contact.id, 'companies', company1.id);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      // Update to associate with company2 instead of company1
      const files: ConnectorFile[] = [
        {
          id: contact.id,
          properties: { email: 'assoc@example.com', firstname: 'Assoc' },
          associations: {
            companies: { results: [{ id: company2.id, type: 'contacts_to_companies' }] },
          },
        } as unknown as ConnectorFile,
      ];

      await connector.updateRecords(spec, files);

      const updated = store.getRecord('contacts', contact.id);
      const companyAssocs = updated?.associations?.companies?.results ?? [];
      expect(companyAssocs).toHaveLength(1);
      expect(companyAssocs[0].id).toBe(company2.id);
    });
  });

  describe('deleteRecords', () => {
    it('deletes records', async () => {
      seedContacts([{ email: 'doomed@example.com' }, { email: 'safe@example.com' }]);
      const records = store.listRecords('contacts');
      const doomedId = records[0].id;

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      await connector.deleteRecords(spec, [{ id: doomedId } as ConnectorFile]);

      const remaining = store.listRecords('contacts');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].properties.email).toBe('safe@example.com');
    });

    it('handles deleting already-deleted records gracefully', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      await expect(connector.deleteRecords(spec, [{ id: '99999' } as ConnectorFile])).resolves.toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('retries on 429 rate limit and eventually succeeds', async () => {
      seedContacts([{ email: 'test@example.com', firstname: 'Test' }]);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      // Queue rate limits for the pull request
      store.queueRateLimit(2, 0);
      const files = await collectPulledFiles(connector, spec);
      expect(files).toHaveLength(1);
    });

    it('surfaces auth errors via extractConnectorErrorDetails', async () => {
      const connector = createConnector();

      store.queueError(401, {
        status: 'error',
        message: 'Authentication credentials not found',
        correlationId: 'fake-correlation-id',
        category: 'UNAUTHORIZED',
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
    it('returns 1', () => {
      const connector = createConnector();
      expect(connector.getBatchSize()).toBe(1);
    });
  });

  describe('service', () => {
    it('returns HUBSPOT', () => {
      const connector = createConnector();
      expect(connector.service).toBe('HUBSPOT');
    });
  });

  describe('multiple object types', () => {
    it('can pull contacts and deals independently', async () => {
      seedContacts([{ email: 'contact@example.com', firstname: 'Contact' }]);
      seedDeals([{ dealname: 'Big Deal', amount: '50000' }]);

      const connector = createConnector();

      const contactSpec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const contactFiles = await collectPulledFiles(connector, contactSpec);
      expect(contactFiles).toHaveLength(1);

      const dealSpec = await connector.fetchJsonTableSpec(DEALS_ENTITY_ID);
      const dealFiles = await collectPulledFiles(connector, dealSpec);
      expect(dealFiles).toHaveLength(1);
    });
  });
});
