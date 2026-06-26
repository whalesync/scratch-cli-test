import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY, X_SCRATCH_REMOTE_FIELD_ID } from '@spinner/shared-types';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';
import { HubspotConnector } from '../hubspot-connector';
import companiesSchemaFixture from './__fixtures__/companies-schema.fixture.json';

jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'HubSpot'),
}));

const mockGetProperties = jest.fn();
const mockUpdateRecord = jest.fn();
const mockCreateRecord = jest.fn();
const mockGetRecord = jest.fn();
const mockDeleteRecord = jest.fn();
const mockListRecords = jest.fn();
const mockTestConnection = jest.fn();
const mockGetApiQuota = jest.fn();
const mockGetCustomObjectSchemas = jest.fn();

jest.mock('../hubspot-api-client', () => {
  return {
    HubspotApiClient: jest.fn().mockImplementation(() => ({
      getProperties: mockGetProperties,
      updateRecord: mockUpdateRecord,
      createRecord: mockCreateRecord,
      getRecord: mockGetRecord,
      deleteRecord: mockDeleteRecord,
      listRecords: mockListRecords,
      testConnection: mockTestConnection,
      getApiQuota: mockGetApiQuota,
      getCustomObjectSchemas: mockGetCustomObjectSchemas,
    })),
    HubspotError: class HubspotError extends Error {
      statusCode?: number;
      constructor(message: string, statusCode?: number) {
        super(message);
        this.name = 'HubspotError';
        this.statusCode = statusCode;
      }
    },
  };
});

/**
 * Build a table spec whose schema mirrors what buildHubspotJsonTableSpec produces:
 * top-level object with a nested `properties` object, where each property carries
 * the READONLY_FLAG annotation when readonly.
 */
function buildTableSpec(objectType: string, propertyDefs: Record<string, { readonly?: boolean }>): BaseJsonTableSpec {
  const propertiesSchema: Record<string, TSchema> = {};
  for (const [name, cfg] of Object.entries(propertyDefs)) {
    const annotations: Record<string, unknown> = {
      description: name,
      [X_SCRATCH_REMOTE_FIELD_ID]: name,
      [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'hubspot/string',
    };
    if (cfg.readonly) annotations[X_SCRATCH_READONLY] = true;
    propertiesSchema[name] = Type.Union([Type.String(), Type.Null()], annotations);
  }

  const schema = Type.Object({
    id: Type.String({ [X_SCRATCH_READONLY]: true }),
    properties: Type.Object(propertiesSchema, { description: 'HubSpot properties' }),
    createdAt: Type.String({ [X_SCRATCH_READONLY]: true }),
    updatedAt: Type.String({ [X_SCRATCH_READONLY]: true }),
    archived: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
  });

  return {
    id: { wsId: objectType, remoteId: [objectType] },
    slug: objectType,
    name: objectType,
    schema,
    idPath: dotPath('id'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

function makeFile(id: string, properties: Record<string, unknown>): ConnectorFile {
  return {
    id,
    properties,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    archived: false,
  };
}

describe('HubspotConnector', () => {
  let connector: HubspotConnector;
  // Use a custom object type not present in ASSOCIATIONS_BY_OBJECT_TYPE so
  // updateRecords doesn't attempt to sync associations.
  const OBJECT_TYPE = 'p123_widgets';

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new HubspotConnector('test-token');
    // Seed getProperties so getPropertyNames resolves without hitting the API.
    mockGetProperties.mockResolvedValue([]);
  });

  describe('extractWritableProperties (via updateRecords without changedFields)', () => {
    it('sends only properties that are not flagged readonly in the schema', async () => {
      const tableSpec = buildTableSpec(OBJECT_TYPE, {
        name: {},
        email: {},
        hs_object_id: { readonly: true },
        createdate: { readonly: true },
        hs_lifecyclestage_lead_date: { readonly: true },
      });

      const file = makeFile('42', {
        name: 'Acme',
        email: 'a@b.com',
        hs_object_id: '42',
        createdate: '2024-01-01T00:00:00Z',
        hs_lifecyclestage_lead_date: '2024-01-05T00:00:00Z',
      });

      await connector.updateRecords(tableSpec, [file]);

      expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
      expect(mockUpdateRecord).toHaveBeenCalledWith(OBJECT_TYPE, '42', {
        name: 'Acme',
        email: 'a@b.com',
      });
    });

    it('does not call updateRecord when every property is readonly', async () => {
      const tableSpec = buildTableSpec(OBJECT_TYPE, {
        hs_object_id: { readonly: true },
        createdate: { readonly: true },
      });

      const file = makeFile('1', {
        hs_object_id: '1',
        createdate: '2024-01-01T00:00:00Z',
      });

      await connector.updateRecords(tableSpec, [file]);

      expect(mockUpdateRecord).not.toHaveBeenCalled();
    });

    it('does not call updateRecord when the file has no properties', async () => {
      const tableSpec = buildTableSpec(OBJECT_TYPE, { name: {} });

      const file: ConnectorFile = { id: '7' };

      await connector.updateRecords(tableSpec, [file]);

      expect(mockUpdateRecord).not.toHaveBeenCalled();
    });

    it('treats properties missing from the schema as writable (fail-open default)', async () => {
      // If a property isn't in the schema, ValuePointer returns undefined — the
      // connector treats that as writable and forwards it. HubSpot will reject
      // unknown properties; the connector is not the validator.
      const tableSpec = buildTableSpec(OBJECT_TYPE, { name: {} });

      const file = makeFile('3', { name: 'X', unknown_prop: 'Y' });

      await connector.updateRecords(tableSpec, [file]);

      expect(mockUpdateRecord).toHaveBeenCalledWith(OBJECT_TYPE, '3', {
        name: 'X',
        unknown_prop: 'Y',
      });
    });

    it('filters the HubSpot system property names even if the schema omits the readonly flag', async () => {
      // Defense in depth: a stale or malformed schema must not cause us to push
      // hs_object_id/createdate/lastmodifieddate back to HubSpot.
      const tableSpec = buildTableSpec(OBJECT_TYPE, {
        name: {},
        hs_object_id: {},
        hs_object_id_history: {},
        createdate: {},
        lastmodifieddate: {},
      });

      const file = makeFile('11', {
        name: 'Ok',
        hs_object_id: '11',
        hs_object_id_history: 'x',
        createdate: '2024-01-01T00:00:00Z',
        lastmodifieddate: '2024-01-02T00:00:00Z',
      });

      await connector.updateRecords(tableSpec, [file]);

      expect(mockUpdateRecord).toHaveBeenCalledWith(OBJECT_TYPE, '11', { name: 'Ok' });
    });

    it('preserves null values for writable properties', async () => {
      const tableSpec = buildTableSpec(OBJECT_TYPE, {
        name: {},
        phone: {},
      });

      const file = makeFile('9', { name: 'A', phone: null });

      await connector.updateRecords(tableSpec, [file]);

      expect(mockUpdateRecord).toHaveBeenCalledWith(OBJECT_TYPE, '9', {
        name: 'A',
        phone: null,
      });
    });
  });

  describe('updateRecords with deep changedFields', () => {
    // DEV-10597: a read-only property in the sparse changedFields means the user
    // genuinely edited it. Silently stripping it (the old behavior) discarded the
    // edit while reporting success — surface it loudly instead.
    it('throws when a read-only property is among the changed properties (does not silently send only the writable)', async () => {
      const tableSpec = buildTableSpec(OBJECT_TYPE, {
        name: {},
        hs_object_id: { readonly: true },
      });

      const file = makeFile('5', { name: 'New Name', hs_object_id: '5' });

      await expect(
        connector.updateRecords(tableSpec, [file], [{ properties: { name: true, hs_object_id: true } }]),
      ).rejects.toThrow(/read-only and cannot be published/);
      expect(mockUpdateRecord).not.toHaveBeenCalled();
    });

    it('throws when every changed property is read-only', async () => {
      const tableSpec = buildTableSpec(OBJECT_TYPE, {
        hs_object_id: { readonly: true },
      });

      const file = makeFile('5', { hs_object_id: '5' });

      await expect(
        connector.updateRecords(tableSpec, [file], [{ properties: { hs_object_id: true } }]),
      ).rejects.toThrow(/"hs_object_id" is read-only/);
      expect(mockUpdateRecord).not.toHaveBeenCalled();
    });
  });

  describe('post-write refetch', () => {
    it('returns the refetched record (not the input) when properties were updated', async () => {
      const tableSpec = buildTableSpec(OBJECT_TYPE, { name: {}, email: {} });
      const file = makeFile('77', { name: 'Old', email: 'old@b.com' });

      // The refetch GET returns the server-canonical row — server-normalized
      // values, default-set timestamps. updateRecords must surface this, not
      // the input, so the post-publish commit is byte-equal to a fresh pull.
      mockGetRecord.mockResolvedValueOnce({
        id: '77',
        properties: {
          name: 'New from server',
          email: 'old@b.com',
          hs_lastmodifieddate: '2026-06-01T18:00:00Z',
        },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2026-06-01T18:00:00Z',
        archived: false,
      });

      const [result] = await connector.updateRecords(tableSpec, [file], [{ properties: { name: true } }]);

      expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
      expect(mockGetRecord).toHaveBeenCalledWith(OBJECT_TYPE, '77', expect.any(Array), expect.any(Array));
      expect((result as { properties: Record<string, unknown> }).properties.name).toBe('New from server');
      expect((result as { properties: Record<string, unknown> }).properties.hs_lastmodifieddate).toBe(
        '2026-06-01T18:00:00Z',
      );
    });

    it('returns the input verbatim when no write fired (empty changeset, no-op)', async () => {
      const tableSpec = buildTableSpec(OBJECT_TYPE, { name: {} });
      const file = makeFile('99', { name: 'Acme' });

      // Empty deep changeset — no property and no association changes → no PATCH.
      const result = await connector.updateRecords(tableSpec, [file], [{}]);

      expect(mockUpdateRecord).not.toHaveBeenCalled();
      // No write → no refetch. The input file is already canonical.
      expect(mockGetRecord).not.toHaveBeenCalled();
      expect(result[0]).toBe(file);
    });

    it('falls back to the input file when the refetch GET returns undefined', async () => {
      const tableSpec = buildTableSpec(OBJECT_TYPE, { name: {} });
      const file = makeFile('42', { name: 'Acme' });

      // Concurrent delete: write succeeds, refetch returns undefined.
      mockGetRecord.mockResolvedValueOnce(undefined);

      const [result] = await connector.updateRecords(tableSpec, [file], [{ properties: { name: true } }]);

      expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
      expect(result).toBe(file);
    });
  });

  // Fixture-backed test using a realistic companies schema shape (raw JSON, the
  // form the spec takes once persisted). Exercises the full serialized schema
  // surface — anyOf: [string, null], x-scratch-readonly annotations on both
  // HubSpot-calculated and user-editable fields, and the tricky
  // hs_lastmodifieddate case whose `hs_` prefix doesn't match the hardcoded
  // `hs_object_id*` guard and so relies entirely on the schema flag.
  describe('extractWritableProperties against a realistic companies schema', () => {
    beforeEach(() => {
      // Short-circuit the association sync branch: `companies` is in
      // ASSOCIATIONS_BY_OBJECT_TYPE, so updateRecords fetches the current
      // record; returning undefined makes the diff a no-op.
      mockGetRecord.mockResolvedValue(undefined);
    });

    it('sends only the user-editable properties from the fixture schema', async () => {
      const tableSpec = companiesSchemaFixture as unknown as BaseJsonTableSpec;

      const file = makeFile('42', {
        // Writable
        name: 'Acme Corp',
        domain: 'acme.com',
        phone: '555-0100',
        description: 'Makes anvils',
        city: 'NYC',
        industry: 'Manufacturing',
        website: 'https://acme.com',
        lifecyclestage: 'customer',
        // HubSpot-calculated (readonly in schema)
        days_to_close: '12',
        hs_analytics_num_page_views: '42',
        hs_last_sales_activity_timestamp: '2024-02-01T00:00:00Z',
        num_associated_deals: '3',
        // System fields (readonly in schema; some also caught by hardcoded guard)
        createdate: '2024-01-01T00:00:00Z',
        hs_object_id: '42',
        hs_lastmodifieddate: '2024-01-02T00:00:00Z',
      });

      await connector.updateRecords(tableSpec, [file]);

      expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
      expect(mockUpdateRecord).toHaveBeenCalledWith('companies', '42', {
        name: 'Acme Corp',
        domain: 'acme.com',
        phone: '555-0100',
        description: 'Makes anvils',
        city: 'NYC',
        industry: 'Manufacturing',
        website: 'https://acme.com',
        lifecyclestage: 'customer',
      });
    });

    it('relies on the schema flag (not the hardcoded guard) to strip hs_lastmodifieddate', async () => {
      // hs_lastmodifieddate has the hs_ prefix but isn't hs_object_id*, so the
      // hardcoded fallback does NOT match it. This test pins the expectation
      // that the schema-based check is what keeps it out of the payload.
      const tableSpec = companiesSchemaFixture as unknown as BaseJsonTableSpec;

      const file = makeFile('99', {
        name: 'Only writable',
        hs_lastmodifieddate: '2024-06-06T00:00:00Z',
      });

      await connector.updateRecords(tableSpec, [file]);

      expect(mockUpdateRecord).toHaveBeenCalledWith('companies', '99', { name: 'Only writable' });
    });
  });
});
