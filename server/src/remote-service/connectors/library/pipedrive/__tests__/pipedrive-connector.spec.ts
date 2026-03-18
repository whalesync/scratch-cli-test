/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Service } from '../../../service-constants';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { PipedriveConnector } from '../pipedrive-connector';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Pipedrive'),
}));

// Mock the pipedrive SDK
jest.mock('pipedrive/v2', () => {
  return {
    Configuration: jest.fn(),
    DealsApi: jest.fn(),
    PersonsApi: jest.fn(),
    OrganizationsApi: jest.fn(),
    DealFieldsApi: jest.fn(),
    PersonFieldsApi: jest.fn(),
    OrganizationFieldsApi: jest.fn(),
  };
});

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
    schema: {} as any,
    idColumnRemoteId: 'id',
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
    it('returns all three entity types', async () => {
      const tables = await connector.listTables();
      expect(tables).toHaveLength(3);

      const ids = tables.map((t) => t.id.wsId);
      expect(ids).toContain('deals');
      expect(ids).toContain('persons');
      expect(ids).toContain('organizations');
    });

    it('includes display names', async () => {
      const tables = await connector.listTables();
      const deals = tables.find((t) => t.id.wsId === 'deals');
      expect(deals?.displayName).toBe('Deals');
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
    it('updates records with full data when no changedKeys', async () => {
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

    it('sends only changed fields when changedKeys is provided', async () => {
      mockUpdateEntity.mockResolvedValue({});

      const tableSpec = buildTableSpec('deals');
      const files: ConnectorFile[] = [{ id: 42, title: 'Updated', value: 100, status: 'open' }];
      const changedKeys: (string[] | undefined)[] = [['title']];

      await connector.updateRecords(tableSpec, files, changedKeys);

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

  describe('getBatchSize', () => {
    it('returns 1 since Pipedrive has no bulk API', () => {
      expect(connector.getBatchSize('create')).toBe(1);
    });
  });
});
