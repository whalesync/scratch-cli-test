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

import { PartialBatchCreateError } from 'src/remote-service/connectors/error';
import { HubspotApiClient } from 'src/remote-service/connectors/library/hubspot/hubspot-api-client';
import { HubspotAssociationWriteError } from 'src/remote-service/connectors/library/hubspot/hubspot-batch-publish';
import { HubspotConnector } from 'src/remote-service/connectors/library/hubspot/hubspot-connector';
import { HubspotRecord } from 'src/remote-service/connectors/library/hubspot/hubspot-types';
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

const QUOTES_ENTITY_ID: EntityId = {
  wsId: 'quotes',
  remoteId: ['quotes'],
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
      expect(spec.idPath).toBe('id');
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

  describe('incremental pull (CRM Search API)', () => {
    const OLD_MODIFIED = '2026-01-01T00:00:00.000Z';
    const NEW_MODIFIED = '2026-05-01T00:00:00.000Z';
    // Between OLD and NEW, far enough from both that the 60s clock-skew margin
    // can't pull OLD records back in or push NEW ones out.
    const SINCE = new Date('2026-03-01T00:00:00.000Z');

    /** Run an incremental pull, collecting files and returning them with the result. */
    async function pullIncremental(
      connector: HubspotConnector,
      tableSpec: BaseJsonTableSpec,
      since: Date,
    ): Promise<{ files: ConnectorFile[]; result: { newWatermark?: Date } }> {
      const files: ConnectorFile[] = [];
      const result = await connector.pullRecordFiles(
        tableSpec,
        async ({ files: batch }) => {
          files.push(...batch);
        },
        {},
        { pullMode: 'incremental', since },
      );
      return { files, result };
    }

    function emailsOf(files: ConnectorFile[]): string[] {
      return files.map((f) => (f as unknown as { properties: Record<string, string> }).properties.email);
    }

    it('reports incrementalPullSupport=SUPPORTED for contacts (lastmodifieddate is auto-detected)', async () => {
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      expect(connector.incrementalPullSupport({}, spec)).toBe('SUPPORTED');
    });

    it('returns only records modified after the clock-skewed watermark, plus the new watermark', async () => {
      seedContacts([
        { email: 'old1@example.com', firstname: 'Old1' },
        { email: 'old2@example.com', firstname: 'Old2' },
        { email: 'changed@example.com', firstname: 'Changed' },
      ]);
      const contacts = store.listRecords('contacts');
      // Park every contact well before the watermark...
      for (const c of contacts) {
        store.setModifiedAt('contacts', c.id, OLD_MODIFIED);
      }
      // ...then "edit" exactly one so it lands after the watermark.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const changed = contacts.find((c) => c.properties.email === 'changed@example.com')!;
      store.setModifiedAt('contacts', changed.id, NEW_MODIFIED);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const before = Date.now();
      const { files, result } = await pullIncremental(connector, spec, SINCE);
      const after = Date.now();

      expect(emailsOf(files)).toEqual(['changed@example.com']);
      expect(result.newWatermark).toBeInstanceOf(Date);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
    });

    it('paginates the search across multiple pages (page size 100)', async () => {
      // 150 changed contacts → two search pages.
      seedContacts(Array.from({ length: 150 }, (_, i) => ({ email: `changed${i}@example.com`, firstname: `C${i}` })));
      for (const c of store.listRecords('contacts')) {
        store.setModifiedAt('contacts', c.id, NEW_MODIFIED);
      }

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const batches: ConnectorFile[][] = [];
      const result = await connector.pullRecordFiles(
        spec,
        async ({ files }) => {
          batches.push(files);
        },
        {},
        { pullMode: 'incremental', since: SINCE },
      );

      expect(batches.length).toBeGreaterThan(1);
      expect(batches.reduce((sum, b) => sum + b.length, 0)).toBe(150);
      expect(result.newWatermark).toBeInstanceOf(Date);
    });

    it('hydrates associations on incremental pulls to match the full-pull shape', async () => {
      // The Search API never returns `associations`, and the pull job writes
      // record files wholesale — so an unhydrated incremental emit would
      // rewrite the file WITHOUT its associations key, wiping FK data that is
      // still live in HubSpot. The connector therefore re-fetches each changed
      // record via single-record GET before emitting it.
      const contact = store.addRecord('contacts', { email: 'linked@example.com', firstname: 'Linked' });
      const company = store.addRecord('companies', { name: 'Acme Corp' });
      store.addAssociation('contacts', contact.id, 'companies', company.id);
      store.setModifiedAt('contacts', contact.id, NEW_MODIFIED);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      // Full pull includes associations (baseline)...
      const fullFiles = await collectPulledFiles(connector, spec);
      const fullPullAssociations = (fullFiles[0] as unknown as { associations?: unknown }).associations;
      expect(fullPullAssociations).toBeDefined();

      // ...and the incremental pull now carries the identical association data.
      const { files } = await pullIncremental(connector, spec, SINCE);
      expect(files).toHaveLength(1);
      expect((files[0] as unknown as { associations?: unknown }).associations).toEqual(fullPullAssociations);
    });

    it('demotes to a full pull when the object exposes no last-modified property (custom object)', async () => {
      const CUSTOM_ENTITY_ID: EntityId = { wsId: 'p999_widgets', remoteId: ['p999_widgets'] };
      // A custom object whose property set has no hs_lastmodifieddate/lastmodifieddate
      // → nothing to auto-detect, no explicit override → NEEDS_CONFIGURATION.
      store.setProperties('p999_widgets', [
        {
          name: 'widget_name',
          label: 'Widget Name',
          type: 'string',
          fieldType: 'text',
          description: '',
          hidden: false,
        },
      ]);
      store.addRecord('p999_widgets', { widget_name: 'W1' });
      store.addRecord('p999_widgets', { widget_name: 'W2' });

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CUSTOM_ENTITY_ID);
      expect(connector.incrementalPullSupport({}, spec)).toBe('NEEDS_CONFIGURATION');

      const { files, result } = await pullIncremental(connector, spec, SINCE);
      // Demoted: full scan via the list endpoint returns every record, no watermark.
      expect(files).toHaveLength(2);
      expect(result).toEqual({});
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

  // DEV-10200: the same association flows through the date-versioned 2026-03
  // URLs (/crm/objects/2026-03/...), which the connector uses when the
  // HUBSPOT_ASSOCIATIONS_API_2026_03 flag is on for the publishing user. The
  // fake mounts both URL shapes over one store, so these prove the new paths
  // end-to-end with unchanged semantics.
  describe('associations via the 2026-03 API (DEV-10200)', () => {
    function createConnector202603(): HubspotConnector {
      return new HubspotConnector('fake-test-token', { associationsApiVersion: '2026-03' });
    }

    it('creates associations for new records', async () => {
      const company = store.addRecord('companies', { name: 'DBV Partner Corp' });

      const connector = createConnector202603();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files: ConnectorFile[] = [
        {
          properties: { email: 'dbv-linked@example.com', firstname: 'DbvLinked' },
          associations: {
            companies: { results: [{ id: company.id, type: 'contacts_to_companies' }] },
          },
        } as unknown as ConnectorFile,
      ];

      const created = await connector.createRecords(spec, files);
      expect(created).toHaveLength(1);

      const createdRecord = store.getRecord('contacts', (created[0] as unknown as { id: string }).id);
      expect(createdRecord?.associations?.companies?.results).toHaveLength(1);
      expect(createdRecord?.associations?.companies?.results[0].id).toBe(company.id);
    });

    it('syncs association changes on update (create + delete)', async () => {
      const contact = store.addRecord('contacts', { email: 'dbv-assoc@example.com', firstname: 'DbvAssoc' });
      const company1 = store.addRecord('companies', { name: 'DBV Old Corp' });
      const company2 = store.addRecord('companies', { name: 'DBV New Corp' });
      store.addAssociation('contacts', contact.id, 'companies', company1.id);

      const connector = createConnector202603();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files: ConnectorFile[] = [
        {
          id: contact.id,
          properties: { email: 'dbv-assoc@example.com', firstname: 'DbvAssoc' },
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

  // A published HubSpot quote is locked and rejects a property PATCH with
  // "Published Quote cannot be edited" (DEV-10886). The fake models that lock; the
  // connector must recall → edit → re-publish to get the change through.
  describe('published quote recall (DEV-10886)', () => {
    /** Seed a locked/published quote; returns its record id. */
    function seedPublishedQuote(): string {
      const quote = store.addRecord('quotes', {
        hs_title: 'Q1',
        hs_terms: 'Old terms',
        hs_status: 'APPROVAL_NOT_NEEDED',
      });
      return quote.id;
    }

    it('the fake locks a published quote against a raw property edit but allows the recall', async () => {
      const quoteId = seedPublishedQuote();
      // Publishing flips hs_locked on.
      expect(store.getRecord('quotes', quoteId)?.properties.hs_locked).toBe('true');

      const client = new HubspotApiClient('fake-test-token');
      // A raw property PATCH on a published quote is rejected...
      await expect(client.updateRecord('quotes', quoteId, { hs_terms: 'Nope' })).rejects.toThrow();
      // ...but recalling it to DRAFT is allowed, and unlocks it.
      await expect(client.updateRecord('quotes', quoteId, { hs_status: 'DRAFT' })).resolves.toBeDefined();
      expect(store.getRecord('quotes', quoteId)?.properties.hs_locked).toBe('false');
    });

    it('edits a published quote end-to-end via recall → edit → re-publish', async () => {
      const quoteId = seedPublishedQuote();

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(QUOTES_ENTITY_ID);

      const file: ConnectorFile = {
        id: quoteId,
        properties: { hs_title: 'Q1', hs_terms: 'New terms', hs_status: 'APPROVAL_NOT_NEEDED' },
      } as unknown as ConnectorFile;

      const [result] = await connector.updateRecords(spec, [file], [{ properties: { hs_terms: true } }]);

      // The edit landed AND the quote is back to published (re-locked) — proving the
      // recall → edit → re-publish dance ran against a fake that rejects locked edits.
      const stored = store.getRecord('quotes', quoteId);
      expect(stored?.properties.hs_terms).toBe('New terms');
      expect(stored?.properties.hs_status).toBe('APPROVAL_NOT_NEEDED');
      expect(stored?.properties.hs_locked).toBe('true');

      // The returned ConnectorFile mirrors a fresh pull of the re-published quote.
      const props = (result as unknown as { properties: Record<string, string> }).properties;
      expect(props.hs_terms).toBe('New terms');
      expect(props.hs_status).toBe('APPROVAL_NOT_NEEDED');
    });

    it('edits a published quote via a full publish (hs_status in the payload) — converges without a re-lock mid-window', async () => {
      const quoteId = seedPublishedQuote();

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(QUOTES_ENTITY_ID);

      // Full publish (no changedFields) sends the whole writable payload, which
      // includes hs_status. The dance strips hs_status from the content PATCH, so
      // that edit runs while the quote is still DRAFT (never re-locking it); the
      // only re-lock is the final status step. The quote must still converge to
      // its published state with the edited terms.
      const file: ConnectorFile = {
        id: quoteId,
        properties: { hs_title: 'Q1', hs_terms: 'Full-publish terms', hs_status: 'APPROVAL_NOT_NEEDED' },
      } as unknown as ConnectorFile;

      await connector.updateRecords(spec, [file]);

      const stored = store.getRecord('quotes', quoteId);
      expect(stored?.properties.hs_terms).toBe('Full-publish terms');
      expect(stored?.properties.hs_status).toBe('APPROVAL_NOT_NEEDED');
      expect(stored?.properties.hs_locked).toBe('true');
    });

    it('edits a published quote AND adds an association in one recall window, ending re-published', async () => {
      const deal = store.addRecord('deals', { dealname: 'D1' });
      const quoteId = seedPublishedQuote();

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(QUOTES_ENTITY_ID);

      // Deep changedFields touching BOTH a property and associations — the exact
      // shape the desktop grid publishes when a user edits Terms and links a deal.
      const desiredAssociations = { deals: { results: [{ id: deal.id }] } };
      const file: ConnectorFile = {
        id: quoteId,
        properties: { hs_title: 'Q1', hs_terms: 'New terms', hs_status: 'APPROVAL_NOT_NEEDED' },
        associations: desiredAssociations,
      } as unknown as ConnectorFile;

      await connector.updateRecords(
        spec,
        [file],
        [{ properties: { hs_terms: true }, associations: desiredAssociations }],
      );

      const stored = store.getRecord('quotes', quoteId);
      expect(stored?.properties.hs_terms).toBe('New terms');
      expect(stored?.properties.hs_status).toBe('APPROVAL_NOT_NEEDED');
      expect(stored?.properties.hs_locked).toBe('true');
      expect(stored?.associations?.deals?.results.map((r) => r.id)).toContain(deal.id);
    });

    it('refuses to publish an e-sign quote and leaves it published (never recalls it) — DEV-10902', async () => {
      // Our association sync can't round-trip HubSpot's "Signer" labeled
      // association, so recalling/re-publishing an e-sign quote would strip its
      // signers and leave it unpublished. The guard must refuse before recalling.
      const quote = store.addRecord('quotes', {
        hs_title: 'Q1',
        hs_terms: 'Old terms',
        hs_status: 'APPROVAL_NOT_NEEDED',
        hs_esign_enabled: 'true',
      });
      expect(store.getRecord('quotes', quote.id)?.properties.hs_locked).toBe('true');

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(QUOTES_ENTITY_ID);

      const file: ConnectorFile = {
        id: quote.id,
        properties: { hs_title: 'Q1', hs_terms: 'New terms', hs_status: 'APPROVAL_NOT_NEEDED' },
      } as unknown as ConnectorFile;

      await expect(connector.updateRecords(spec, [file], [{ properties: { hs_terms: true } }])).rejects.toThrow(
        /e-signature|signer/i,
      );

      // The live quote is untouched: still published/locked, terms unchanged — it
      // was never recalled to DRAFT.
      const stored = store.getRecord('quotes', quote.id);
      expect(stored?.properties.hs_terms).toBe('Old terms');
      expect(stored?.properties.hs_status).toBe('APPROVAL_NOT_NEEDED');
      expect(stored?.properties.hs_locked).toBe('true');
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

  // ─── Batched publishing (DEV-10200, HUBSPOT_BATCH_PUBLISH) ──────────────────
  //
  // With the flag on, a publish batch of N records of one object type goes out
  // as ONE batch/create (or batch/update) call, then ONE association call per
  // association type carrying every record's links. The fake logs every batch
  // request (`store.batchRequestLog`) so these cases assert HOW the records
  // were published, not only the end state.
  describe('batched publishing (DEV-10200, HUBSPOT_BATCH_PUBLISH)', () => {
    type BatchBody = { inputs: Record<string, unknown>[] };

    function createBatchConnector(associationsApiVersion: '2026-03' | 'v4' = '2026-03'): HubspotConnector {
      return new HubspotConnector('fake-test-token', { batchPublish: true, associationsApiVersion });
    }

    function batchRequestsTo(pathFragment: string): { path: string; body: BatchBody }[] {
      return store.batchRequestLog.filter((request) => request.path.includes(pathFragment)) as {
        path: string;
        body: BatchBody;
      }[];
    }

    function contactFile(email: string, companyIds: string[] = [], dealIds: string[] = []): ConnectorFile {
      return {
        properties: { email, firstname: email.split('@')[0] },
        associations: {
          companies: { results: companyIds.map((id) => ({ id, type: 'contact_to_company' })) },
          deals: { results: dealIds.map((id) => ({ id, type: 'contact_to_deal' })) },
        },
      } as unknown as ConnectorFile;
    }

    function asRecord(file: ConnectorFile): HubspotRecord {
      return file as unknown as HubspotRecord;
    }

    async function captureError<T extends Error>(
      promise: Promise<unknown>,
      errorClass: new (...args: never[]) => T,
    ): Promise<T> {
      try {
        await promise;
      } catch (error) {
        if (error instanceof errorClass) return error;
        throw error;
      }
      throw new Error(`Expected the promise to reject with ${errorClass.name}`);
    }

    it('sends a unique chunk-local objectWriteTraceId per input and binds each created record to its file by the echoed trace id', async () => {
      const connector = createBatchConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      // Identical properties: nothing but the echoed trace id can tell the records apart.
      const files = Array.from(
        { length: 3 },
        () => ({ properties: { firstname: 'Twin' } }) as unknown as ConnectorFile,
      );

      const created = await connector.createRecords(spec, files);

      const [createRequest] = batchRequestsTo('/batch/create');
      expect(createRequest.body.inputs.map((input) => input.objectWriteTraceId)).toEqual(['0', '1', '2']);
      const echoedTraceIds = new Set(
        created.map((file) => (file as unknown as { objectWriteTraceId?: string }).objectWriteTraceId),
      );
      // The refetched files never carry the transport-only trace id.
      expect([...echoedTraceIds]).toEqual([undefined]);
      expect(new Set(created.map((file) => asRecord(file).id)).size).toBe(3);
    });

    it('falls back to binding created records by their echoed property values when the results carry no trace id', async () => {
      store.omitObjectWriteTraceIdFromBatchResults = true;
      const connector = createBatchConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const files = Array.from({ length: 4 }, (_, index) => contactFile(`no-trace-${index}@example.com`));

      const created = await connector.createRecords(spec, files);

      const [createRequest] = batchRequestsTo('/batch/create');
      expect(createRequest.body.inputs).toHaveLength(4);
      created.forEach((file, index) => {
        expect(asRecord(file).properties.email).toBe(`no-trace-${index}@example.com`);
        expect(store.getRecord('contacts', asRecord(file).id)?.properties.email).toBe(`no-trace-${index}@example.com`);
      });
    });

    it('creates 10 contacts in ONE batch/create call, then flushes their links in ONE call per association type', async () => {
      const companyA = store.addRecord('companies', { name: 'A' });
      const companyB = store.addRecord('companies', { name: 'B' });
      const deal = store.addRecord('deals', { dealname: 'D' });
      const connector = createBatchConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files = Array.from({ length: 10 }, (_, index) =>
        contactFile(`batch${index}@example.com`, index % 2 === 0 ? [companyA.id, companyB.id] : [companyA.id], [
          deal.id,
        ]),
      );
      const created = await connector.createRecords(spec, files);

      expect(created).toHaveLength(10);
      created.forEach((file, index) => {
        expect(asRecord(file).id).toBeDefined();
        expect(asRecord(file).properties.email).toBe(`batch${index}@example.com`);
      });

      const createCalls = batchRequestsTo('/crm/v3/objects/contacts/batch/create');
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].body.inputs.map((input) => input.objectWriteTraceId)).toEqual(
        Array.from({ length: 10 }, (_, index) => String(index)),
      );
      expect(store.batchRequestLog.filter((r) => r.path.includes('/batch/update'))).toHaveLength(0);

      const companyLinkCalls = batchRequestsTo('/crm/associations/2026-03/contacts/companies/batch/associate/default');
      expect(companyLinkCalls).toHaveLength(1);
      expect(companyLinkCalls[0].body.inputs).toHaveLength(15); // 5×2 + 5×1
      const dealLinkCalls = batchRequestsTo('/crm/associations/2026-03/contacts/deals/batch/associate/default');
      expect(dealLinkCalls).toHaveLength(1);
      expect(dealLinkCalls[0].body.inputs).toHaveLength(10);
      expect(batchRequestsTo('/batch/archive')).toHaveLength(0);

      // End state in HubSpot AND on the returned (refetched) files.
      const firstStored = store.getRecord('contacts', asRecord(created[0]).id);
      expect(firstStored?.associations?.companies?.results.map((a) => a.id).sort()).toEqual(
        [companyA.id, companyB.id].sort(),
      );
      expect(firstStored?.associations?.deals?.results.map((a) => a.id)).toEqual([deal.id]);
      expect(asRecord(created[1]).associations?.companies?.results.map((a) => a.id)).toEqual([companyA.id]);
    });

    it('partial failure: reports the created ids and the rejected input, and a lone retry of the rejected one creates nothing extra', async () => {
      store.rejectBatchInputsWhere('contacts', 'email', 'bad@example.com', {
        message: 'Email address bad@example.com is invalid',
      });
      const connector = createBatchConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const files = [
        contactFile('good1@example.com'),
        contactFile('bad@example.com'),
        contactFile('good2@example.com'),
      ];

      const error = await captureError(connector.createRecords(spec, files), PartialBatchCreateError);

      expect([...error.createdRecordsByInputIndex.keys()]).toEqual([0, 2]);
      expect(asRecord(error.createdRecordsByInputIndex.get(0) as ConnectorFile).properties.email).toBe(
        'good1@example.com',
      );
      expect(asRecord(error.createdRecordsByInputIndex.get(2) as ConnectorFile).properties.email).toBe(
        'good2@example.com',
      );
      expect([...error.failureMessagesByInputIndex.keys()]).toEqual([1]);
      expect(error.failureMessagesByInputIndex.get(1)).toContain('is invalid');
      expect(error.userFriendlyMessage).toContain('record #2');
      expect(store.listRecords('contacts')).toHaveLength(2);
      expect(batchRequestsTo('/batch/create')).toHaveLength(1);

      // The runner retries ONLY the rejected record. With nothing created in
      // that call, it is a plain HubSpot error (not a partial one) and no
      // duplicate appears.
      await expect(connector.createRecords(spec, [files[1]])).rejects.toThrow(/rejected 1 of 1 record create/);
      expect(store.listRecords('contacts')).toHaveLength(2);
    });

    it('created but unlinked: a rejected association pair archives that record and reports it as failed, naming the pair', async () => {
      const company = store.addRecord('companies', { name: 'Real' });
      const connector = createBatchConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const files = [contactFile('ok@example.com', [company.id]), contactFile('dangling@example.com', ['999'])];

      const error = await captureError(connector.createRecords(spec, files), PartialBatchCreateError);

      expect([...error.createdRecordsByInputIndex.keys()]).toEqual([0]);
      expect([...error.failureMessagesByInputIndex.keys()]).toEqual([1]);
      expect(error.failureMessagesByInputIndex.get(1)).toMatch(/contacts\/\d+ → companies\/999/);
      // Only the linked record remains; the dangling one was archived so a retry re-creates it cleanly.
      const remaining = store.listRecords('contacts');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].properties.email).toBe('ok@example.com');
      expect(remaining[0].associations?.companies?.results.map((a) => a.id)).toEqual([company.id]);
    });

    it('updates 10 contacts in ONE batch/update call and flushes link adds/removes as ONE associate + ONE archive call', async () => {
      const companyA = store.addRecord('companies', { name: 'A' });
      const companyB = store.addRecord('companies', { name: 'B' });
      for (let index = 0; index < 10; index++) {
        const contact = store.addRecord('contacts', { email: `upd${index}@example.com`, firstname: 'Old' });
        store.addAssociation('contacts', contact.id, 'companies', companyA.id);
      }
      const connector = createBatchConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      const files = store.listRecords('contacts').map(
        (record) =>
          ({
            ...record,
            properties: { ...record.properties, firstname: 'Renamed' },
            associations: { companies: { results: [{ id: companyB.id, type: 'contact_to_company' }] } },
          }) as unknown as ConnectorFile,
      );
      const updated = await connector.updateRecords(
        spec,
        files,
        files.map((file) => ({ properties: { firstname: 'Renamed' }, associations: asRecord(file).associations })),
      );

      expect(updated).toHaveLength(10);
      updated.forEach((file) => expect(asRecord(file).properties.firstname).toBe('Renamed'));

      const updateCalls = batchRequestsTo('/crm/v3/objects/contacts/batch/update');
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].body.inputs).toHaveLength(10);
      expect(updateCalls[0].body.inputs[0]).toEqual({
        id: asRecord(files[0]).id,
        objectWriteTraceId: '0',
        properties: { firstname: 'Renamed' },
      });
      const associateCalls = batchRequestsTo('/crm/associations/2026-03/contacts/companies/batch/associate/default');
      expect(associateCalls).toHaveLength(1);
      expect(associateCalls[0].body.inputs).toHaveLength(10);
      const archiveCalls = batchRequestsTo('/crm/associations/2026-03/contacts/companies/batch/archive');
      expect(archiveCalls).toHaveLength(1);
      expect(archiveCalls[0].body.inputs).toHaveLength(10);
      expect(archiveCalls[0].body.inputs[0]).toEqual({
        from: { id: asRecord(files[0]).id },
        to: [{ id: companyA.id }],
      });

      for (const record of store.listRecords('contacts')) {
        expect(record.associations?.companies?.results.map((a) => a.id)).toEqual([companyB.id]);
      }
    });

    it('surfaces a rejected association write on update instead of swallowing it (batch on, 2026-03)', async () => {
      const contact = store.addRecord('contacts', { email: 'link@example.com' });
      const connector = createBatchConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const desiredAssociations = { companies: { results: [{ id: '999' }] } };

      const error = await captureError(
        connector.updateRecords(
          spec,
          [{ ...contact, associations: desiredAssociations } as unknown as ConnectorFile],
          [{ associations: desiredAssociations }],
        ),
        HubspotAssociationWriteError,
      );
      expect(error.message).toMatch(new RegExp(`contacts/${contact.id} → companies/999`));
      expect(error.failedPairs).toEqual([
        expect.objectContaining({ fromId: contact.id, toId: '999', toObjectType: 'companies' }),
      ]);
    });

    it('surfaces a rejected association write through per-pair calls when v4 is still selected (batch on, no 2026-03)', async () => {
      const contact = store.addRecord('contacts', { email: 'v4@example.com' });
      const connector = createBatchConnector('v4');
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const desiredAssociations = { companies: { results: [{ id: '999' }] } };

      await expect(
        connector.updateRecords(
          spec,
          [{ ...contact, associations: desiredAssociations } as unknown as ConnectorFile],
          [{ associations: desiredAssociations }],
        ),
      ).rejects.toThrow(new RegExp(`contacts/${contact.id} → companies/999`));
      expect(batchRequestsTo('/crm/associations/2026-03')).toHaveLength(0);
    });

    it('keeps swallowing a rejected association write when the flag is off (legacy behavior, unchanged)', async () => {
      const contact = store.addRecord('contacts', { email: 'legacy@example.com' });
      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);
      const desiredAssociations = { companies: { results: [{ id: '999' }] } };

      await expect(
        connector.updateRecords(
          spec,
          [{ ...contact, associations: desiredAssociations } as unknown as ConnectorFile],
          [{ associations: desiredAssociations }],
        ),
      ).resolves.toHaveLength(1);
      expect(store.batchRequestLog).toHaveLength(0);
    });

    it('never batches quotes: with the flag on, quotes still publish one call at a time (recall window is per record)', async () => {
      store.addRecord('quotes', { hs_title: 'Q1', hs_status: 'DRAFT' });
      store.addRecord('quotes', { hs_title: 'Q2', hs_status: 'DRAFT' });
      const connector = createBatchConnector();
      const spec = await connector.fetchJsonTableSpec(QUOTES_ENTITY_ID);

      const files = store
        .listRecords('quotes')
        .map(
          (record) =>
            ({ ...record, properties: { ...record.properties, hs_terms: 'Net 30' } }) as unknown as ConnectorFile,
        );
      const updated = await connector.updateRecords(
        spec,
        files,
        files.map(() => ({ properties: { hs_terms: 'Net 30' } })),
      );
      expect(updated).toHaveLength(2);
      expect(store.listRecords('quotes').map((record) => record.properties.hs_terms)).toEqual(['Net 30', 'Net 30']);

      const created = await connector.createRecords(spec, [
        { properties: { hs_title: 'Q3', hs_status: 'DRAFT' } } as unknown as ConnectorFile,
        { properties: { hs_title: 'Q4', hs_status: 'DRAFT' } } as unknown as ConnectorFile,
      ]);
      expect(created).toHaveLength(2);
      expect(store.listRecords('quotes')).toHaveLength(4);

      expect(store.batchRequestLog).toHaveLength(0);
    });
  });

  describe('getBatchSize', () => {
    it('returns 1 for every operation when HUBSPOT_BATCH_PUBLISH is off (the default)', () => {
      const connector = createConnector();
      expect(connector.getBatchSize('create')).toBe(1);
      expect(connector.getBatchSize('update')).toBe(1);
      expect(connector.getBatchSize('delete')).toBe(1);
    });

    it('returns 10 for create/update and 1 for delete when HUBSPOT_BATCH_PUBLISH is on', () => {
      const connector = new HubspotConnector('fake-test-token', { batchPublish: true });
      expect(connector.getBatchSize('create')).toBe(10);
      expect(connector.getBatchSize('update')).toBe(10);
      expect(connector.getBatchSize('delete')).toBe(1);
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
