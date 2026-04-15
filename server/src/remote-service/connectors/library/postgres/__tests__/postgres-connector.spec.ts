import { Type } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { PostgresConnector } from '../postgres-connector';

jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'PostgreSQL'),
}));

const mockTestConnection = jest.fn();
const mockListTables = jest.fn();
const mockGetTableColumns = jest.fn();
const mockGetPrimaryKeyColumn = jest.fn();
const mockGetForeignKeys = jest.fn();
const mockSelectRows = jest.fn();
const mockSelectByIds = jest.fn();
const mockInsertRows = jest.fn();
const mockUpdateRows = jest.fn();
const mockDeleteRows = jest.fn();
const mockDisconnect = jest.fn();

jest.mock('../postgres-client', () => ({
  PostgresClient: jest.fn().mockImplementation(() => ({
    testConnection: mockTestConnection,
    listTables: mockListTables,
    getTableColumns: mockGetTableColumns,
    getPrimaryKeyColumn: mockGetPrimaryKeyColumn,
    getForeignKeys: mockGetForeignKeys,
    selectRows: mockSelectRows,
    selectByIds: mockSelectByIds,
    insertRows: mockInsertRows,
    updateRows: mockUpdateRows,
    deleteRows: mockDeleteRows,
    disconnect: mockDisconnect,
  })),
  PostgresClientError: class PostgresClientError extends Error {},
}));

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'smoke_records', remoteId: ['public', 'smoke_records'] },
    slug: 'smoke_records',
    name: 'smoke_records',
    schema: Type.Object({
      id: Type.Number(),
      name: Type.String(),
      status: Type.String(),
    }),
    idColumnRemoteId: 'id',
  };
}

describe('PostgresConnector CRUD batching', () => {
  let connector: PostgresConnector;
  const originalLocalBatchSize = process.env.LOCAL_POSTGRES_PUBLISH_BATCH_SIZE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LOCAL_POSTGRES_PUBLISH_BATCH_SIZE;
    connector = new PostgresConnector({ connectionString: 'postgres://test' });
  });

  afterAll(() => {
    if (originalLocalBatchSize === undefined) {
      delete process.env.LOCAL_POSTGRES_PUBLISH_BATCH_SIZE;
    } else {
      process.env.LOCAL_POSTGRES_PUBLISH_BATCH_SIZE = originalLocalBatchSize;
    }
  });

  it('creates records with a single batched client call', async () => {
    const files: ConnectorFile[] = [{ name: 'Record 1' }, { name: 'Record 2' }];
    mockInsertRows.mockResolvedValue([
      { id: 1, name: 'Record 1' },
      { id: 2, name: 'Record 2' },
    ]);

    const created = await connector.createRecords(buildTableSpec(), files);

    expect(mockInsertRows).toHaveBeenCalledTimes(1);
    expect(mockInsertRows).toHaveBeenCalledWith('smoke_records', files);
    expect(created).toEqual([
      { id: 1, name: 'Record 1' },
      { id: 2, name: 'Record 2' },
    ]);
  });

  it('updates records with a single batched client call and respects changedFields', async () => {
    const files: ConnectorFile[] = [
      { id: 1, name: 'Record 1.1', status: 'draft' },
      { id: 2, name: 'Record 2.1', status: 'published' },
    ];
    const changedFields: (Record<string, unknown> | undefined)[] = [{ name: 'Record 1.1' }, undefined];
    mockUpdateRows.mockResolvedValue(undefined);

    await connector.updateRecords(buildTableSpec(), files, changedFields);

    expect(mockUpdateRows).toHaveBeenCalledTimes(1);
    expect(mockUpdateRows).toHaveBeenCalledWith('smoke_records', 'id', [
      { id: 1, data: { name: 'Record 1.1' } },
      { id: 2, data: { name: 'Record 2.1', status: 'published' } },
    ]);
  });

  it('deletes records with a single batched client call', async () => {
    mockDeleteRows.mockResolvedValue(undefined);

    await connector.deleteRecords(buildTableSpec(), [{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(mockDeleteRows).toHaveBeenCalledTimes(1);
    expect(mockDeleteRows).toHaveBeenCalledWith('smoke_records', 'id', [1, 2, 3]);
  });

  it('uses the default publish batch size when no local override is set', () => {
    expect(connector.getBatchSize('create')).toBe(100);
    expect(connector.getBatchSize('update')).toBe(100);
    expect(connector.getBatchSize('delete')).toBe(100);
  });

  it('uses the local publish batch size override when set', () => {
    process.env.LOCAL_POSTGRES_PUBLISH_BATCH_SIZE = '2';

    expect(connector.getBatchSize('create')).toBe(2);
    expect(connector.getBatchSize('update')).toBe(2);
    expect(connector.getBatchSize('delete')).toBe(2);
  });
});
