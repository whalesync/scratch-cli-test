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

import { HubspotApiClient } from 'src/remote-service/connectors/library/hubspot/hubspot-api-client';
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

    it('omits associations on incremental pulls (documented limitation; full pulls still include them)', async () => {
      const contact = store.addRecord('contacts', { email: 'linked@example.com', firstname: 'Linked' });
      const company = store.addRecord('companies', { name: 'Acme Corp' });
      store.addAssociation('contacts', contact.id, 'companies', company.id);
      store.setModifiedAt('contacts', contact.id, NEW_MODIFIED);

      const connector = createConnector();
      const spec = await connector.fetchJsonTableSpec(CONTACTS_ENTITY_ID);

      // Full pull includes associations (baseline)...
      const fullFiles = await collectPulledFiles(connector, spec);
      expect((fullFiles[0] as unknown as { associations?: unknown }).associations).toBeDefined();

      // ...incremental (via Search) does not.
      const { files } = await pullIncremental(connector, spec, SINCE);
      expect(files).toHaveLength(1);
      expect((files[0] as unknown as { associations?: unknown }).associations).toBeUndefined();
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
