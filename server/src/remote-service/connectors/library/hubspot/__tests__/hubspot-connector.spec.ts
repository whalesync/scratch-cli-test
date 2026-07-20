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
const mockCreateAssociation = jest.fn();
const mockDeleteAssociation = jest.fn();

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
      createAssociation: mockCreateAssociation,
      deleteAssociation: mockDeleteAssociation,
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

  // Association WRITE path (DEV-10847). `contacts` has associations
  // (ASSOCIATIONS_BY_OBJECT_TYPE), so updateRecords fetches the current remote
  // associations, diffs them against the file's desired `associations`, and
  // creates the added ids / deletes the removed ones via the v4 API. This is what
  // the now-editable "Associated X" grid column publishes.
  describe('association sync (updateRecords diffs desired vs current)', () => {
    const CONTACTS = 'contacts';

    function fileWithAssociations(id: string, companyIds: string[]): ConnectorFile {
      return {
        ...makeFile(id, {}),
        associations: { companies: { results: companyIds.map((cid) => ({ id: cid })) } },
      };
    }

    it('creates the added association and deletes the removed one', async () => {
      const tableSpec = buildTableSpec(CONTACTS, { firstname: {} });
      // Current remote state: linked to company C1. Returned for both the diff
      // fetch and the post-write refetch.
      mockGetRecord.mockResolvedValue({
        id: '42',
        properties: {},
        associations: { companies: { results: [{ id: 'C1', type: 'contact_to_company' }] } },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        archived: false,
      });

      // Desired: drop C1, add C2.
      const file = fileWithAssociations('42', ['C2']);
      await connector.updateRecords(tableSpec, [file], [{ associations: file.associations }]);

      expect(mockCreateAssociation).toHaveBeenCalledTimes(1);
      expect(mockCreateAssociation).toHaveBeenCalledWith(CONTACTS, '42', 'companies', 'C2');
      expect(mockDeleteAssociation).toHaveBeenCalledTimes(1);
      expect(mockDeleteAssociation).toHaveBeenCalledWith(CONTACTS, '42', 'companies', 'C1');
      // Association-only changeset → no property PATCH.
      expect(mockUpdateRecord).not.toHaveBeenCalled();
    });

    it('makes no v4 calls when desired associations equal current (no-op)', async () => {
      const tableSpec = buildTableSpec(CONTACTS, { firstname: {} });
      mockGetRecord.mockResolvedValue({
        id: '7',
        properties: {},
        associations: { companies: { results: [{ id: 'C1', type: 'contact_to_company' }] } },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        archived: false,
      });

      // Desired matches current (the packed edit drops `type`, but the diff is by id).
      const file = fileWithAssociations('7', ['C1']);
      await connector.updateRecords(tableSpec, [file], [{ associations: file.associations }]);

      expect(mockCreateAssociation).not.toHaveBeenCalled();
      expect(mockDeleteAssociation).not.toHaveBeenCalled();
    });

    it('deletes every association when the edited list is emptied', async () => {
      const tableSpec = buildTableSpec(CONTACTS, { firstname: {} });
      mockGetRecord.mockResolvedValue({
        id: '9',
        properties: {},
        associations: { companies: { results: [{ id: 'C1' }, { id: 'C2' }] } },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        archived: false,
      });

      // Desired: cleared list — the "clear all links" edit.
      const file = fileWithAssociations('9', []);
      await connector.updateRecords(tableSpec, [file], [{ associations: file.associations }]);

      expect(mockCreateAssociation).not.toHaveBeenCalled();
      expect(mockDeleteAssociation).toHaveBeenCalledTimes(2);
      expect(mockDeleteAssociation).toHaveBeenCalledWith(CONTACTS, '9', 'companies', 'C1');
      expect(mockDeleteAssociation).toHaveBeenCalledWith(CONTACTS, '9', 'companies', 'C2');
    });
  });

  // Published-quote recall → edit → re-publish (DEV-10886). HubSpot locks a
  // published quote and rejects the property PATCH with "Published Quote cannot
  // be edited". The `quotes` branch of updateRecords must recall it to DRAFT,
  // apply the edit, then re-publish to the record's on-disk status.
  describe('published-quote recall (updateRecords quotes branch)', () => {
    const QUOTES = 'quotes';

    function quotesSpec(): BaseJsonTableSpec {
      return buildTableSpec(QUOTES, {
        hs_title: {},
        hs_terms: {},
        hs_status: {},
        hs_locked: { readonly: true },
      });
    }

    /** A locked/published quote as the live GET returns it. */
    function publishedQuoteRemote(overrides: Record<string, string> = {}) {
      return {
        id: '900',
        properties: {
          hs_title: 'Q1',
          hs_terms: 'Old terms',
          hs_status: 'APPROVAL_NOT_NEEDED',
          hs_locked: 'true',
          ...overrides,
        },
        associations: {},
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        archived: false,
      };
    }

    /** Minimal axios-shaped error so the connector's isAxiosError()/status checks fire. */
    function axiosErrorWithStatus(status: number, data: unknown = {}): Error {
      return Object.assign(new Error(`Request failed with status ${status}`), {
        isAxiosError: true,
        response: { status, data },
      });
    }

    it('recalls a published quote, applies the edit, then re-publishes to the on-disk status', async () => {
      const spec = quotesSpec();
      // Pre-edit GET returns the locked/published quote; Phase-2 refetch returns
      // the re-published, edited quote.
      mockGetRecord
        .mockResolvedValueOnce(publishedQuoteRemote())
        .mockResolvedValueOnce(publishedQuoteRemote({ hs_terms: 'New terms' }));

      const file = makeFile('900', {
        hs_title: 'Q1',
        hs_terms: 'New terms',
        hs_status: 'APPROVAL_NOT_NEEDED',
        hs_locked: 'true',
      });

      const [result] = await connector.updateRecords(spec, [file], [{ properties: { hs_terms: true } }]);

      // Three PATCHes, in order: recall → edit → re-publish.
      expect(mockUpdateRecord.mock.calls).toEqual([
        [QUOTES, '900', { hs_status: 'DRAFT' }],
        [QUOTES, '900', { hs_terms: 'New terms' }],
        [QUOTES, '900', { hs_status: 'APPROVAL_NOT_NEEDED' }],
      ]);
      // Returned record is the refetched (re-published, edited) one.
      expect((result as { properties: Record<string, unknown> }).properties.hs_terms).toBe('New terms');
      expect((result as { properties: Record<string, unknown> }).properties.hs_status).toBe('APPROVAL_NOT_NEEDED');
    });

    it('edits a draft (unlocked) quote directly — no recall, no re-publish', async () => {
      const spec = quotesSpec();
      mockGetRecord
        .mockResolvedValueOnce(publishedQuoteRemote({ hs_status: 'DRAFT', hs_locked: 'false' }))
        .mockResolvedValueOnce(publishedQuoteRemote({ hs_status: 'DRAFT', hs_locked: 'false', hs_terms: 'New terms' }));

      const file = makeFile('900', { hs_terms: 'New terms', hs_status: 'DRAFT' });

      await connector.updateRecords(spec, [file], [{ properties: { hs_terms: true } }]);

      // Only the edit PATCH — no hs_status transitions.
      expect(mockUpdateRecord.mock.calls).toEqual([[QUOTES, '900', { hs_terms: 'New terms' }]]);
    });

    it('surfaces a clear error and does not edit when the quote is signed/paid (recall refused)', async () => {
      const spec = quotesSpec();
      mockGetRecord.mockResolvedValueOnce(publishedQuoteRemote());
      // HubSpot refuses to recall a signed/paid quote.
      mockUpdateRecord.mockRejectedValueOnce(
        axiosErrorWithStatus(400, { message: 'Quote cannot be recalled', category: 'VALIDATION_ERROR' }),
      );

      const file = makeFile('900', { hs_terms: 'New terms', hs_status: 'APPROVAL_NOT_NEEDED' });

      await expect(connector.updateRecords(spec, [file], [{ properties: { hs_terms: true } }])).rejects.toThrow(
        /signed or paid/i,
      );
      // Only the recall was attempted; the edit never fired.
      expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
      expect(mockUpdateRecord).toHaveBeenCalledWith(QUOTES, '900', { hs_status: 'DRAFT' });
    });

    it('lets a 403 (missing quote-write scope) on the recall surface as a scope error, not "signed or paid"', async () => {
      const spec = quotesSpec();
      mockGetRecord.mockResolvedValueOnce(publishedQuoteRemote());
      // A missing scope on the PAT makes the recall PATCH 403 — NOT the 400
      // VALIDATION_ERROR that signals an un-recallable (signed/paid) quote.
      mockUpdateRecord.mockRejectedValueOnce(axiosErrorWithStatus(403, { message: 'missing scope' }));

      const file = makeFile('900', { hs_terms: 'New terms', hs_status: 'APPROVAL_NOT_NEEDED' });

      let caught: unknown;
      try {
        await connector.updateRecords(spec, [file], [{ properties: { hs_terms: true } }]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      // The 403 was NOT rewrapped as the QUOTE_NOT_RECALLABLE "signed or paid" error…
      expect((caught as Error).message).not.toMatch(/signed or paid/i);
      // …it stays a raw axios error so extractConnectorErrorDetails routes it to
      // the dedicated missing-scope message.
      const details = connector.extractConnectorErrorDetails(caught);
      expect(details.userFriendlyMessage).toMatch(/permission|scope/i);
      // Only the recall was attempted; the edit never fired.
      expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
    });

    it('syncs associations inside the recall window — before the final re-publish re-locks (full publish)', async () => {
      const spec = quotesSpec();
      mockGetRecord
        .mockResolvedValueOnce(publishedQuoteRemote())
        .mockResolvedValueOnce(publishedQuoteRemote({ hs_terms: 'New terms' }));

      // Full publish (no changedFields): the payload carries hs_status AND an
      // association add. The dance must NOT let hs_status ride along in the
      // content PATCH (that would re-lock the quote before syncAssociations runs).
      const file: ConnectorFile = {
        ...makeFile('900', { hs_title: 'Q1', hs_terms: 'New terms', hs_status: 'APPROVAL_NOT_NEEDED' }),
        associations: { deals: { results: [{ id: 'D1' }] } },
      };

      await connector.updateRecords(spec, [file]);

      const updateCalls = mockUpdateRecord.mock.calls as unknown as [string, string, Record<string, unknown>][];
      // hs_status is touched ONLY by the recall (first) and the re-publish (last).
      expect(updateCalls[0]).toEqual([QUOTES, '900', { hs_status: 'DRAFT' }]);
      expect(updateCalls[updateCalls.length - 1]).toEqual([QUOTES, '900', { hs_status: 'APPROVAL_NOT_NEEDED' }]);
      // The content PATCH carries no hs_status — so it never re-locks mid-window.
      const contentPatches = updateCalls.filter((call) => !('hs_status' in call[2]));
      expect(contentPatches).toEqual([[QUOTES, '900', { hs_title: 'Q1', hs_terms: 'New terms' }]]);
      // The association write happened strictly before the final re-publish PATCH.
      const republishInvocationOrder =
        mockUpdateRecord.mock.invocationCallOrder[mockUpdateRecord.mock.invocationCallOrder.length - 1];
      expect(mockCreateAssociation).toHaveBeenCalledWith(QUOTES, '900', 'deals', 'D1');
      expect(mockCreateAssociation.mock.invocationCallOrder[0]).toBeLessThan(republishInvocationOrder);
    });

    // E-sign guard (DEV-10886 follow-up / DEV-10902): HubSpot won't publish an
    // e-sign quote without a "Signer" labeled association, and our association
    // sync can't round-trip that label — so recalling/re-publishing an e-sign
    // quote would strip its signers and leave it unpublished. Refuse first.
    it('refuses to publish an e-sign quote before recalling it — the quote is left untouched', async () => {
      const spec = quotesSpec();
      mockGetRecord.mockResolvedValueOnce(publishedQuoteRemote({ hs_esign_enabled: 'true' }));

      const file = makeFile('900', { hs_terms: 'New terms', hs_status: 'APPROVAL_NOT_NEEDED' });

      await expect(connector.updateRecords(spec, [file], [{ properties: { hs_terms: true } }])).rejects.toThrow(
        /e-signature|signer/i,
      );
      // Threw before any write — the live quote is never recalled/unpublished.
      expect(mockUpdateRecord).not.toHaveBeenCalled();
      expect(mockCreateAssociation).not.toHaveBeenCalled();
      expect(mockDeleteAssociation).not.toHaveBeenCalled();
    });

    it('refuses an association sync on an e-sign quote even when it is an unlocked draft', async () => {
      const spec = quotesSpec();
      // Draft (unlocked) e-sign quote — no recall needed — but syncing associations
      // would still drop the signer label, so it's refused before any write.
      mockGetRecord.mockResolvedValueOnce(
        publishedQuoteRemote({ hs_status: 'DRAFT', hs_locked: 'false', hs_esign_enabled: 'true' }),
      );

      const file: ConnectorFile = {
        ...makeFile('900', { hs_status: 'DRAFT' }),
        associations: { contacts: { results: [{ id: 'K1' }] } },
      };

      await expect(connector.updateRecords(spec, [file], [{ associations: file.associations }])).rejects.toThrow(
        /e-signature|signer/i,
      );
      expect(mockUpdateRecord).not.toHaveBeenCalled();
      expect(mockCreateAssociation).not.toHaveBeenCalled();
    });

    it('still allows a property-only edit that keeps an e-sign quote in DRAFT (guard is not blanket)', async () => {
      const spec = quotesSpec();
      // Draft e-sign quote, property-only edit, staying in DRAFT: no recall, no
      // association sync, no re-publish — nothing that could strip a signer.
      mockGetRecord
        .mockResolvedValueOnce(
          publishedQuoteRemote({ hs_status: 'DRAFT', hs_locked: 'false', hs_esign_enabled: 'true' }),
        )
        .mockResolvedValueOnce(
          publishedQuoteRemote({
            hs_status: 'DRAFT',
            hs_locked: 'false',
            hs_esign_enabled: 'true',
            hs_terms: 'New terms',
          }),
        );

      const file = makeFile('900', { hs_terms: 'New terms', hs_status: 'DRAFT' });

      await connector.updateRecords(spec, [file], [{ properties: { hs_terms: true } }]);

      // Only the content edit fired — no hs_status transitions, no error.
      expect(mockUpdateRecord.mock.calls).toEqual([[QUOTES, '900', { hs_terms: 'New terms' }]]);
    });

    it('allows a full publish of a draft e-sign quote when its associations are unchanged (no-op resync)', async () => {
      const spec = quotesSpec();
      // A full publish (no changedFields) always carries the file's associations,
      // but here they match remote by id → syncAssociations is a no-op that leaves
      // the signer untouched. The guard must NOT refuse it just because an
      // association payload is present.
      const draftEsignRemote = {
        ...publishedQuoteRemote({ hs_status: 'DRAFT', hs_locked: 'false', hs_esign_enabled: 'true' }),
        associations: {
          contacts: {
            results: [
              { id: 'K1', type: 'quote_to_contact' },
              { id: 'K1', type: 'quote_to_contact_signer' },
            ],
          },
        },
      };
      mockGetRecord.mockResolvedValueOnce(draftEsignRemote).mockResolvedValueOnce({
        ...draftEsignRemote,
        properties: { ...draftEsignRemote.properties, hs_terms: 'New terms' },
      });

      const file: ConnectorFile = {
        ...makeFile('900', { hs_terms: 'New terms', hs_status: 'DRAFT' }),
        associations: { contacts: { results: [{ id: 'K1' }] } },
      };

      await connector.updateRecords(spec, [file]);

      // The edit went through and no signer-destroying association writes fired.
      expect(mockUpdateRecord.mock.calls).toEqual([[QUOTES, '900', { hs_terms: 'New terms' }]]);
      expect(mockCreateAssociation).not.toHaveBeenCalled();
      expect(mockDeleteAssociation).not.toHaveBeenCalled();
    });

    it('best-effort restores the published status when the edit fails after recall', async () => {
      const spec = quotesSpec();
      mockGetRecord.mockResolvedValueOnce(publishedQuoteRemote());
      mockUpdateRecord
        .mockResolvedValueOnce(undefined) // recall → DRAFT
        .mockRejectedValueOnce(axiosErrorWithStatus(400, { message: 'field invalid' })) // edit fails
        .mockResolvedValueOnce(undefined); // best-effort restore → published

      const file = makeFile('900', { hs_terms: 'New terms', hs_status: 'APPROVAL_NOT_NEEDED' });

      await expect(connector.updateRecords(spec, [file], [{ properties: { hs_terms: true } }])).rejects.toThrow();

      // recall → (failed) edit → restore to the original published status.
      expect(mockUpdateRecord.mock.calls).toEqual([
        [QUOTES, '900', { hs_status: 'DRAFT' }],
        [QUOTES, '900', { hs_terms: 'New terms' }],
        [QUOTES, '900', { hs_status: 'APPROVAL_NOT_NEEDED' }],
      ]);
    });
  });
});
