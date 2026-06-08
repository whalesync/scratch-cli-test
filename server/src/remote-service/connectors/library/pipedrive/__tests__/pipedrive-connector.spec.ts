import { TSchema } from '@sinclair/typebox';
import { Service } from '../../../service-constants';
import { BaseJsonTableSpec, ConnectorFile, idPath } from '../../../types';
import { PipedriveConnector } from '../pipedrive-connector';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Pipedrive'),
}));

// Mock the API client
const mockTestConnection = jest.fn();
const mockGetFields = jest.fn();
const mockListEntities = jest.fn();
const mockGetEntity = jest.fn();
const mockCreateEntity = jest.fn();
const mockUpdateEntity = jest.fn();
const mockDeleteEntity = jest.fn();

jest.mock('../pipedrive-api-client', () => {
  return {
    PipedriveApiClient: jest.fn().mockImplementation(() => ({
      testConnection: mockTestConnection,
      getFields: mockGetFields,
      listEntities: mockListEntities,
      getEntity: mockGetEntity,
      createEntity: mockCreateEntity,
      updateEntity: mockUpdateEntity,
      deleteEntity: mockDeleteEntity,
    })),
    PipedriveError: class PipedriveError extends Error {
      statusCode?: number;
      code?: string;
      responseData?: unknown;
      constructor(message: string, statusCode?: number, code?: string, responseData?: unknown) {
        super(message);
        this.name = 'PipedriveError';
        this.statusCode = statusCode;
        this.code = code;
        this.responseData = responseData;
      }
    },
  };
});

function buildTableSpec(entityType: string): BaseJsonTableSpec {
  return {
    id: { wsId: entityType, remoteId: [entityType] },
    slug: entityType,
    name: entityType,
    schema: {} as unknown as TSchema,
    idColumnRemoteId: idPath('id'),
  };
}

describe('PipedriveConnector', () => {
  let connector: PipedriveConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new PipedriveConnector('test-api-key');
    // Setup default mock for getFields to populate custom field cache
    mockGetFields.mockResolvedValue([
      { field_code: 'title', field_name: 'Title', field_type: 'varchar', is_custom_field: false },
      { field_code: 'abc123', field_name: 'Custom', field_type: 'varchar', is_custom_field: true },
    ]);
  });

  describe('service', () => {
    it('returns PIPEDRIVE service', () => {
      expect(connector.service).toBe(Service.PIPEDRIVE);
    });
  });

  describe('listTables', () => {
    it('returns all supported entity types (v2 + v1)', async () => {
      const tables = await connector.listTables();
      expect(tables).toHaveLength(9);

      const ids = tables.map((t) => t.id.wsId);
      expect(ids).toEqual(
        expect.arrayContaining([
          'deals',
          'persons',
          'organizations',
          'products',
          'activities',
          'leads',
          'notes',
          'pipelines',
          'stages',
        ]),
      );
    });

    it('includes display names', async () => {
      const tables = await connector.listTables();
      const deals = tables.find((t) => t.id.wsId === 'deals');
      expect(deals?.displayName).toBe('Deals');
      const leads = tables.find((t) => t.id.wsId === 'leads');
      expect(leads?.displayName).toBe('Leads');
    });
  });

  describe('createRecords', () => {
    it('creates records and returns results with IDs', async () => {
      mockCreateEntity.mockResolvedValue({ id: 42, title: 'New Deal' });

      const tableSpec = buildTableSpec('deals');
      const files: ConnectorFile[] = [{ title: 'New Deal' }];

      const results = await connector.createRecords(tableSpec, files);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ id: 42, title: 'New Deal' });
      expect(mockCreateEntity).toHaveBeenCalledWith('deals', { title: 'New Deal' }, expect.any(Set));
    });
  });

  describe('updateRecords', () => {
    it('updates records with full data when no changedFields', async () => {
      mockUpdateEntity.mockResolvedValue({});

      const tableSpec = buildTableSpec('deals');
      const files: ConnectorFile[] = [{ id: 42, title: 'Updated Deal', value: 100 }];

      await connector.updateRecords(tableSpec, files);

      expect(mockUpdateEntity).toHaveBeenCalledWith(
        'deals',
        42,
        { title: 'Updated Deal', value: 100 },
        expect.any(Set),
      );
    });

    it('sends only changed fields when changedFields is provided', async () => {
      mockUpdateEntity.mockResolvedValue({});

      const tableSpec = buildTableSpec('deals');
      const files: ConnectorFile[] = [{ id: 42, title: 'Updated', value: 100, status: 'open' }];
      const changedFields: (Record<string, unknown> | undefined)[] = [{ title: 'Updated' }];

      await connector.updateRecords(tableSpec, files, changedFields);

      expect(mockUpdateEntity).toHaveBeenCalledWith('deals', 42, { title: 'Updated' }, expect.any(Set));
    });
  });

  describe('deleteRecords', () => {
    it('deletes records by ID', async () => {
      mockDeleteEntity.mockResolvedValue(undefined);

      const tableSpec = buildTableSpec('deals');
      const files: ConnectorFile[] = [{ id: 1 }, { id: 2 }];

      await connector.deleteRecords(tableSpec, files);

      expect(mockDeleteEntity).toHaveBeenCalledTimes(2);
      expect(mockDeleteEntity).toHaveBeenCalledWith('deals', 1);
      expect(mockDeleteEntity).toHaveBeenCalledWith('deals', 2);
    });
  });

  describe('v1 entity id handling', () => {
    it('passes a lead UUID id through unparsed on update/delete', async () => {
      mockUpdateEntity.mockResolvedValue({});
      mockDeleteEntity.mockResolvedValue(undefined);
      const tableSpec = buildTableSpec('leads');
      const uuid = 'f597f430-2d98-11ef-ba6b-4936cb336154';

      await connector.updateRecords(tableSpec, [{ id: uuid } as unknown as ConnectorFile], [{ title: 'X' }]);
      await connector.deleteRecords(tableSpec, [{ id: uuid } as unknown as ConnectorFile]);

      expect(mockUpdateEntity).toHaveBeenCalledWith('leads', uuid, { title: 'X' }, expect.any(Set));
      expect(mockDeleteEntity).toHaveBeenCalledWith('leads', uuid);
    });

    it('fetches leads by their UUID id (not skipped as non-numeric)', async () => {
      mockGetEntity.mockResolvedValue({ id: 'lead-uuid', title: 'Lead' });
      const tableSpec = buildTableSpec('leads');

      const got: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(tableSpec, ['lead-uuid'], async ({ files }) => {
        got.push(...files);
        return Promise.resolve();
      });

      expect(mockGetEntity).toHaveBeenCalledWith('leads', 'lead-uuid');
      expect(got).toEqual([{ id: 'lead-uuid', title: 'Lead' }]);
    });

    it('parses integer note ids (and skips a non-numeric one)', async () => {
      mockDeleteEntity.mockResolvedValue(undefined);
      const tableSpec = buildTableSpec('notes');

      await connector.deleteRecords(tableSpec, [{ id: '42' }, { id: 'not-a-number' }] as unknown as ConnectorFile[]);

      expect(mockDeleteEntity).toHaveBeenCalledTimes(1);
      expect(mockDeleteEntity).toHaveBeenCalledWith('notes', 42);
    });
  });

  describe('getBatchSize', () => {
    it('returns 1 since Pipedrive has no bulk API', () => {
      expect(connector.getBatchSize()).toBe(1);
    });
  });
});
