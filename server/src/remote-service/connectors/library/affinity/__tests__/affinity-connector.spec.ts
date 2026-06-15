import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, EntityId, idPath } from '../../../types';
import { AffinityConnector, parseAffinityTableId } from '../affinity-connector';
import {
  AffinityCompany,
  AffinityEntityFile,
  AffinityFieldMetadata,
  AffinityList,
  AffinityListEntry,
  AffinityNote,
  AffinityOpportunity,
  AffinityPerson,
} from '../affinity-types';

// Break a circular import chain that pulls in the full server module graph.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Affinity'),
}));

// Mock the API client. Each spec sets the return values it needs.
const mockTestConnection = jest.fn();
const mockListAllLists = jest.fn();
const mockGetList = jest.fn();
const mockListListFields = jest.fn();
const mockListListEntries = jest.fn();
const mockGetListEntry = jest.fn();
const mockListAllPersons = jest.fn();
const mockListAllCompanies = jest.fn();
const mockListAllOpportunities = jest.fn();
const mockListPersonFields = jest.fn();
const mockListCompanyFields = jest.fn();
const mockGetPerson = jest.fn();
const mockGetCompany = jest.fn();
const mockGetOpportunity = jest.fn();
const mockListAllNotes = jest.fn();
const mockGetNote = jest.fn();
const mockListAllEntityFiles = jest.fn();
const mockGetEntityFile = jest.fn();
const mockListAllUsers = jest.fn();
const mockGetUser = jest.fn();
const mockUpdatePersonFieldValues = jest.fn();
const mockUpdateCompanyFieldValues = jest.fn();
const mockUpdateListEntryFieldValues = jest.fn();
const mockCreateNote = jest.fn();
const mockUpdateNote = jest.fn();
const mockDeleteNote = jest.fn();
const mockCreatePerson = jest.fn();
const mockUpdatePerson = jest.fn();
const mockDeletePerson = jest.fn();
const mockCreateCompany = jest.fn();
const mockUpdateCompany = jest.fn();
const mockDeleteCompany = jest.fn();
const mockCreateOpportunity = jest.fn();
const mockUpdateOpportunity = jest.fn();
const mockDeleteOpportunity = jest.fn();
const mockCreateListEntry = jest.fn();
const mockDeleteListEntry = jest.fn();

jest.mock('../affinity-api-client', () => {
  return {
    AffinityApiClient: jest.fn().mockImplementation(() => ({
      testConnection: mockTestConnection,
      listAllLists: mockListAllLists,
      getList: mockGetList,
      listListFields: mockListListFields,
      listListEntries: mockListListEntries,
      getListEntry: mockGetListEntry,
      listAllPersons: mockListAllPersons,
      listAllCompanies: mockListAllCompanies,
      listAllOpportunities: mockListAllOpportunities,
      listPersonFields: mockListPersonFields,
      listCompanyFields: mockListCompanyFields,
      getPerson: mockGetPerson,
      getCompany: mockGetCompany,
      getOpportunity: mockGetOpportunity,
      listAllNotes: mockListAllNotes,
      getNote: mockGetNote,
      listAllEntityFiles: mockListAllEntityFiles,
      getEntityFile: mockGetEntityFile,
      listAllUsers: mockListAllUsers,
      getUser: mockGetUser,
      updatePersonFieldValues: mockUpdatePersonFieldValues,
      updateCompanyFieldValues: mockUpdateCompanyFieldValues,
      updateListEntryFieldValues: mockUpdateListEntryFieldValues,
      createNote: mockCreateNote,
      updateNote: mockUpdateNote,
      deleteNote: mockDeleteNote,
      createPerson: mockCreatePerson,
      updatePerson: mockUpdatePerson,
      deletePerson: mockDeletePerson,
      createCompany: mockCreateCompany,
      updateCompany: mockUpdateCompany,
      deleteCompany: mockDeleteCompany,
      createOpportunity: mockCreateOpportunity,
      updateOpportunity: mockUpdateOpportunity,
      deleteOpportunity: mockDeleteOpportunity,
      createListEntry: mockCreateListEntry,
      deleteListEntry: mockDeleteListEntry,
    })),
    AffinityError: class AffinityError extends Error {
      statusCode?: number;
      constructor(message: string, statusCode?: number) {
        super(message);
        this.name = 'AffinityError';
        this.statusCode = statusCode;
      }
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});

// Helpers ---------------------------------------------------------------------

function makeList(id: number, name: string, type: AffinityList['type']): AffinityList {
  return { id, name, type, isPublic: false, ownerId: 1, creatorId: 1 };
}

function makeListEntry(id: number, listId: number, entityFields: unknown[] = []): AffinityListEntry {
  return {
    id,
    type: 'person',
    listId,
    createdAt: '2025-01-01T00:00:00Z',
    creatorId: 1,
    entity: {
      id,
      firstName: `First${id}`,
      lastName: `Last${id}`,
      fields: entityFields,
    },
  };
}

function makePerson(id: number, fields: unknown[] = []): AffinityPerson {
  return {
    id,
    firstName: `Person${id}`,
    lastName: 'Test',
    primaryEmailAddress: `person${id}@example.com`,
    emailAddresses: [`person${id}@example.com`],
    type: 'external',
    fields,
  };
}

function makeCompany(id: number, fields: unknown[] = []): AffinityCompany {
  return {
    id,
    name: `Company${id}`,
    domain: `company${id}.example.com`,
    domains: [`company${id}.example.com`],
    isGlobal: true,
    fields,
  };
}

function makeOpportunity(id: number, listId: number): AffinityOpportunity {
  return { id, name: `Opportunity${id}`, listId };
}

function makeNote(id: number): AffinityNote {
  return {
    id,
    type: 'entities',
    content: { html: '<p>Note content</p>' },
    creator: null,
    mentions: [],
    createdAt: '2025-06-01T10:00:00Z',
    updatedAt: null,
  };
}

function makeEntityFile(id: number): AffinityEntityFile {
  return {
    id,
    name: `file${id}.pdf`,
    size: 1024,
    person_id: null,
    organization_id: null,
    opportunity_id: null,
    uploader_id: 1,
    created_at: '2025-06-01T10:00:00Z',
  };
}

function buildTableSpec(remoteId: string): BaseJsonTableSpec {
  return {
    id: { wsId: remoteId, remoteId: [remoteId] },
    slug: remoteId,
    name: remoteId,
    schema: {} as unknown as TSchema,
    idColumnRemoteId: idPath('id'),
  };
}

/**
 * Build an async generator from a single batch (no nextCursor). The function
 * is `async function*` because the connector consumes its return value with
 * `for await ... of`, so it has to be an `AsyncGenerator`. We `await
 * Promise.resolve()` to satisfy `@typescript-eslint/require-await` without
 * introducing real asynchrony.
 */
async function* singleBatch<T>(data: T[]): AsyncGenerator<{ data: T[]; nextCursor?: string }, void> {
  await Promise.resolve();
  yield { data };
}

// parseAffinityTableId --------------------------------------------------------

describe('parseAffinityTableId', () => {
  const idFor = (raw: string): EntityId => ({ wsId: raw, remoteId: [raw] });

  it('routes the persons sentinel to the tenant-persons kind', () => {
    expect(parseAffinityTableId(idFor('persons'))).toEqual({ kind: 'tenant-persons' });
  });

  it('routes the companies sentinel to the tenant-companies kind', () => {
    expect(parseAffinityTableId(idFor('companies'))).toEqual({ kind: 'tenant-companies' });
  });

  it('routes the opportunities sentinel to the tenant-opportunities kind', () => {
    expect(parseAffinityTableId(idFor('opportunities'))).toEqual({ kind: 'tenant-opportunities' });
  });

  it('routes the notes sentinel to the tenant-notes kind', () => {
    expect(parseAffinityTableId(idFor('notes'))).toEqual({ kind: 'tenant-notes' });
  });

  it('routes the entity-files sentinel to the tenant-entity-files kind', () => {
    expect(parseAffinityTableId(idFor('entity-files'))).toEqual({ kind: 'tenant-entity-files' });
  });

  it('routes a numeric remoteId to the list kind', () => {
    expect(parseAffinityTableId(idFor('220173'))).toEqual({ kind: 'list', listId: 220173 });
  });

  it('throws on a non-numeric remoteId that is not a sentinel', () => {
    expect(() => parseAffinityTableId(idFor('not-a-list'))).toThrow(/Invalid Affinity table id/);
  });
});

// listTables ------------------------------------------------------------------

describe('AffinityConnector.listTables', () => {
  it('returns the tenant tables at the top level plus user lists under "Lists/"', async () => {
    mockListAllLists.mockResolvedValue([
      makeList(101, 'My People List', 'person'),
      makeList(102, 'My Company List', 'company'),
    ]);

    const connector = new AffinityConnector('fake-key');
    const tables = await connector.listTables();

    // Tenant tables come first, all top-level (no parentPath).
    const topLevel = tables.filter((t) => t.parentPath === undefined);
    expect(topLevel.map((t) => t.displayName)).toEqual([
      'Companies',
      'People',
      'Opportunities',
      'Notes',
      'Entity Files',
      'Users',
    ]);

    // List tables come after tenant tables, all flat under "Lists/" regardless of entity type.
    const lists = tables.filter((t) => t.parentPath === 'Lists');
    expect(lists).toHaveLength(2);
    expect(lists.map((t) => t.displayName)).toEqual(['My People List', 'My Company List']);
    expect(lists.map((t) => t.id.remoteId[0])).toEqual(['101', '102']);
  });

  it('still returns the tenant tables when there are no user-created lists', async () => {
    mockListAllLists.mockResolvedValue([]);

    const connector = new AffinityConnector('fake-key');
    const tables = await connector.listTables();

    expect(tables).toHaveLength(6);
    expect(tables.map((t) => t.displayName)).toEqual([
      'Companies',
      'People',
      'Opportunities',
      'Notes',
      'Entity Files',
      'Users',
    ]);
  });
});

// fetchJsonTableSpec ----------------------------------------------------------

describe('AffinityConnector.fetchJsonTableSpec', () => {
  it('builds a list-entry spec for numeric ids and routes through listListFields', async () => {
    mockGetList.mockResolvedValue(makeList(500, 'Some List', 'company'));
    mockListListFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const connector = new AffinityConnector('fake-key');
    const spec = await connector.fetchJsonTableSpec({ wsId: 'list_500', remoteId: ['500'] });

    expect(spec.name).toBe('Some List');
    expect(spec.idColumnRemoteId).toBe('id');
    expect(spec.titleColumnRemoteId).toEqual(['entity', 'name']);
    expect(mockListListFields).toHaveBeenCalledWith(500);
    // Lists must nest under "Lists/" in the workbook tree. The picker uses
    // parentPath for grouping, but the workbook tree hierarchy comes from
    // `basePath` on the spec — both have to be set to keep them consistent.
    expect(spec.basePath).toEqual(['Lists']);
  });

  it('builds the tenant-persons spec via listPersonFields with a flat title column', async () => {
    mockListPersonFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const connector = new AffinityConnector('fake-key');
    const spec = await connector.fetchJsonTableSpec({ wsId: 'persons', remoteId: ['persons'] });

    expect(spec.name).toBe('People');
    expect(spec.idColumnRemoteId).toBe('id');
    // No `entity.` prefix — tenant records are flat.
    expect(spec.titleColumnRemoteId).toEqual(['firstName']);
    expect(mockListPersonFields).toHaveBeenCalled();
    expect(mockListListFields).not.toHaveBeenCalled();
    // Tenant tables live at the workbook tree root.
    expect(spec.basePath).toEqual([]);
  });

  it('builds the tenant-companies spec via listCompanyFields', async () => {
    mockListCompanyFields.mockResolvedValue([] as AffinityFieldMetadata[]);

    const connector = new AffinityConnector('fake-key');
    const spec = await connector.fetchJsonTableSpec({ wsId: 'companies', remoteId: ['companies'] });

    expect(spec.name).toBe('Companies');
    expect(spec.titleColumnRemoteId).toEqual(['name']);
    expect(mockListCompanyFields).toHaveBeenCalled();
    expect(spec.basePath).toEqual([]);
  });

  it('builds the tenant-opportunities spec without any field-metadata fetch', async () => {
    const connector = new AffinityConnector('fake-key');
    const spec = await connector.fetchJsonTableSpec({
      wsId: 'opportunities',
      remoteId: ['opportunities'],
    });

    expect(spec.name).toBe('Opportunities');
    expect(spec.idColumnRemoteId).toBe('id');
    expect(spec.titleColumnRemoteId).toEqual(['name']);
    expect(spec.basePath).toEqual([]);
    // Opportunities have no fields metadata — none of the field fetchers should fire.
    expect(mockListPersonFields).not.toHaveBeenCalled();
    expect(mockListCompanyFields).not.toHaveBeenCalled();
    expect(mockListListFields).not.toHaveBeenCalled();
  });
});

// pullRecordFiles -------------------------------------------------------------

describe('AffinityConnector.pullRecordFiles', () => {
  async function collectBatches(connector: AffinityConnector, spec: BaseJsonTableSpec): Promise<ConnectorFile[][]> {
    const batches: ConnectorFile[][] = [];
    await connector.pullRecordFiles(
      spec,
      // eslint-disable-next-line @typescript-eslint/require-await
      async ({ files }) => {
        batches.push(files);
      },
      {},
      {},
    );
    return batches;
  }

  it('list dispatch: pulls list-entries and rekeys entity.fields by id', async () => {
    const listEntry = makeListEntry(1, 500, [
      { id: 'field-a', name: 'A', type: 'list', value: { type: 'text', data: 'hi' } },
    ]);
    mockListListEntries.mockReturnValue(singleBatch([listEntry]));

    const connector = new AffinityConnector('fake-key');
    const batches = await collectBatches(connector, buildTableSpec('500'));

    expect(mockListListEntries).toHaveBeenCalledWith(500, undefined);
    expect(batches).toHaveLength(1);
    const file = batches[0][0] as unknown as { entity: { fields: Record<string, unknown> } };
    // Array transformed into an object keyed by field id.
    expect(file.entity.fields).toEqual({
      'field-a': { id: 'field-a', name: 'A', type: 'list', value: { type: 'text', data: 'hi' } },
    });
  });

  it('tenant-persons dispatch: pulls /v2/persons and rekeys top-level fields by id', async () => {
    const person = makePerson(7101, [{ id: 'field-x', type: 'enriched', value: { type: 'text', data: 'CTO' } }]);
    mockListAllPersons.mockReturnValue(singleBatch([person]));

    const connector = new AffinityConnector('fake-key');
    const batches = await collectBatches(connector, buildTableSpec('persons'));

    expect(mockListAllPersons).toHaveBeenCalledWith(undefined);
    expect(mockListListEntries).not.toHaveBeenCalled();
    const file = batches[0][0] as unknown as { fields: Record<string, unknown>; entity?: unknown };
    expect(file.entity).toBeUndefined();
    expect(file.fields).toEqual({
      'field-x': { id: 'field-x', type: 'enriched', value: { type: 'text', data: 'CTO' } },
    });
  });

  it('tenant-companies dispatch: pulls /v2/companies and rekeys top-level fields by id', async () => {
    const company = makeCompany(7001, [{ id: 'field-y', type: 'enriched', value: null }]);
    mockListAllCompanies.mockReturnValue(singleBatch([company]));

    const connector = new AffinityConnector('fake-key');
    const batches = await collectBatches(connector, buildTableSpec('companies'));

    expect(mockListAllCompanies).toHaveBeenCalledWith(undefined);
    const file = batches[0][0] as unknown as { fields: Record<string, unknown> };
    expect(file.fields).toEqual({
      'field-y': { id: 'field-y', type: 'enriched', value: null },
    });
  });

  it('tenant-opportunities dispatch: pulls /v2/opportunities and passes records through verbatim', async () => {
    const opp = makeOpportunity(7201, 1003);
    mockListAllOpportunities.mockReturnValue(singleBatch([opp]));

    const connector = new AffinityConnector('fake-key');
    const batches = await collectBatches(connector, buildTableSpec('opportunities'));

    expect(mockListAllOpportunities).toHaveBeenCalledWith(undefined);
    expect(batches[0][0]).toEqual(opp);
  });

  it('tenant-notes dispatch: pulls /v2/notes', async () => {
    const note = makeNote(8301);
    mockListAllNotes.mockReturnValue(singleBatch([note]));

    const connector = new AffinityConnector('fake-key');
    const batches = await collectBatches(connector, buildTableSpec('notes'));

    expect(mockListAllNotes).toHaveBeenCalledWith(undefined);
    expect(batches[0][0]).toEqual(note);
  });

  it('tenant-entity-files dispatch: pulls /entity-files (v1)', async () => {
    const file = makeEntityFile(8401);
    mockListAllEntityFiles.mockReturnValue(singleBatch([file]));

    const connector = new AffinityConnector('fake-key');
    const batches = await collectBatches(connector, buildTableSpec('entity-files'));

    expect(mockListAllEntityFiles).toHaveBeenCalledWith(undefined);
    expect(batches[0][0]).toEqual(file);
  });
});

// pullRecordFilesByIds --------------------------------------------------------

describe('AffinityConnector.pullRecordFilesByIds', () => {
  async function collectFiles(
    connector: AffinityConnector,
    spec: BaseJsonTableSpec,
    ids: string[],
  ): Promise<ConnectorFile[]> {
    const out: ConnectorFile[] = [];
    await connector.pullRecordFilesByIds(
      spec,
      ids,
      // eslint-disable-next-line @typescript-eslint/require-await
      async ({ files }) => {
        out.push(...files);
      },
    );
    return out;
  }

  it('routes a list table to getListEntry per id', async () => {
    mockGetListEntry.mockResolvedValue(makeListEntry(1, 500));
    const connector = new AffinityConnector('fake-key');

    const files = await collectFiles(connector, buildTableSpec('500'), ['1']);

    expect(mockGetListEntry).toHaveBeenCalledWith(500, 1);
    expect(files).toHaveLength(1);
  });

  it('routes a tenant-persons table to getPerson per id', async () => {
    mockGetPerson.mockResolvedValue(makePerson(7101));
    const connector = new AffinityConnector('fake-key');

    const files = await collectFiles(connector, buildTableSpec('persons'), ['7101']);

    expect(mockGetPerson).toHaveBeenCalledWith(7101);
    expect(mockGetListEntry).not.toHaveBeenCalled();
    expect(files).toHaveLength(1);
  });

  it('routes a tenant-companies table to getCompany per id', async () => {
    mockGetCompany.mockResolvedValue(makeCompany(7001));
    const connector = new AffinityConnector('fake-key');

    const files = await collectFiles(connector, buildTableSpec('companies'), ['7001']);

    expect(mockGetCompany).toHaveBeenCalledWith(7001);
    expect(files).toHaveLength(1);
  });

  it('routes a tenant-opportunities table to getOpportunity per id', async () => {
    mockGetOpportunity.mockResolvedValue(makeOpportunity(7201, 1003));
    const connector = new AffinityConnector('fake-key');

    const files = await collectFiles(connector, buildTableSpec('opportunities'), ['7201']);

    expect(mockGetOpportunity).toHaveBeenCalledWith(7201);
    expect(files).toHaveLength(1);
  });

  it('routes a tenant-notes table to getNote per id', async () => {
    mockGetNote.mockResolvedValue(makeNote(8301));
    const connector = new AffinityConnector('fake-key');

    const files = await collectFiles(connector, buildTableSpec('notes'), ['8301']);

    expect(mockGetNote).toHaveBeenCalledWith(8301);
    expect(files).toHaveLength(1);
  });

  it('routes a tenant-entity-files table to getEntityFile per id', async () => {
    mockGetEntityFile.mockResolvedValue(makeEntityFile(8401));
    const connector = new AffinityConnector('fake-key');

    const files = await collectFiles(connector, buildTableSpec('entity-files'), ['8401']);

    expect(mockGetEntityFile).toHaveBeenCalledWith(8401);
    expect(files).toHaveLength(1);
  });

  it('skips non-numeric ids with a warning rather than throwing', async () => {
    mockGetPerson.mockResolvedValue(makePerson(7101));
    const connector = new AffinityConnector('fake-key');

    const files = await collectFiles(connector, buildTableSpec('persons'), ['not-a-number', '7101']);

    expect(mockGetPerson).toHaveBeenCalledTimes(1);
    expect(mockGetPerson).toHaveBeenCalledWith(7101);
    expect(files).toHaveLength(1);
  });
});

// getSuggestedRecordFileNames -------------------------------------------------

describe('AffinityConnector.getSuggestedRecordFileNames', () => {
  it('reads names from .entity for list-table records', () => {
    const connector = new AffinityConnector('fake-key');
    const records = [
      { entity: { name: 'Acme Corp' } },
      { entity: { firstName: 'Alice', lastName: 'Chen' } },
      { entity: { firstName: 'Bob' } },
    ] as unknown as ConnectorFile[];

    const suggestions = connector.getSuggestedRecordFileNames(records, buildTableSpec('500'));

    expect(suggestions).toEqual(['Acme Corp', 'Alice Chen', 'Bob']);
  });

  it('reads names from the top level for tenant-persons records (no entity wrapper)', () => {
    const connector = new AffinityConnector('fake-key');
    const records = [{ firstName: 'Alice', lastName: 'Chen' }, { firstName: 'Bob' }] as unknown as ConnectorFile[];

    const suggestions = connector.getSuggestedRecordFileNames(records, buildTableSpec('persons'));

    expect(suggestions).toEqual(['Alice Chen', 'Bob']);
  });

  it('reads .name from the top level for tenant-companies records', () => {
    const connector = new AffinityConnector('fake-key');
    const records = [{ name: 'Acme Corp' }] as unknown as ConnectorFile[];

    const suggestions = connector.getSuggestedRecordFileNames(records, buildTableSpec('companies'));

    expect(suggestions).toEqual(['Acme Corp']);
  });

  it('reads .name from the top level for tenant-opportunities records', () => {
    const connector = new AffinityConnector('fake-key');
    const records = [{ name: 'Acme Upsell $50k' }] as unknown as ConnectorFile[];

    const suggestions = connector.getSuggestedRecordFileNames(records, buildTableSpec('opportunities'));

    expect(suggestions).toEqual(['Acme Upsell $50k']);
  });

  it('reads .name from entity-files records', () => {
    const connector = new AffinityConnector('fake-key');
    const records = [{ name: 'contract.pdf' }] as unknown as ConnectorFile[];

    const suggestions = connector.getSuggestedRecordFileNames(records, buildTableSpec('entity-files'));

    expect(suggestions).toEqual(['contract.pdf']);
  });
});

// Writes (DEV-10298) -----------------------------------------------------------

describe('AffinityConnector writes', () => {
  const X_SCRATCH_READONLY = 'x-scratch-readonly';
  const X_SCRATCH_CONNECTOR_DATA_TYPE = 'x-scratch-connector-data-type';

  /** Table spec whose schema declares one writable text field (`field-1`). */
  function buildWritableTableSpec(remoteId: string, recordHasEntityWrapper: boolean): BaseJsonTableSpec {
    const fieldsObjectSchema = {
      properties: {
        'field-1': { description: 'Status', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'text' },
        'enriched-1': { description: 'Growth', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'number', [X_SCRATCH_READONLY]: true },
      },
    };
    const schema = recordHasEntityWrapper
      ? { properties: { entity: { properties: { fields: fieldsObjectSchema } } } }
      : { properties: { fields: fieldsObjectSchema } };
    return {
      ...buildTableSpec(remoteId),
      schema: schema as unknown as TSchema,
    };
  }

  describe('updateRecords', () => {
    it('pushes a changed person field through the persons batch endpoint and reads back', async () => {
      const personFile = {
        id: 42,
        firstName: 'Ada',
        fields: {
          'field-1': {
            id: 'field-1',
            name: 'Status',
            type: 'global',
            enrichmentSource: null,
            value: { type: 'text', data: 'Active' },
          },
        },
      } as unknown as ConnectorFile;
      mockUpdatePersonFieldValues.mockResolvedValue(undefined);
      mockGetPerson.mockResolvedValue(makePerson(42, [{ id: 'field-1', value: { type: 'text', data: 'Active' } }]));

      const connector = new AffinityConnector('fake-key');
      const results = await connector.updateRecords(
        buildWritableTableSpec('persons', false),
        [personFile],
        [{ fields: { 'field-1': { value: { data: 'Active' } } } }],
      );

      expect(mockUpdatePersonFieldValues).toHaveBeenCalledWith(42, [
        { id: 'field-1', value: { type: 'text', data: 'Active' } },
      ]);
      expect(mockGetPerson).toHaveBeenCalledWith(42);
      expect(results).toHaveLength(1);
    });

    it('pushes a changed list-entry field through the list-entries batch endpoint', async () => {
      const entryFile = {
        id: 9,
        listId: 500,
        entity: {
          id: 8,
          name: 'Deal',
          fields: {
            'field-1': {
              id: 'field-1',
              name: 'Status',
              type: 'list',
              enrichmentSource: null,
              value: { type: 'text', data: 'Won' },
            },
          },
        },
      } as unknown as ConnectorFile;
      mockUpdateListEntryFieldValues.mockResolvedValue(undefined);
      mockGetListEntry.mockResolvedValue(makeListEntry(9, 500));

      const connector = new AffinityConnector('fake-key');
      await connector.updateRecords(
        buildWritableTableSpec('500', true),
        [entryFile],
        [{ entity: { fields: { 'field-1': { value: { data: 'Won' } } } } }],
      );

      expect(mockUpdateListEntryFieldValues).toHaveBeenCalledWith(500, 9, [
        { id: 'field-1', value: { type: 'text', data: 'Won' } },
      ]);
    });

    it('routes a writable basic (firstName) to the v1 PUT, not a v2 field write', async () => {
      const personFile = { id: 42, firstName: 'Renamed', fields: {} } as unknown as ConnectorFile;
      mockUpdatePerson.mockResolvedValue({ id: 42 });
      mockGetPerson.mockResolvedValue(makePerson(42));

      const connector = new AffinityConnector('fake-key');
      await connector.updateRecords(buildWritableTableSpec('persons', false), [personFile], [{ firstName: 'Renamed' }]);

      expect(mockUpdatePerson).toHaveBeenCalledWith(42, { first_name: 'Renamed' });
      expect(mockUpdatePersonFieldValues).not.toHaveBeenCalled();
    });

    it('refuses an edit to a computed (read-only) field', async () => {
      const personFile = {
        id: 42,
        fields: { 'enriched-1': { id: 'enriched-1', value: { type: 'number', data: 1 } } },
      } as unknown as ConnectorFile;

      const connector = new AffinityConnector('fake-key');
      await expect(
        connector.updateRecords(
          buildWritableTableSpec('persons', false),
          [personFile],
          [{ fields: { 'enriched-1': { value: { data: 2 } } } }],
        ),
      ).rejects.toThrow(/computed by Affinity/);
    });

    it('updates note content through the note-update endpoint', async () => {
      const noteFile = { id: 7, content: { html: '<p>edited</p>' } } as unknown as ConnectorFile;
      mockUpdateNote.mockResolvedValue({ id: 7 });
      mockGetNote.mockResolvedValue(makeNote(7));

      const connector = new AffinityConnector('fake-key');
      await connector.updateRecords(buildTableSpec('notes'), [noteFile], [{ content: { html: '<p>edited</p>' } }]);

      expect(mockUpdateNote).toHaveBeenCalledWith(7, { content: { html: '<p>edited</p>' } });
    });

    it('throws a clear read-only error when updating entity files', async () => {
      const connector = new AffinityConnector('fake-key');
      await expect(
        connector.updateRecords(buildTableSpec('entity-files'), [{ id: 1 } as unknown as ConnectorFile], []),
      ).rejects.toThrow(/read-only/);
    });
  });

  describe('createRecords', () => {
    it('creates a note from content.html and preview association ids', async () => {
      mockCreateNote.mockResolvedValue({ id: 555 });
      mockGetNote.mockResolvedValue(makeNote(555));

      const noteFile = {
        content: { html: '<p>new note</p>' },
        personsPreview: { data: [{ id: 42 }], totalCount: 1 },
      } as unknown as ConnectorFile;

      const connector = new AffinityConnector('fake-key');
      const created = await connector.createRecords(buildTableSpec('notes'), [noteFile]);

      expect(mockCreateNote).toHaveBeenCalledWith({
        type: 'entities',
        content: { html: '<p>new note</p>' },
        persons: [{ id: 42 }],
      });
      expect(mockGetNote).toHaveBeenCalledWith(555);
      expect(created).toHaveLength(1);
    });

    it('refuses to create entity files (read-only)', async () => {
      const connector = new AffinityConnector('fake-key');
      await expect(
        connector.createRecords(buildTableSpec('entity-files'), [{ name: 'x.pdf' } as unknown as ConnectorFile]),
      ).rejects.toThrow(/read-only/);
    });
  });

  describe('deleteRecords', () => {
    it('deletes notes by id', async () => {
      mockDeleteNote.mockResolvedValue(undefined);

      const connector = new AffinityConnector('fake-key');
      await connector.deleteRecords(buildTableSpec('notes'), [{ id: 7 } as unknown as ConnectorFile]);

      expect(mockDeleteNote).toHaveBeenCalledWith(7);
    });

    it('refuses to delete entity files (read-only)', async () => {
      const connector = new AffinityConnector('fake-key');
      await expect(
        connector.deleteRecords(buildTableSpec('entity-files'), [{ id: 1 } as unknown as ConnectorFile]),
      ).rejects.toThrow(/read-only/);
    });
  });
});

// P2 — v1 record lifecycle (DEV-10298 phase 2) ---------------------------------

describe('AffinityConnector v1 writes (P2)', () => {
  function specWithSchema(remoteId: string, schema: object): BaseJsonTableSpec {
    return { ...buildTableSpec(remoteId), schema: schema as unknown as TSchema };
  }
  const PERSON_SCHEMA = { properties: { id: {}, firstName: {}, fields: { properties: {} } } };

  describe('createRecords', () => {
    it('creates a person via v1 basics then reads back via v2', async () => {
      mockCreatePerson.mockResolvedValue({ id: 999 });
      mockGetPerson.mockResolvedValue(makePerson(999));
      const file = {
        firstName: 'Ada',
        lastName: 'L',
        emailAddresses: ['ada@x.com'],
        fields: {},
      } as unknown as ConnectorFile;

      const connector = new AffinityConnector('k');
      const created = await connector.createRecords(specWithSchema('persons', PERSON_SCHEMA), [file]);

      expect(mockCreatePerson).toHaveBeenCalledWith({ first_name: 'Ada', last_name: 'L', emails: ['ada@x.com'] });
      expect(mockGetPerson).toHaveBeenCalledWith(999);
      expect(created).toHaveLength(1);
    });

    it('creates a company via v1 /organizations', async () => {
      mockCreateCompany.mockResolvedValue({ id: 7 });
      mockGetCompany.mockResolvedValue(makeCompany(7));
      const file = { name: 'Acme', domain: 'acme.com', fields: {} } as unknown as ConnectorFile;

      const connector = new AffinityConnector('k');
      await connector.createRecords(specWithSchema('companies', { properties: { fields: { properties: {} } } }), [
        file,
      ]);
      expect(mockCreateCompany).toHaveBeenCalledWith({ name: 'Acme', domain: 'acme.com' });
    });

    it('creates an opportunity (needs listId)', async () => {
      mockCreateOpportunity.mockResolvedValue({ id: 11 });
      mockGetOpportunity.mockResolvedValue(makeOpportunity(11, 204872));
      const file = { name: 'Deal', listId: 204872 } as unknown as ConnectorFile;

      const connector = new AffinityConnector('k');
      await connector.createRecords(buildTableSpec('opportunities'), [file]);
      expect(mockCreateOpportunity).toHaveBeenCalledWith({ name: 'Deal', list_id: 204872 });
    });

    it('creates list membership from entity.id', async () => {
      mockCreateListEntry.mockResolvedValue({ id: 555 });
      mockGetListEntry.mockResolvedValue(makeListEntry(555, 197394));
      const file = { entity: { id: 7 }, fields: {} } as unknown as ConnectorFile;

      const connector = new AffinityConnector('k');
      await connector.createRecords(
        specWithSchema('197394', { properties: { entity: { properties: { fields: { properties: {} } } } } }),
        [file],
      );
      expect(mockCreateListEntry).toHaveBeenCalledWith(197394, 7);
    });

    it('refuses to create entity files', async () => {
      const connector = new AffinityConnector('k');
      await expect(connector.createRecords(buildTableSpec('entity-files'), [{} as ConnectorFile])).rejects.toThrow(
        /read-only/,
      );
    });
  });

  describe('updateRecords — basics split', () => {
    it('routes a person basics change to v1 PUT and a field change to v2', async () => {
      mockUpdatePerson.mockResolvedValue({ id: 42 });
      mockUpdatePersonFieldValues.mockResolvedValue(undefined);
      mockGetPerson.mockResolvedValue(makePerson(42));
      const schema = {
        properties: { fields: { properties: { 'field-1': { 'x-scratch-connector-data-type': 'text' } } } },
      };
      const file = {
        id: 42,
        firstName: 'New',
        fields: { 'field-1': { id: 'field-1', value: { type: 'text', data: 'v' } } },
      } as unknown as ConnectorFile;

      const connector = new AffinityConnector('k');
      await connector.updateRecords(
        specWithSchema('persons', schema),
        [file],
        [{ firstName: 'New', fields: { 'field-1': { value: { data: 'v' } } } }],
      );

      expect(mockUpdatePerson).toHaveBeenCalledWith(42, { first_name: 'New' });
      expect(mockUpdatePersonFieldValues).toHaveBeenCalledWith(42, [
        { id: 'field-1', value: { type: 'text', data: 'v' } },
      ]);
    });

    it('refuses an edit to a read-only basic (primaryEmailAddress)', async () => {
      const connector = new AffinityConnector('k');
      await expect(
        connector.updateRecords(
          specWithSchema('persons', PERSON_SCHEMA),
          [{ id: 42 } as ConnectorFile],
          [{ primaryEmailAddress: 'x@y.com' }],
        ),
      ).rejects.toThrow(/not writable/);
      expect(mockUpdatePerson).not.toHaveBeenCalled();
    });

    it('renames an opportunity via v1 PUT', async () => {
      mockUpdateOpportunity.mockResolvedValue({ id: 11 });
      mockGetOpportunity.mockResolvedValue(makeOpportunity(11, 204872));
      const connector = new AffinityConnector('k');
      await connector.updateRecords(
        buildTableSpec('opportunities'),
        [{ id: 11, name: 'Renamed' } as ConnectorFile],
        [{ name: 'Renamed' }],
      );
      expect(mockUpdateOpportunity).toHaveBeenCalledWith(11, { name: 'Renamed' });
    });
  });

  describe('deleteRecords', () => {
    it('deletes person/company/opportunity/list-entry via v1', async () => {
      const connector = new AffinityConnector('k');
      await connector.deleteRecords(buildTableSpec('persons'), [{ id: 1 } as ConnectorFile]);
      expect(mockDeletePerson).toHaveBeenCalledWith(1);
      await connector.deleteRecords(buildTableSpec('companies'), [{ id: 2 } as ConnectorFile]);
      expect(mockDeleteCompany).toHaveBeenCalledWith(2);
      await connector.deleteRecords(buildTableSpec('opportunities'), [{ id: 3 } as ConnectorFile]);
      expect(mockDeleteOpportunity).toHaveBeenCalledWith(3);
      await connector.deleteRecords(buildTableSpec('197394'), [{ id: 4 } as ConnectorFile]);
      expect(mockDeleteListEntry).toHaveBeenCalledWith(197394, 4);
    });

    it('refuses to delete entity files', async () => {
      const connector = new AffinityConnector('k');
      await expect(
        connector.deleteRecords(buildTableSpec('entity-files'), [{ id: 1 } as ConnectorFile]),
      ).rejects.toThrow(/read-only/);
    });
  });
});

// Users — read-only reference entity (workspace teammates) -----------------------

function makeUser(id: number) {
  return {
    id,
    firstName: `User${id}`,
    lastName: 'Test',
    photoUrl: null,
    primaryEmailAddress: `user${id}@example.com`,
    status: 'active',
    emailAddresses: [`user${id}@example.com`],
    role: 'admin',
  };
}

describe('AffinityConnector Users entity', () => {
  it('routes the users sentinel and exposes a Users table', async () => {
    expect(parseAffinityTableId({ wsId: 'users', remoteId: ['users'] })).toEqual({ kind: 'tenant-users' });
    mockListAllLists.mockResolvedValue([]);
    const connector = new AffinityConnector('k');
    const tables = await connector.listTables();
    const usersTable = tables.find((t) => t.id.remoteId[0] === 'users');
    expect(usersTable?.displayName).toBe('Users');
  });

  it('builds a flat read-only Users schema', async () => {
    const connector = new AffinityConnector('k');
    const spec = await connector.fetchJsonTableSpec({ wsId: 'users', remoteId: ['users'] });
    expect(spec.name).toBe('Users');
    const props = (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        'id',
        'firstName',
        'lastName',
        'photoUrl',
        'primaryEmailAddress',
        'status',
        'emailAddresses',
        'role',
      ]),
    );
    // Every column is read-only (reference table).
    for (const key of Object.keys(props)) {
      expect(props[key]['x-scratch-readonly']).toBe(true);
    }
  });

  it('streams users verbatim on pull', async () => {
    mockListAllUsers.mockReturnValue(singleBatch([makeUser(1), makeUser(2)]));
    const connector = new AffinityConnector('k');
    const collected: ConnectorFile[] = [];
    await connector.pullRecordFiles(
      buildTableSpec('users'),
      ({ files }) => {
        collected.push(...files);
        return Promise.resolve();
      },
      {},
      {} as never,
    );
    expect(collected).toHaveLength(2);
    expect((collected[0] as unknown as { role: string }).role).toBe('admin');
  });

  it('is read-only: create / update / delete all throw', async () => {
    const connector = new AffinityConnector('k');
    const spec = buildTableSpec('users');
    await expect(connector.createRecords(spec, [{ firstName: 'x' } as unknown as ConnectorFile])).rejects.toThrow(
      /read-only/,
    );
    await expect(connector.updateRecords(spec, [{ id: 1 } as unknown as ConnectorFile], [{}])).rejects.toThrow(
      /read-only/,
    );
    await expect(connector.deleteRecords(spec, [{ id: 1 } as unknown as ConnectorFile])).rejects.toThrow(/read-only/);
  });
});

// Write gate — ENABLE_AFFINITY_WRITE (DEV-10298) -------------------------------

describe('AffinityConnector write gate (ENABLE_AFFINITY_WRITE)', () => {
  const notesSpec = buildTableSpec('notes');
  // A creatable note must be attached to at least one entity (mirrors the
  // createRecords note test above), so the flag-on / inert paths reach the API.
  const noteFile = {
    content: { html: '<p>gate</p>' },
    personsPreview: { data: [{ id: 42 }], totalCount: 1 },
  } as unknown as ConnectorFile;

  it('refuses create / update / delete with a read-only error when the flag check returns false', async () => {
    const connector = new AffinityConnector('k', { isFeatureEnabled: () => Promise.resolve(false) });

    await expect(connector.createRecords(notesSpec, [noteFile])).rejects.toThrow(/ENABLE_AFFINITY_WRITE/);
    await expect(
      connector.updateRecords(notesSpec, [{ id: 7, content: { html: '<p>x</p>' } } as unknown as ConnectorFile], [{}]),
    ).rejects.toThrow(/read-only/i);
    await expect(connector.deleteRecords(notesSpec, [{ id: 7 } as unknown as ConnectorFile])).rejects.toThrow(
      /ENABLE_AFFINITY_WRITE/,
    );

    // The gate short-circuits before any API call.
    expect(mockCreateNote).not.toHaveBeenCalled();
    expect(mockUpdateNote).not.toHaveBeenCalled();
    expect(mockDeleteNote).not.toHaveBeenCalled();
  });

  it('checks exactly the ENABLE_AFFINITY_WRITE flag key (decoupled from the flag enum)', async () => {
    const isFeatureEnabled = jest.fn((): Promise<boolean> => Promise.resolve(false));
    const connector = new AffinityConnector('k', { isFeatureEnabled });

    await expect(connector.createRecords(notesSpec, [noteFile])).rejects.toThrow();

    expect(isFeatureEnabled).toHaveBeenCalledWith('ENABLE_AFFINITY_WRITE');
  });

  it('proceeds with the write when the flag check returns true', async () => {
    mockCreateNote.mockResolvedValue({ id: 555 });
    mockGetNote.mockResolvedValue(makeNote(555));
    const connector = new AffinityConnector('k', { isFeatureEnabled: () => Promise.resolve(true) });

    await connector.createRecords(notesSpec, [noteFile]);

    expect(mockCreateNote).toHaveBeenCalledTimes(1);
  });

  it('is inert when no flag check is wired (direct construction, e.g. tests): writes proceed', async () => {
    mockCreateNote.mockResolvedValue({ id: 556 });
    mockGetNote.mockResolvedValue(makeNote(556));
    const connector = new AffinityConnector('k'); // no isFeatureEnabled wired

    await connector.createRecords(notesSpec, [noteFile]);

    expect(mockCreateNote).toHaveBeenCalledTimes(1);
  });
});
