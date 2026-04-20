import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, EntityId } from '../../../types';
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
    idColumnRemoteId: 'id',
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
  it('returns 3 tenant tables at the top level plus user lists under "Lists/"', async () => {
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
    ]);

    // List tables come after tenant tables, all flat under "Lists/" regardless of entity type.
    const lists = tables.filter((t) => t.parentPath === 'Lists');
    expect(lists).toHaveLength(2);
    expect(lists.map((t) => t.displayName)).toEqual(['My People List', 'My Company List']);
    expect(lists.map((t) => t.id.remoteId[0])).toEqual(['101', '102']);
  });

  it('still returns the 3 tenant tables when there are no user-created lists', async () => {
    mockListAllLists.mockResolvedValue([]);

    const connector = new AffinityConnector('fake-key');
    const tables = await connector.listTables();

    expect(tables).toHaveLength(5);
    expect(tables.map((t) => t.displayName)).toEqual(['Companies', 'People', 'Opportunities', 'Notes', 'Entity Files']);
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
