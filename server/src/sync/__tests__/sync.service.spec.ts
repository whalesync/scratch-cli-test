/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { CreateSyncDto, DataFolderId, SyncId, UpdateSyncDto, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { SyncService } from '../sync.service';

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

function makeCreateSyncDto(overrides?: Partial<CreateSyncDto>): CreateSyncDto {
  return {
    name: 'Test Sync',
    folderMappings: [
      {
        sourceId: SOURCE_FOLDER_ID,
        destId: DEST_FOLDER_ID,
        fieldMap: { title: 'name' },
        matchingDestinationField: null,
        matchingSourceField: null,
      },
    ],
    schedule: null,
    autoPublish: false,
    enableValidation: false,
    ...overrides,
  } as CreateSyncDto;
}

function makeUpdateSyncDto(overrides?: Partial<UpdateSyncDto>): UpdateSyncDto {
  return makeCreateSyncDto(overrides) as UpdateSyncDto;
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

      const dto = makeCreateSyncDto();
      const result = await service.createSync(WORKBOOK_ID, dto, ACTOR);

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

      await expect(service.createSync(WORKBOOK_ID, makeCreateSyncDto(), ACTOR)).rejects.toThrow(NotFoundException);
      expect(dbService.client.sync.create).not.toHaveBeenCalled();
    });

    it('calls fetchSchemaSpec for each folder mapping when validation enabled', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      dataFolderService.fetchSchemaSpec.mockResolvedValue({ schema: MOCK_SCHEMA } as any);
      validateSchemaMapping.mockReturnValue([]);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const dto = makeCreateSyncDto({ enableValidation: true });
      await service.createSync(WORKBOOK_ID, dto, ACTOR);

      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledTimes(2);
      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledWith(SOURCE_FOLDER_ID, ACTOR);
      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledWith(DEST_FOLDER_ID, ACTOR);
    });

    it('throws NotFoundException when source schema missing', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      dataFolderService.fetchSchemaSpec.mockResolvedValueOnce(null);

      const dto = makeCreateSyncDto({ enableValidation: true });

      await expect(service.createSync(WORKBOOK_ID, dto, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when destination schema missing', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      dataFolderService.fetchSchemaSpec
        .mockResolvedValueOnce({ schema: MOCK_SCHEMA } as any)
        .mockResolvedValueOnce(null);

      const dto = makeCreateSyncDto({ enableValidation: true });

      await expect(service.createSync(WORKBOOK_ID, dto, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException on schema validation errors', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      dataFolderService.fetchSchemaSpec.mockResolvedValue({ schema: MOCK_SCHEMA } as any);
      validateSchemaMapping.mockReturnValue(['Type mismatch for field X']);

      const dto = makeCreateSyncDto({ enableValidation: true });

      await expect(service.createSync(WORKBOOK_ID, dto, ACTOR)).rejects.toThrow(BadRequestException);
    });

    it('skips schema validation when enableValidation is false', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const dto = makeCreateSyncDto({ enableValidation: false });
      await service.createSync(WORKBOOK_ID, dto, ACTOR);

      expect(dataFolderService.fetchSchemaSpec).not.toHaveBeenCalled();
    });

    it('creates multiple syncTablePairs for multiple folder mappings', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const dto = makeCreateSyncDto({
        folderMappings: [
          {
            sourceId: 'dfd_src1',
            destId: 'dfd_dest1',
            fieldMap: { a: 'b' },
            matchingDestinationField: null,
          },
          {
            sourceId: 'dfd_src2',
            destId: 'dfd_dest2',
            fieldMap: { c: 'd' },
            matchingDestinationField: null,
          },
        ] as any,
      });
      await service.createSync(WORKBOOK_ID, dto, ACTOR);

      const createArg = (dbService.client.sync.create as jest.Mock).mock.calls[0][0];
      expect(createArg.data.mappings.tableMappings).toHaveLength(2);
      expect(createArg.data.syncTablePairs.create).toHaveLength(2);
    });

    it('includes recordMatching when both matching fields are set', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const dto = makeCreateSyncDto({
        folderMappings: [
          {
            sourceId: SOURCE_FOLDER_ID,
            destId: DEST_FOLDER_ID,
            fieldMap: { email: 'email_addr' },
            matchingSourceField: 'email',
            matchingDestinationField: 'email_addr',
          },
        ] as any,
      });
      await service.createSync(WORKBOOK_ID, dto, ACTOR);

      const tableMapping = (dbService.client.sync.create as jest.Mock).mock.calls[0][0].data.mappings.tableMappings[0];
      expect(tableMapping.recordMatching).toEqual({
        sourceColumnId: 'email',
        destinationColumnId: 'email_addr',
      });
    });

    it('omits recordMatching when matching fields are partially set', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const dto = makeCreateSyncDto({
        folderMappings: [
          {
            sourceId: SOURCE_FOLDER_ID,
            destId: DEST_FOLDER_ID,
            fieldMap: { a: 'b' },
            matchingSourceField: 'email',
            matchingDestinationField: null,
          },
        ] as any,
      });
      await service.createSync(WORKBOOK_ID, dto, ACTOR);

      const tableMapping = (dbService.client.sync.create as jest.Mock).mock.calls[0][0].data.mappings.tableMappings[0];
      expect(tableMapping.recordMatching).toBeUndefined();
    });

    it('calls PostHog tracking after creation', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      const createdSync = { id: SYNC_ID };
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(createdSync);

      await service.createSync(WORKBOOK_ID, makeCreateSyncDto(), ACTOR);

      expect(posthogService.trackCreateSync).toHaveBeenCalledWith(ACTOR, createdSync);
    });

    it('handles complex FieldMappingValue with transformer', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const dto = makeCreateSyncDto({
        folderMappings: [
          {
            sourceId: SOURCE_FOLDER_ID,
            destId: DEST_FOLDER_ID,
            fieldMap: {
              price: {
                destinationField: 'amount',
                transformer: { type: 'string_to_number', options: { stripCurrency: true } },
              },
            },
            matchingDestinationField: null,
          },
        ] as any,
      });
      await service.createSync(WORKBOOK_ID, dto, ACTOR);

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

    it('handles simple string field mapping', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.create as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const dto = makeCreateSyncDto({
        folderMappings: [
          {
            sourceId: SOURCE_FOLDER_ID,
            destId: DEST_FOLDER_ID,
            fieldMap: { title: 'name', slug: 'url_slug' },
            matchingDestinationField: null,
          },
        ] as any,
      });
      await service.createSync(WORKBOOK_ID, dto, ACTOR);

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

      const dto = makeUpdateSyncDto({ name: 'Updated' });
      const result = await service.updateSync(WORKBOOK_ID, SYNC_ID, dto, ACTOR);

      expect(result).toEqual(updatedSync);
      expect(dbService.client.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when workbook not found', async () => {
      workbookService.findOne.mockResolvedValue(null);

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, makeUpdateSyncDto(), ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when sync not found', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, makeUpdateSyncDto(), ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when record matching fields are misaligned with field map', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);

      const dto = makeUpdateSyncDto({
        folderMappings: [
          {
            sourceId: SOURCE_FOLDER_ID,
            destId: DEST_FOLDER_ID,
            fieldMap: { email: 'email_addr' },
            matchingSourceField: 'email',
            matchingDestinationField: 'WRONG_FIELD',
          },
        ] as any,
      });

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, dto, ACTOR)).rejects.toThrow(BadRequestException);
    });

    it('passes when record matching fields are aligned with field map', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);

      const dto = makeUpdateSyncDto({
        folderMappings: [
          {
            sourceId: SOURCE_FOLDER_ID,
            destId: DEST_FOLDER_ID,
            fieldMap: { email: 'email_addr' },
            matchingSourceField: 'email',
            matchingDestinationField: 'email_addr',
          },
        ] as any,
      });

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, dto, ACTOR)).resolves.toBeDefined();
    });

    it('handles complex FieldMappingValue alignment check', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.$transaction as jest.Mock).mockResolvedValue({ id: SYNC_ID, syncTablePairs: [] });

      const dto = makeUpdateSyncDto({
        folderMappings: [
          {
            sourceId: SOURCE_FOLDER_ID,
            destId: DEST_FOLDER_ID,
            fieldMap: {
              price: { destinationField: 'amount', transformer: { type: 'string_to_number' } },
            },
            matchingSourceField: 'price',
            matchingDestinationField: 'amount',
          },
        ] as any,
      });

      await expect(service.updateSync(WORKBOOK_ID, SYNC_ID, dto, ACTOR)).resolves.toBeDefined();
    });

    it('validates schema mappings when enableValidation is true', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      dataFolderService.fetchSchemaSpec.mockResolvedValue({ schema: MOCK_SCHEMA } as any);
      validateSchemaMapping.mockReturnValue([]);
      (dbService.client.$transaction as jest.Mock).mockResolvedValue({ id: SYNC_ID, syncTablePairs: [] });

      const dto = makeUpdateSyncDto({ enableValidation: true });
      await service.updateSync(WORKBOOK_ID, SYNC_ID, dto, ACTOR);

      expect(dataFolderService.fetchSchemaSpec).toHaveBeenCalledTimes(2);
      expect(validateSchemaMapping).toHaveBeenCalled();
    });

    it('skips validation when enableValidation is false', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      (dbService.client.$transaction as jest.Mock).mockResolvedValue({ id: SYNC_ID, syncTablePairs: [] });

      const dto = makeUpdateSyncDto({ enableValidation: false });
      await service.updateSync(WORKBOOK_ID, SYNC_ID, dto, ACTOR);

      expect(dataFolderService.fetchSchemaSpec).not.toHaveBeenCalled();
    });

    it('calls PostHog tracking after update', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);
      const updatedSync = { id: SYNC_ID, syncTablePairs: [] };
      (dbService.client.$transaction as jest.Mock).mockResolvedValue(updatedSync);

      await service.updateSync(WORKBOOK_ID, SYNC_ID, makeUpdateSyncDto(), ACTOR);

      expect(posthogService.trackUpdateSync).toHaveBeenCalledWith(ACTOR, updatedSync);
    });

    it('defaults matchingSourceField to "id" when missing', async () => {
      workbookService.findOne.mockResolvedValue(MOCK_WORKBOOK as any);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(MOCK_SYNC);

      let capturedUpdateData: any;
      (dbService.client.$transaction as jest.Mock).mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const tx = {
          syncTablePair: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
          sync: {
            update: jest.fn().mockImplementation((arg: any) => {
              capturedUpdateData = arg;
              return { id: SYNC_ID, syncTablePairs: [] };
            }),
          },
        };
        return fn(tx);
      });

      const dto = makeUpdateSyncDto({
        folderMappings: [
          {
            sourceId: SOURCE_FOLDER_ID,
            destId: DEST_FOLDER_ID,
            fieldMap: { id: 'dest_id' },
            matchingSourceField: undefined,
            matchingDestinationField: 'dest_id',
          },
        ] as any,
      });
      await service.updateSync(WORKBOOK_ID, SYNC_ID, dto, ACTOR);

      const tableMapping = capturedUpdateData.data.mappings.tableMappings[0];
      expect(tableMapping.recordMatching).toEqual({
        sourceColumnId: 'id',
        destinationColumnId: 'dest_id',
      });
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
        { title: 'name' },
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
        { title: 'name' },
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
        { title: 'name' },
        ACTOR,
      );

      expect(result).toBe(true);
    });
  });
});
