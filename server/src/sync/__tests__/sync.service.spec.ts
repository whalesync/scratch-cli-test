/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataFolderId, SaveSyncBody, SyncId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { SyncService, transformRecordAsync } from '../sync.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('src/sync/schema-validator', () => ({
  validateSchemaMapping: jest.fn().mockReturnValue([]),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateSchemaMapping } = require('src/sync/schema-validator') as {
  validateSchemaMapping: jest.Mock;
};

// ---------------------------------------------------------------------------
// Test constants & helpers
// ---------------------------------------------------------------------------

const WORKBOOK_ID = 'wkb_test123' as WorkbookId;
const SYNC_ID = 'syn_test456' as SyncId;
const SOURCE_FOLDER_ID = 'dfd_src1' as DataFolderId;
const DEST_FOLDER_ID = 'dfd_dest1' as DataFolderId;
const ACTOR: Actor = { userId: 'usr_abc', organizationId: 'org_xyz' };

function makeSaveSyncBody(overrides?: Partial<SaveSyncBody>): SaveSyncBody {
  return {
    displayName: 'Test Sync',
    mappings: {
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SOURCE_FOLDER_ID,
          destinationDataFolderId: DEST_FOLDER_ID,
          columnMappings: [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
        },
      ],
    },
    ...overrides,
  };
}

const MOCK_WORKBOOK = { id: WORKBOOK_ID, organizationId: 'org_xyz' };
const MOCK_SYNC = { id: SYNC_ID, displayName: 'Test Sync', mappings: {} };
const MOCK_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, name: { type: 'string' } },
};

describe('SyncService', () => {
  let service: SyncService;
  let dbService: jest.Mocked<DbService>;
  let dataFolderService: jest.Mocked<DataFolderService>;
  let posthogService: jest.Mocked<PostHogService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let workbookService: jest.Mocked<WorkbookService>;

  beforeEach(() => {
    dbService = {
      client: {
        sync: {
          create: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
        },
        syncTablePair: { deleteMany: jest.fn() },
        dataFolder: { findUnique: jest.fn() },
        $transaction: jest.fn(),
      },
    } as unknown as jest.Mocked<DbService>;

    dataFolderService = {
      fetchSchemaSpec: jest.fn(),
    } as unknown as jest.Mocked<DataFolderService>;

    posthogService = {
      trackCreateSync: jest.fn(),
      trackUpdateSync: jest.fn(),
      trackRemoveSync: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    scratchGitService = {
      getRepoFile: jest.fn(),
    } as unknown as jest.Mocked<ScratchGitService>;

    workbookService = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<WorkbookService>;

    service = new SyncService(dbService, dataFolderService, posthogService, scratchGitService, workbookService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // createSync
  // ===========================================================================
  describe('createSync', () => {
    it('creates a sync with correct Prisma payload', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      const createdSync = { id: SYNC_ID, displayName: 'Test Sync', syncTablePairs: [] };
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(createdSync);

      const body = makeSaveSyncBody();
      const result = await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(result).toEqual(createdSync);
      expect(dbService.client.sync.create).toHaveBeenCalledTimes(1);

      const createArg = (dbService.client.sync.create as jest.Mock).mock.calls[0][0];
      expect(createArg.data.displayName).toBe('Test Sync');
      expect(createArg.data.mappings.version).toBe(1);
      expect(createArg.data.mappings.tableMappings).toHaveLength(1);
      expect(createArg.data.mappings.tableMappings[0].sourceDataFolderId).toBe(SOURCE_FOLDER_ID);
      expect(createArg.data.mappings.tableMappings[0].destinationDataFolderId).toBe(DEST_FOLDER_ID);
      expect(createArg.data.mappings.tableMappings[0].columnMappings).toEqual([
        { sourceColumnId: 'title', destinationColumnId: 'name' },
      ]);
      expect(createArg.data.syncTablePairs.create).toHaveLength(1);
      expect(createArg.include.syncTablePairs).toBe(true);
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.createSync(WORKBOOK_ID, makeSaveSyncBody(), ACTOR)).rejects.toThrow(NotFoundException);
      expect(dbService.client.sync.create).not.toHaveBeenCalled();
    });

    it('calls fetchSchemaSpec for each table mapping and validates when schemas present', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      dataFolderService.fetchSchemaSpec.mockResolvedValue({ schema: MOCK_SCHEMA } as any);
      validateSchemaMapping.mockReturnValue([]);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody();
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledTimes(2);
      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledWith(SOURCE_FOLDER_ID, ACTOR);
      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledWith(DEST_FOLDER_ID, ACTOR);
    });

    it('skips validation gracefully when schemas are absent', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      dataFolderService.fetchSchemaSpec.mockResolvedValue(null);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody();
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(validateSchemaMapping).not.toHaveBeenCalled();
      expect(dbService.client.sync.create).toHaveBeenCalled();
    });

    it('throws NotFoundException when source schema present but dest schema missing', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      dataFolderService.fetchSchemaSpec
        .mockResolvedValueOnce({ schema: MOCK_SCHEMA } as any)
        .mockResolvedValueOnce(null);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody();
      // Should skip validation since one schema is missing
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      expect(validateSchemaMapping).not.toHaveBeenCalled();
    });

    it('throws BadRequestException on schema validation errors', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      dataFolderService.fetchSchemaSpec.mockResolvedValue({ schema: MOCK_SCHEMA } as any);
      validateSchemaMapping.mockReturnValue(['Type mismatch for field X']);

      const body = makeSaveSyncBody();

      await expect(service.createSync(WORKBOOK_ID, body, ACTOR)).rejects.toThrow(BadRequestException);
    });

    it('creates multiple syncTablePairs for multiple table mappings', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: 'dfd_src1' as DataFolderId,
              destinationDataFolderId: 'dfd_dest1' as DataFolderId,
              columnMappings: [{ sourceColumnId: 'a', destinationColumnId: 'b' }],
            },
            {
              sourceDataFolderId: 'dfd_src2' as DataFolderId,
              destinationDataFolderId: 'dfd_dest2' as DataFolderId,
              columnMappings: [{ sourceColumnId: 'c', destinationColumnId: 'd' }],
            },
          ],
        },
      });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const createArg = (dbService.client.sync.create as jest.Mock).mock.calls[0][0];
      expect(createArg.data.mappings.tableMappings).toHaveLength(2);
      expect(createArg.data.syncTablePairs.create).toHaveLength(2);
    });

    it('includes recordMatching when set', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_addr' }],
              recordMatching: {
                sourceColumnId: 'email',
                destinationColumnId: 'email_addr',
              },
            },
          ],
        },
      });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const tableMapping = (dbService.client.sync.create as jest.Mock).mock.calls[0][0].data.mappings.tableMappings[0];
      expect(tableMapping.recordMatching).toEqual({
        sourceColumnId: 'email',
        destinationColumnId: 'email_addr',
      });
    });

    it('omits recordMatching when not set', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody();
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const tableMapping = (dbService.client.sync.create as jest.Mock).mock.calls[0][0].data.mappings.tableMappings[0];
      expect(tableMapping.recordMatching).toBeUndefined();
    });

    it('calls PostHog tracking after creation', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      const createdSync = { id: SYNC_ID };
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(createdSync);

      await service.createSync(WORKBOOK_ID, makeSaveSyncBody(), ACTOR);

      expect(posthogService.trackCreateSync).toHaveBeenCalledWith(ACTOR, createdSync);
    });

    it('handles columnMappings with transformer', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [
                {
                  sourceColumnId: 'price',
                  destinationColumnId: 'amount',
                  transformer: { type: 'string_to_number', options: { stripCurrency: true } },
                },
              ],
            },
          ],
        },
      });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const columnMappings = (dbService.client.sync.create as jest.Mock).mock.calls[0][0].data.mappings.tableMappings[0]
        .columnMappings;
      expect(columnMappings).toEqual([
        {
          sourceColumnId: 'price',
          destinationColumnId: 'amount',
          transformer: { type: 'string_to_number', options: { stripCurrency: true } },
        },
      ]);
    });

    it('handles multiple simple column mappings', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [
                { sourceColumnId: 'title', destinationColumnId: 'name' },
                { sourceColumnId: 'slug', destinationColumnId: 'url_slug' },
              ],
            },
          ],
        },
      });
      await service.createSync(WORKBOOK_ID, body, ACTOR);

      const columnMappings = (dbService.client.sync.create as jest.Mock).mock.calls[0][0].data.mappings.tableMappings[0]
        .columnMappings;
      expect(columnMappings).toEqual([
        { sourceColumnId: 'title', destinationColumnId: 'name' },
        { sourceColumnId: 'slug', destinationColumnId: 'url_slug' },
      ]);
    });
  });

  // ===========================================================================
  // updateSync
  // ===========================================================================
  describe('updateSync', () => {
    it('deletes old pairs and updates sync in transaction', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const updatedSync = { id: SYNC_ID, displayName: 'Updated', syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const tx = {
          syncTablePair: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
          sync: { update: jest.fn().mockResolvedValue(updatedSync) },
        };
        return fn(tx);
      });

      const body = makeSaveSyncBody({ displayName: 'Updated' });
      const result = await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(result).toEqual(updatedSync);
      expect(dbService.client.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, makeSaveSyncBody(), ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when sync not found', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, makeSaveSyncBody(), ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when record matching fields are not in column mappings', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_addr' }],
              recordMatching: {
                sourceColumnId: 'email',
                destinationColumnId: 'WRONG_FIELD',
              },
            },
          ],
        },
      });

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR)).rejects.toThrow(BadRequestException);
    });

    it('passes when record matching fields are aligned with column mappings', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);

      const body = makeSaveSyncBody({
        mappings: {
          version: 1,
          tableMappings: [
            {
              sourceDataFolderId: SOURCE_FOLDER_ID,
              destinationDataFolderId: DEST_FOLDER_ID,
              columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_addr' }],
              recordMatching: {
                sourceColumnId: 'email',
                destinationColumnId: 'email_addr',
              },
            },
          ],
        },
      });

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR)).resolves.toBeDefined();
    });

    it('validates schema mappings when schemas are present', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      dataFolderService.fetchSchemaSpec.mockResolvedValue({ schema: MOCK_SCHEMA } as any);
      validateSchemaMapping.mockReturnValue([]);
      (dbService.client.$transaction as jest.Mock).mockResolvedValue({ id: SYNC_ID, syncTablePairs: [] });

      const body = makeSaveSyncBody();
      await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledTimes(2);
      expect(validateSchemaMapping).toHaveBeenCalled();
    });

    it('skips validation when schemas are absent', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      dataFolderService.fetchSchemaSpec.mockResolvedValue(null);
      (dbService.client.$transaction as jest.Mock).mockResolvedValue({ id: SYNC_ID, syncTablePairs: [] });

      const body = makeSaveSyncBody();
      await service.updateSync(WORKBOOK_ID, SYNC_ID, body, ACTOR);

      expect(validateSchemaMapping).not.toHaveBeenCalled();
    });

    it('calls PostHog tracking after update', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);

      await service.updateSync(WORKBOOK_ID, SYNC_ID, makeSaveSyncBody(), ACTOR);

      expect(posthogService.trackUpdateSync).toHaveBeenCalledWith(ACTOR, updatedSync);
    });
  });

  // ===========================================================================
  // findOneForWorkbook
  // ===========================================================================
  describe('findOneForWorkbook', () => {
    const mockSyncWithPairs = { id: SYNC_ID, displayName: 'Test Sync', syncTablePairs: [] };

    it('returns sync scoped to workbook with syncTablePairs included', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(mockSyncWithPairs);

      const result = await service.findOneForWorkbook(WORKBOOK_ID, SYNC_ID, ACTOR);

      expect(result).toEqual(mockSyncWithPairs);
      expect(dbService.client.sync.findFirst).toHaveBeenCalledWith({
        where: {
          id: SYNC_ID,
          syncTablePairs: { some: { sourceDataFolder: { workbookId: WORKBOOK_ID } } },
        },
        include: { syncTablePairs: true },
      });
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.findOneForWorkbook(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);
      expect(dbService.client.sync.findFirst).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when sync not found', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.findOneForWorkbook(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });
  });

  // ===========================================================================
  // findAllForWorkbook
  // ===========================================================================
  describe('findAllForWorkbook', () => {
    it('returns syncs scoped to workbook, ordered by createdAt desc', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      const syncs = [{ id: 'syn_1' }, { id: 'syn_2' }];
      (dbService.client.sync.findMany as jest.Mock).mockResolvedValue(syncs);

      const result = await service.findAllForWorkbook(WORKBOOK_ID, ACTOR);

      expect(result).toEqual(syncs);
      expect(dbService.client.sync.findMany).toHaveBeenCalledWith({
        where: {
          syncTablePairs: { some: { sourceDataFolder: { workbookId: WORKBOOK_ID } } },
        },
        include: { syncTablePairs: true },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.findAllForWorkbook(WORKBOOK_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('returns empty array when no syncs exist', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.findAllForWorkbook(WORKBOOK_ID, ACTOR);

      expect(result).toEqual([]);
    });
  });

  // ===========================================================================
  // deleteSync
  // ===========================================================================
  describe('deleteSync', () => {
    it('deletes sync and tracks in PostHog', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.sync.delete as jest.Mock).mockResolvedValue(MOCK_SYNC);

      await service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR);

      expect(dbService.client.sync.delete).toHaveBeenCalledWith({ where: { id: SYNC_ID } });
      expect(posthogService.trackRemoveSync).toHaveBeenCalledWith(ACTOR, MOCK_SYNC);
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when sync not found, delete NOT called', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);
      expect(dbService.client.sync.delete).not.toHaveBeenCalled();
    });

    it('scopes sync query to workbook via syncTablePairs', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteSync(WORKBOOK_ID, SYNC_ID, ACTOR)).rejects.toThrow(NotFoundException);

      expect(dbService.client.sync.findFirst).toHaveBeenCalledWith({
        where: {
          id: SYNC_ID,
          syncTablePairs: { some: { sourceDataFolder: { workbookId: WORKBOOK_ID } } },
        },
      });
    });
  });

  // ===========================================================================
  // validateFolderMapping
  // ===========================================================================
  describe('validateFolderMapping', () => {
    it('returns true when both schemas are present', async () => {
      dataFolderService.fetchSchemaSpec
        .mockResolvedValueOnce({ schema: MOCK_SCHEMA } as any)
        .mockResolvedValueOnce({ schema: MOCK_SCHEMA } as any);

      const result = await service.validateFolderMapping(
        WORKBOOK_ID,
        SOURCE_FOLDER_ID,
        DEST_FOLDER_ID,
        [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
        ACTOR,
      );

      // Current implementation always returns true
      expect(result).toBe(true);
    });

    it('returns true when source schema is missing (loose validation)', async () => {
      dataFolderService.fetchSchemaSpec
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ schema: MOCK_SCHEMA } as any);

      const result = await service.validateFolderMapping(
        WORKBOOK_ID,
        SOURCE_FOLDER_ID,
        DEST_FOLDER_ID,
        [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
        ACTOR,
      );

      expect(result).toBe(true);
    });

    it('returns true when dest schema is missing (loose validation)', async () => {
      dataFolderService.fetchSchemaSpec
        .mockResolvedValueOnce({ schema: MOCK_SCHEMA } as any)
        .mockResolvedValueOnce(null);

      const result = await service.validateFolderMapping(
        WORKBOOK_ID,
        SOURCE_FOLDER_ID,
        DEST_FOLDER_ID,
        [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
        ACTOR,
      );

      expect(result).toBe(true);
    });
  });
});

// ===========================================================================
// transformRecordAsync (standalone function)
// ===========================================================================
describe('transformRecordAsync', () => {
  describe('key ordering preservation', () => {
    it('preserves original key order when updating an existing record via baseFields', async () => {
      // Simulate the exact scenario from the bug: a destination JSON file has keys in a
      // specific order (id, cmsLocaleId, ..., fieldData). After syncing, the key order
      // must remain identical — only the mapped field values should change.
      const existingFields = {
        id: '6994a4d364f1775dd68f1589',
        cmsLocaleId: '6930533529443b9f130b26e6',
        lastPublished: '2026-02-17T17:26:43.762Z',
        lastUpdated: '2026-02-17T17:26:43.762Z',
        createdOn: '2026-02-17T17:26:43.762Z',
        isArchived: false,
        isDraft: false,
        fieldData: {
          'airtable-id': 'rechCcin6LPjgFMfY',
          name: 'Atlantic Mackerel',
          slug: 'atlantic-mackerel',
        },
      };

      const sourceRecord = {
        id: 'rechCcin6LPjgFMfY',
        filePath: 'source/atlantic-mackerel.json',
        fields: {
          Name: 'Atlantic Mackerel',
          Link: 'https://en.wikipedia.org/wiki/Atlantic_mackerel',
        },
      };

      const columnMappings = [
        { sourceColumnId: 'Name', destinationColumnId: 'fieldData.name' },
        { sourceColumnId: 'Link', destinationColumnId: 'fieldData.link' },
      ];

      const result = await transformRecordAsync(sourceRecord, columnMappings, undefined, 'DATA', existingFields);

      // The mapped fields should be updated/added
      expect((result as any).fieldData.name).toBe('Atlantic Mackerel');
      expect((result as any).fieldData.link).toBe('https://en.wikipedia.org/wiki/Atlantic_mackerel');

      // Non-mapped fields must still be present
      expect(result.id).toBe('6994a4d364f1775dd68f1589');
      expect(result.cmsLocaleId).toBe('6930533529443b9f130b26e6');
      expect(result.isArchived).toBe(false);

      // CRITICAL: Key order must match the original. JSON.stringify uses insertion order,
      // so serializing the result must produce keys in the same order as the original object.
      const resultKeys = Object.keys(result);
      const originalKeys = Object.keys(existingFields);
      expect(resultKeys).toEqual(originalKeys);
    });

    it('does not mutate the original baseFields object', async () => {
      const existingFields = { id: '123', name: 'Original' };
      const sourceRecord = {
        id: 'src1',
        filePath: 'source/test.json',
        fields: { title: 'Updated' },
      };
      const columnMappings = [{ sourceColumnId: 'title', destinationColumnId: 'name' }];

      await transformRecordAsync(sourceRecord, columnMappings, undefined, 'DATA', existingFields);

      expect(existingFields.name).toBe('Original');
    });

    it('builds a fresh object without baseFields (new record)', async () => {
      const sourceRecord = {
        id: 'src1',
        filePath: 'source/test.json',
        fields: { title: 'New Item', slug: 'new-item' },
      };
      const columnMappings = [
        { sourceColumnId: 'title', destinationColumnId: 'fieldData.name' },
        { sourceColumnId: 'slug', destinationColumnId: 'fieldData.slug' },
      ];

      const result = await transformRecordAsync(sourceRecord, columnMappings);

      expect((result as any).fieldData.name).toBe('New Item');
      expect((result as any).fieldData.slug).toBe('new-item');
      // No extra keys from any base — only the mapped fields
      expect(Object.keys(result)).toEqual(['fieldData']);
    });
  });
});
