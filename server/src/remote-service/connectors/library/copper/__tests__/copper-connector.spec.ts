import { BaseJsonTableSpec, ConnectorFile, EntityId } from '../../../types';
import { CopperError } from '../copper-api-client';
import { CopperConnector } from '../copper-connector';
import { buildCopperJsonTableSpec } from '../copper-json-schema';
import { CopperEntityType } from '../copper-types';

// Break the circular import chain through ../../connector -> display-names.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Copper'),
}));

// Mock the low-level API client; keep CopperError a real Error subclass.
const mockTestConnection = jest.fn();
const mockListCustomFieldDefinitions = jest.fn();
const mockListEntities = jest.fn();
const mockGetEntity = jest.fn();
const mockCreateEntity = jest.fn();
const mockUpdateEntity = jest.fn();
const mockDeleteEntity = jest.fn();

jest.mock('../copper-api-client', () => ({
  CopperApiClient: jest.fn().mockImplementation(() => ({
    testConnection: mockTestConnection,
    listCustomFieldDefinitions: mockListCustomFieldDefinitions,
    listEntities: mockListEntities,
    getEntity: mockGetEntity,
    createEntity: mockCreateEntity,
    updateEntity: mockUpdateEntity,
    deleteEntity: mockDeleteEntity,
  })),
  CopperError: class CopperError extends Error {
    statusCode?: number;
    responseData?: unknown;
    constructor(message: string, statusCode?: number, responseData?: unknown) {
      super(message);
      this.name = 'CopperError';
      this.statusCode = statusCode;
      this.responseData = responseData;
    }
  },
}));

/** A real schema (with readonly + FK annotations) so write-path stripping is exercised end-to-end. */
function realTableSpec(entityType: CopperEntityType): BaseJsonTableSpec {
  const id: EntityId = { wsId: entityType, remoteId: [entityType] };
  return buildCopperJsonTableSpec(id, entityType, []);
}

describe('CopperConnector', () => {
  let connector: CopperConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new CopperConnector({ apiKey: 'test-key', email: 'user@example.com' });
  });

  describe('listTables', () => {
    it('returns the six writable entity types followed by the read-only reference tables', async () => {
      const tables = await connector.listTables();
      expect(tables).toHaveLength(8);
      const ids = tables.map((t) => t.id.wsId);
      expect(ids).toEqual([
        'people',
        'companies',
        'opportunities',
        'leads',
        'tasks',
        'projects',
        'pipelines',
        'pipeline_stages',
      ]);
    });

    it('marks pipelines / pipeline_stages as read-only reference tables (no CRUD)', async () => {
      const tables = await connector.listTables();
      for (const refId of ['pipelines', 'pipeline_stages']) {
        const table = tables.find((t) => t.id.wsId === refId);
        expect(table?.disabledCreates).toBe(true);
        expect(table?.disabledUpdates).toBe(true);
        expect(table?.disabledDeletes).toBe(true);
        expect(table?.disabledReason).toBeTruthy();
      }
    });

    it('includes display names', async () => {
      const tables = await connector.listTables();
      expect(tables.find((t) => t.id.wsId === 'people')?.displayName).toBe('People');
      expect(tables.find((t) => t.id.wsId === 'pipelines')?.displayName).toBe('Pipelines');
    });
  });

  describe('getBatchSize', () => {
    it('returns 1 (one request per record in v1)', () => {
      expect(connector.getBatchSize()).toBe(1);
    });
  });

  describe('createRecords', () => {
    it('strips read-only fields and returns the response carrying the assigned id (R2)', async () => {
      mockCreateEntity.mockResolvedValue({ id: 42, name: 'Ada' });

      const files: ConnectorFile[] = [{ name: 'Ada', id: 'pending', date_created: 111, interaction_count: 7 }];
      const results = await connector.createRecords(realTableSpec('people'), files);

      // id / date_created / interaction_count are read-only — never sent.
      expect(mockCreateEntity).toHaveBeenCalledWith('people', { name: 'Ada' });
      expect(results).toEqual([{ id: 42, name: 'Ada' }]);
    });
  });

  describe('updateRecords', () => {
    it('sends full writable data when no changedFields, stripping read-only fields incl. company_id (R8)', async () => {
      mockUpdateEntity.mockResolvedValue({});

      const files: ConnectorFile[] = [{ id: 42, name: 'New', company_id: 5, date_modified: 999 }];
      await connector.updateRecords(realTableSpec('people'), files);

      // company_id is read-only in v1 (set via Related Items); date_modified is computed.
      expect(mockUpdateEntity).toHaveBeenCalledWith('people', 42, { name: 'New' });
    });

    it('sends only the sparse changedFields when provided (R1)', async () => {
      mockUpdateEntity.mockResolvedValue({});

      const files: ConnectorFile[] = [{ id: 42, name: 'New', title: 'Boss', details: 'x' }];
      const changedFields = [{ title: 'Updated Title Only' }];
      await connector.updateRecords(realTableSpec('people'), files, changedFields);

      expect(mockUpdateEntity).toHaveBeenCalledWith('people', 42, { title: 'Updated Title Only' });
    });
  });

  describe('deleteRecords', () => {
    it('deletes each record by id', async () => {
      mockDeleteEntity.mockResolvedValue(undefined);

      await connector.deleteRecords(realTableSpec('people'), [{ id: 1 }, { id: 2 }]);

      expect(mockDeleteEntity).toHaveBeenCalledTimes(2);
      expect(mockDeleteEntity).toHaveBeenCalledWith('people', 1);
      expect(mockDeleteEntity).toHaveBeenCalledWith('people', 2);
    });
  });

  describe('pullRecordFiles', () => {
    it('resumes from the checkpointed page and re-checkpoints the next page (R3)', async () => {
      // eslint-disable-next-line @typescript-eslint/require-await
      mockListEntities.mockImplementation(async function* () {
        yield { records: [{ id: 1 }], nextPage: 4 };
      });

      const callback = jest.fn().mockResolvedValue(undefined);
      await connector.pullRecordFiles(realTableSpec('people'), callback, { nextPage: 3 }, {});

      // startPage taken from progress.nextPage (3).
      expect(mockListEntities).toHaveBeenCalledWith('people', undefined, 3);
      expect(callback).toHaveBeenCalledWith({ files: [{ id: 1 }], connectorProgress: { nextPage: 4 } });
    });

    it('starts from page 1 when there is no prior progress', async () => {
      mockListEntities.mockImplementation(function* () {
        // no pages
      });

      await connector.pullRecordFiles(realTableSpec('people'), jest.fn(), {}, {});
      expect(mockListEntities).toHaveBeenCalledWith('people', undefined, 1);
    });
  });

  describe('pullRecordFilesByIds', () => {
    it('fetches each id and skips 404s (null)', async () => {
      mockGetEntity.mockImplementation((_type: string, id: number) =>
        Promise.resolve(id === 2 ? null : { id, name: `r${id}` }),
      );

      const callback = jest.fn().mockResolvedValue(undefined);
      await connector.pullRecordFilesByIds(realTableSpec('people'), ['1', '2', '3'], callback);

      const calls = callback.mock.calls as Array<[{ files: ConnectorFile[] }]>;
      const pulled = calls.flatMap((c) => c[0].files);
      expect(pulled).toEqual([
        { id: 1, name: 'r1' },
        { id: 3, name: 'r3' },
      ]);
    });
  });

  describe('extractConnectorErrorDetails', () => {
    it('maps a CopperError to a user-friendly message', () => {
      const details = connector.extractConnectorErrorDetails(new CopperError('Invalid API token or email', 401));
      expect(details.userFriendlyMessage).toBe('Invalid API token or email');
      expect(details.additionalContext?.status).toBe(401);
    });
  });

  describe('resolveEntityType', () => {
    it('throws for an unknown entity type', async () => {
      const badSpec: BaseJsonTableSpec = { ...realTableSpec('people'), id: { wsId: 'widgets', remoteId: ['widgets'] } };
      await expect(connector.createRecords(badSpec, [{ name: 'x' }])).rejects.toThrow(/Copper supports/);
    });
  });
});
