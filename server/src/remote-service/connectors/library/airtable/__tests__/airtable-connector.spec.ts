import { TSchema } from '@sinclair/typebox';
import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { BaseJsonTableSpec, ConnectorFile, PullRecordFilesOptions, idPath } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Airtable'),
}));

const mockUpdateRecords = jest.fn();
const mockListBases = jest.fn();
const mockCreateRecords = jest.fn();
const mockDeleteRecords = jest.fn();
const mockListRecords = jest.fn();
const mockCreateTable = jest.fn();
const mockCreateField = jest.fn();

jest.mock('../airtable-api-client', () => ({
  AirtableApiClient: jest.fn().mockImplementation(() => ({
    listBases: mockListBases,
    createRecords: mockCreateRecords,
    updateRecords: mockUpdateRecords,
    deleteRecords: mockDeleteRecords,
    listRecords: mockListRecords,
    createTable: mockCreateTable,
    createField: mockCreateField,
  })),
}));

import {
  type NormalizedCreateFieldsPlan,
  type NormalizedCreateTablePlan,
  type ResolvedCreateFieldSpec,
} from '../../../schema-creation.types';
import { AirtableConnector } from '../airtable-connector';
import { AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS } from '../airtable-incremental';

// Schema that marks `Date/heure de création` as read-only — same shape used in prod
// (per DEV-10125 repro). `isReadonlyField` walks /properties/fields/properties/<name>/x-scratch-readonly.
function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'table', remoteId: ['appXYZ', 'tblABC'] },
    slug: 'table',
    name: 'table',
    idColumnRemoteId: idPath('id'),
    schema: {
      properties: {
        fields: {
          properties: {
            'Date/heure de création': { 'x-scratch-readonly': true },
          },
        },
      },
    } as unknown as TSchema,
  };
}

describe('AirtableConnector.listCreateDestinations', () => {
  let connector: AirtableConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new AirtableConnector('test-api-key');
  });

  it('returns each base as an { id, name } create destination', async () => {
    mockListBases.mockResolvedValue({
      bases: [
        { id: 'appOne', name: 'Marketing', permissionLevel: 'create' },
        { id: 'appTwo', name: 'Sales', permissionLevel: 'edit' },
      ],
    });

    const destinations = await connector.listCreateDestinations();

    expect(destinations).toEqual([
      { id: 'appOne', name: 'Marketing' },
      { id: 'appTwo', name: 'Sales' },
    ]);
  });
});

describe('AirtableConnector.updateRecords', () => {
  let connector: AirtableConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateRecords.mockResolvedValue([]);
    connector = new AirtableConnector('test-api-key');
  });

  // DEV-10125: the original bug. The full file had ~30 fields (incl. a computed
  // read-only field). The user edited one field. The PATCH must contain *only*
  // the changed field — not the other 29, and especially not the computed one.
  it('sends only the changed field to Airtable when changedFields is sparse', async () => {
    const fullFields = {
      Name: 'Acme Corp',
      Email: 'contact@acme.com',
      Phone: '+1-555-0100',
      Notes: 'Existing notes',
      Status: 'Active',
      'Date/heure de création': '2026-01-01T00:00:00.000Z', // computed/read-only
    };
    const files: ConnectorFile[] = [
      {
        id: 'recABC',
        fields: fullFields,
      },
    ];
    // Only Notes changed.
    const changedFields: Record<string, unknown>[] = [{ fields: { Notes: 'New notes' } }];

    await connector.updateRecords(buildTableSpec(), files, changedFields);

    expect(mockUpdateRecords).toHaveBeenCalledTimes(1);
    const [baseId, tableId, records] = mockUpdateRecords.mock.calls[0] as [
      string,
      string,
      { id: string; fields: Record<string, unknown> }[],
    ];
    expect(baseId).toBe('appXYZ');
    expect(tableId).toBe('tblABC');
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('recABC');
    expect(records[0].fields).toEqual({ Notes: 'New notes' });
  });

  it('strips read-only fields even when present in changedFields', async () => {
    const files: ConnectorFile[] = [
      {
        id: 'recABC',
        fields: { Name: 'A', 'Date/heure de création': '2026-01-01T00:00:00.000Z' },
      },
    ];
    // Both Name and the read-only field appear as "changed" (e.g. stale pull recompute).
    const changedFields: Record<string, unknown>[] = [
      { fields: { Name: 'B', 'Date/heure de création': '2026-02-02T00:00:00.000Z' } },
    ];

    await connector.updateRecords(buildTableSpec(), files, changedFields);

    const [, , records] = mockUpdateRecords.mock.calls[0] as [
      string,
      string,
      { id: string; fields: Record<string, unknown> }[],
    ];
    // The computed field must not leak through — that's what made Airtable return 422.
    expect(records[0].fields).toEqual({ Name: 'B' });
  });
});

function buildPullTableSpec(fieldProps: Record<string, unknown> = {}): BaseJsonTableSpec {
  return {
    id: { wsId: 'table', remoteId: ['appXYZ', 'tblABC'] },
    slug: 'table',
    name: 'table',
    idColumnRemoteId: idPath('id'),
    schema: { properties: { fields: { properties: fieldProps } } } as unknown as TSchema,
  };
}

function tableSpecWithAnnotatedField(fieldName: string): BaseJsonTableSpec {
  return buildPullTableSpec({
    [fieldName]: { [X_SCRATCH_LAST_MODIFIED_FIELD]: true },
  });
}

function singleBatchGenerator(records: ConnectorFile[]): AsyncGenerator<{
  records: ConnectorFile[];
  nextOffset?: string;
}> {
  async function* generator() {
    yield await Promise.resolve({ records, nextOffset: undefined });
  }
  return generator();
}

describe('AirtableConnector.supportsIncrementalPull', () => {
  let connector: AirtableConnector;

  beforeEach(() => {
    connector = new AirtableConnector('test-api-key');
  });

  it('returns false when modifiedAtField is unset and the schema has no annotated field', () => {
    expect(connector.supportsIncrementalPull({}, buildPullTableSpec())).toBe(false);
  });

  it('returns false when modifiedAtField is blank and the schema has no annotated field', () => {
    expect(connector.supportsIncrementalPull({ modifiedAtField: '   ' }, buildPullTableSpec())).toBe(false);
  });

  it('returns true when modifiedAtField is set explicitly', () => {
    expect(connector.supportsIncrementalPull({ modifiedAtField: 'Last Modified Time' }, buildPullTableSpec())).toBe(
      true,
    );
  });

  it('returns true when the schema has a field annotated with x-scratch-last-modified-field', () => {
    expect(connector.supportsIncrementalPull({}, tableSpecWithAnnotatedField('Last Modified Time'))).toBe(true);
  });
});

describe('AirtableConnector.pullRecordFiles (incremental)', () => {
  let connector: AirtableConnector;
  const callback = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockListRecords.mockImplementation(() => singleBatchGenerator([]));
    connector = new AirtableConnector('test-api-key');
  });

  it('runs a full pull and returns {} when pullMode is not incremental', async () => {
    const result = await connector.pullRecordFiles(buildPullTableSpec(), callback, {}, { pullMode: 'full' });

    expect(result).toEqual({});
    const [, , listOptions] = mockListRecords.mock.calls[0] as [string, string, { filterByFormula?: string }];
    expect(listOptions.filterByFormula).toBeUndefined();
  });

  it('demotes to full when pullMode is incremental but modifiedAtField is unset', async () => {
    const since = new Date('2026-05-01T00:00:00.000Z');
    const options: PullRecordFilesOptions = { pullMode: 'incremental', since };

    const result = await connector.pullRecordFiles(buildPullTableSpec(), callback, {}, options);

    expect(result).toEqual({});
    const [, , listOptions] = mockListRecords.mock.calls[0] as [string, string, { filterByFormula?: string }];
    expect(listOptions.filterByFormula).toBeUndefined();
  });

  it('injects IS_AFTER with clock-skew overlap and returns a newWatermark', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options: PullRecordFilesOptions = {
      pullMode: 'incremental',
      since,
      modifiedAtField: 'Last Modified Time',
    };

    const before = Date.now();
    const result = await connector.pullRecordFiles(buildPullTableSpec(), callback, {}, options);
    const after = Date.now();

    const [, , listOptions] = mockListRecords.mock.calls[0] as [string, string, { filterByFormula?: string }];
    const expectedSince = new Date(since.getTime() - AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS).toISOString();
    expect(listOptions.filterByFormula).toBe(`IS_AFTER({Last Modified Time}, '${expectedSince}')`);

    expect(result.newWatermark).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
  });

  it('combines user filter with the incremental formula via AND(...)', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options: PullRecordFilesOptions = {
      pullMode: 'incremental',
      since,
      modifiedAtField: 'Last Modified Time',
      filter: "{Status} = 'Active'",
    };

    await connector.pullRecordFiles(buildPullTableSpec(), callback, {}, options);

    const [, , listOptions] = mockListRecords.mock.calls[0] as [string, string, { filterByFormula?: string }];
    const expectedSince = new Date(since.getTime() - AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS).toISOString();
    expect(listOptions.filterByFormula).toBe(
      `AND({Status} = 'Active', IS_AFTER({Last Modified Time}, '${expectedSince}'))`,
    );
  });

  it('escapes special characters in modifiedAtField names', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options: PullRecordFilesOptions = {
      pullMode: 'incremental',
      since,
      modifiedAtField: 'Weird}Field',
    };

    await connector.pullRecordFiles(buildPullTableSpec(), callback, {}, options);

    const [, , listOptions] = mockListRecords.mock.calls[0] as [string, string, { filterByFormula?: string }];
    expect(listOptions.filterByFormula).toContain('{Weird\\}Field}');
  });

  it('auto-detects modifiedAtField from a schema-annotated field when options.modifiedAtField is unset', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options: PullRecordFilesOptions = { pullMode: 'incremental', since };
    const tableSpec = tableSpecWithAnnotatedField('Auto Detected');

    const result = await connector.pullRecordFiles(tableSpec, callback, {}, options);

    const [, , listOptions] = mockListRecords.mock.calls[0] as [string, string, { filterByFormula?: string }];
    const expectedSince = new Date(since.getTime() - AIRTABLE_INCREMENTAL_CLOCK_SKEW_MS).toISOString();
    expect(listOptions.filterByFormula).toBe(`IS_AFTER({Auto Detected}, '${expectedSince}')`);
    expect(result.newWatermark).toBeInstanceOf(Date);
  });

  it('prefers explicit modifiedAtField over the schema-annotated field', async () => {
    const since = new Date('2026-05-01T12:00:00.000Z');
    const options: PullRecordFilesOptions = {
      pullMode: 'incremental',
      since,
      modifiedAtField: 'User Override',
    };
    const tableSpec = tableSpecWithAnnotatedField('Auto Detected');

    await connector.pullRecordFiles(tableSpec, callback, {}, options);

    const [, , listOptions] = mockListRecords.mock.calls[0] as [string, string, { filterByFormula?: string }];
    expect(listOptions.filterByFormula).toContain('{User Override}');
    expect(listOptions.filterByFormula).not.toContain('{Auto Detected}');
  });

  it('returns {} for full pulls even when modifiedAtField is set', async () => {
    const options: PullRecordFilesOptions = {
      pullMode: 'full',
      modifiedAtField: 'Last Modified Time',
      filter: "{Status} = 'Active'",
    };

    const result = await connector.pullRecordFiles(buildPullTableSpec(), callback, {}, options);

    expect(result).toEqual({});
    const [, , listOptions] = mockListRecords.mock.calls[0] as [string, string, { filterByFormula?: string }];
    // User filter still flows through unchanged on full pulls.
    expect(listOptions.filterByFormula).toBe("{Status} = 'Active'");
  });
});

function schemaField(name: string, extra: Partial<ResolvedCreateFieldSpec> = {}): ResolvedCreateFieldSpec {
  return { name, fieldType: { kind: 'text' }, ...extra };
}

type CreateTableRequest = { name: string; fields: { name: string }[] };

describe('AirtableConnector schema creation', () => {
  let connector: AirtableConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new AirtableConnector('test-api-key');
  });

  it('declares schema-creation support and capabilities', () => {
    expect(connector.supportsSchemaCreation()).toBe(true);

    const capabilities = connector.getSchemaCreationCapabilities();
    expect(capabilities.supportedFieldKinds).toHaveLength(12);
    expect(capabilities.requiresPrimaryField).toBe(true);
    expect(capabilities.primaryFieldKinds).not.toContain('boolean');
    expect(capabilities.maxTableNameLength).toBe(255);
    expect(capabilities.maxFieldNameLength).toBe(255);
  });

  describe('createTable', () => {
    it('creates a table and returns remoteTableId plus per-field ids matched by name', async () => {
      mockCreateTable.mockResolvedValue({
        id: 'tblNEW',
        name: 'People',
        fields: [
          { id: 'fld1', name: 'Name' },
          { id: 'fld2', name: 'Age' },
        ],
      });
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: ['appBASE'],
        ref: 't1',
        name: 'People',
        fields: [schemaField('Name', { isPrimary: true }), schemaField('Age', { fieldType: { kind: 'number' } })],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(mockCreateTable).toHaveBeenCalledTimes(1);
      const [baseId, request] = mockCreateTable.mock.calls[0] as [string, CreateTableRequest];
      expect(baseId).toBe('appBASE');
      expect(request.name).toBe('People');
      expect(result).toMatchObject({
        ref: 't1',
        name: 'People',
        status: 'created',
        remoteTableId: ['appBASE', 'tblNEW'],
      });
      expect(result.fields).toEqual([
        { name: 'Name', status: 'created', remoteFieldId: 'fld1' },
        { name: 'Age', status: 'created', remoteFieldId: 'fld2' },
      ]);
    });

    it('moves the isPrimary field to fields[0] even when declared last', async () => {
      mockCreateTable.mockResolvedValue({ id: 'tblNEW', name: 'T', fields: [] });
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: ['appBASE'],
        ref: 't1',
        name: 'T',
        fields: [schemaField('Active', { fieldType: { kind: 'boolean' } }), schemaField('Title', { isPrimary: true })],
        deferredFkFields: [],
      };

      await connector.createTable(plan);

      const [, request] = mockCreateTable.mock.calls[0] as [string, CreateTableRequest];
      expect(request.fields.map((field) => field.name)).toEqual(['Title', 'Active']);
    });

    it('fails the table (no client call) when no base is provided', async () => {
      const plan: NormalizedCreateTablePlan = {
        ref: 't1',
        name: 'T',
        fields: [schemaField('Title', { isPrimary: true })],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(mockCreateTable).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/base/i);
      expect(result.fields).toEqual([{ name: 'Title', status: 'failed' }]);
    });

    it('marks the table partial and surfaces a cross-base link skip', async () => {
      mockCreateTable.mockResolvedValue({ id: 'tblNEW', name: 'T', fields: [{ id: 'fld1', name: 'Title' }] });
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: ['appBASE'],
        ref: 't1',
        name: 'T',
        fields: [
          schemaField('Title', { isPrimary: true }),
          schemaField('Linked', {
            fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: ['appOTHER', 'tblX'] } },
          }),
        ],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      // The skipped cross-base link must not be sent to Airtable.
      const [, request] = mockCreateTable.mock.calls[0] as [string, CreateTableRequest];
      expect(request.fields.map((field) => field.name)).toEqual(['Title']);
      expect(result.status).toBe('partial');
      expect(result.fields).toContainEqual({ name: 'Title', status: 'created', remoteFieldId: 'fld1' });
      const linkedResult = result.fields.find((field) => field.name === 'Linked');
      expect(linkedResult).toMatchObject({ name: 'Linked', status: 'skipped' });
      expect(linkedResult?.error).toContain('different base');
    });

    it('returns a failed result (no throw) when the API rejects', async () => {
      mockCreateTable.mockRejectedValue(new Error('boom'));
      const plan: NormalizedCreateTablePlan = {
        remoteParentId: ['appBASE'],
        ref: 't1',
        name: 'T',
        fields: [schemaField('Title', { isPrimary: true })],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
      expect(result.fields).toEqual([{ name: 'Title', status: 'failed' }]);
    });
  });

  describe('createFields', () => {
    it('adds each field with a separate create-field call', async () => {
      mockCreateField
        .mockResolvedValueOnce({ id: 'fldA', name: 'Bio' })
        .mockResolvedValueOnce({ id: 'fldB', name: 'Nickname' });
      const plan: NormalizedCreateFieldsPlan = {
        remoteTableId: ['appBASE', 'tblNEW'],
        fields: [schemaField('Bio'), schemaField('Nickname')],
      };

      const results = await connector.createFields(plan);

      expect(mockCreateField).toHaveBeenCalledTimes(2);
      const [baseId, tableId] = mockCreateField.mock.calls[0] as [string, string, unknown];
      expect(baseId).toBe('appBASE');
      expect(tableId).toBe('tblNEW');
      expect(results).toEqual([
        { name: 'Bio', status: 'created', remoteFieldId: 'fldA' },
        { name: 'Nickname', status: 'created', remoteFieldId: 'fldB' },
      ]);
    });

    it('isolates a per-field failure from the rest', async () => {
      mockCreateField
        .mockResolvedValueOnce({ id: 'fldA', name: 'ok' })
        .mockRejectedValueOnce(new Error('duplicate field name'));
      const plan: NormalizedCreateFieldsPlan = {
        remoteTableId: ['appBASE', 'tblNEW'],
        fields: [schemaField('ok'), schemaField('dupe')],
      };

      const results = await connector.createFields(plan);

      expect(results[0]).toEqual({ name: 'ok', status: 'created', remoteFieldId: 'fldA' });
      expect(results[1].status).toBe('failed');
      expect(results[1].error).toBeDefined();
    });

    it('skips a cross-base link without calling the API for it', async () => {
      const plan: NormalizedCreateFieldsPlan = {
        remoteTableId: ['appBASE', 'tblNEW'],
        fields: [
          schemaField('Linked', {
            fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: ['appOTHER', 'tblX'] } },
          }),
        ],
      };

      const results = await connector.createFields(plan);

      expect(mockCreateField).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ name: 'Linked', status: 'skipped' });
      expect(results[0].error).toContain('different base');
    });
  });
});
