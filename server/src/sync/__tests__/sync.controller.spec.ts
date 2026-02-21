/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { NotFoundException } from '@nestjs/common';
import type { DataFolderId, SyncId, WorkbookId } from '@spinner/shared-types';
import type { RequestWithUser } from 'src/auth/types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { SyncController } from '../sync.controller';
import { SyncService } from '../sync.service';

const WORKBOOK_ID = 'wkb_test123' as WorkbookId;
const SYNC_ID = 'syn_test456' as SyncId;
const USER_ID = 'usr_abc';
const ORG_ID = 'org_xyz';

function makeReqWithUser(overrides?: Partial<{ organizationId: string | null }>): RequestWithUser {
  return {
    user: {
      id: USER_ID,
      organizationId: overrides?.organizationId !== undefined ? overrides.organizationId : ORG_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      clerkId: 'clerk_1',
      name: 'Test User',
      email: 'test@example.com',
      role: 'USER',
      authType: 'jwt',
      authSource: 'user',
      stripeCustomerId: null,
      refCode: null,
      firstTimeUser: false,
    },
  } as unknown as RequestWithUser;
}

describe('SyncController', () => {
  let controller: SyncController;
  let syncService: jest.Mocked<SyncService>;
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;
  let dbService: jest.Mocked<DbService>;
  let posthogService: jest.Mocked<PostHogService>;

  beforeEach(() => {
    syncService = {
      createSync: jest.fn(),
      updateSync: jest.fn(),
      findOneForWorkbook: jest.fn(),
      findAllForWorkbook: jest.fn(),
      deleteSync: jest.fn(),
      previewRecord: jest.fn(),
      validateFolderMapping: jest.fn(),
    } as unknown as jest.Mocked<SyncService>;

    bullEnqueuerService = {
      enqueueSyncDataFoldersJob: jest.fn(),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    dbService = {
      client: {
        workbook: { findUnique: jest.fn() },
        sync: { findFirst: jest.fn() },
      },
    } as unknown as jest.Mocked<DbService>;

    posthogService = {
      trackStartSyncRun: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    controller = new SyncController(syncService, bullEnqueuerService, dbService, posthogService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // createSync
  // ---------------------------------------------------------------------------
  describe('createSync', () => {
    const body = {
      displayName: 'My Sync',
      mappings: {
        version: 1 as const,
        tableMappings: [
          {
            sourceDataFolderId: 'dfd_src' as DataFolderId,
            destinationDataFolderId: 'dfd_dest' as DataFolderId,
            columnMappings: [{ sourceColumnId: 'a', destinationColumnId: 'b' }],
          },
        ],
      },
    };

    it('delegates to syncService.createSync and returns its result', async () => {
      const expected = { id: SYNC_ID, displayName: 'My Sync' };
      syncService.createSync.mockResolvedValue(expected);

      const result = await controller.createSync(WORKBOOK_ID, body, makeReqWithUser());

      expect(syncService.createSync).toHaveBeenCalledWith(
        WORKBOOK_ID,
        body,
        expect.objectContaining({ userId: USER_ID, organizationId: ORG_ID }),
      );
      expect(result).toEqual(expected);
    });

    it('passes actor derived from req.user via userToActor', async () => {
      syncService.createSync.mockResolvedValue({});

      await controller.createSync(WORKBOOK_ID, body, makeReqWithUser());

      const actor = syncService.createSync.mock.calls[0][2];
      expect(actor.userId).toBe(USER_ID);
      expect(actor.organizationId).toBe(ORG_ID);
    });
  });

  // ---------------------------------------------------------------------------
  // updateSync
  // ---------------------------------------------------------------------------
  describe('updateSync', () => {
    const body = {
      displayName: 'Updated Sync',
      mappings: {
        version: 1 as const,
        tableMappings: [
          {
            sourceDataFolderId: 'dfd_src' as DataFolderId,
            destinationDataFolderId: 'dfd_dest' as DataFolderId,
            columnMappings: [{ sourceColumnId: 'x', destinationColumnId: 'y' }],
          },
        ],
      },
    };

    it('delegates to syncService.updateSync and returns its result', async () => {
      const expected = { id: SYNC_ID, displayName: 'Updated Sync' };
      syncService.updateSync.mockResolvedValue(expected);

      const result = await controller.updateSync(WORKBOOK_ID, SYNC_ID, body, makeReqWithUser());

      expect(syncService.updateSync).toHaveBeenCalledWith(
        WORKBOOK_ID,
        SYNC_ID,
        body,
        expect.objectContaining({ userId: USER_ID }),
      );
      expect(result).toEqual(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // getSync
  // ---------------------------------------------------------------------------
  describe('getSync', () => {
    it('delegates to syncService.findOneForWorkbook and returns its result', async () => {
      const expected = { id: SYNC_ID, displayName: 'My Sync', syncTablePairs: [] };
      syncService.findOneForWorkbook.mockResolvedValue(expected);

      const result = await controller.getSync(WORKBOOK_ID, SYNC_ID, makeReqWithUser());

      expect(syncService.findOneForWorkbook).toHaveBeenCalledWith(
        WORKBOOK_ID,
        SYNC_ID,
        expect.objectContaining({ userId: USER_ID, organizationId: ORG_ID }),
      );
      expect(result).toEqual(expected);
    });

    it('propagates NotFoundException from service when sync not found', async () => {
      syncService.findOneForWorkbook.mockRejectedValue(new NotFoundException('Sync not found'));

      await expect(controller.getSync(WORKBOOK_ID, SYNC_ID, makeReqWithUser())).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // listSyncs
  // ---------------------------------------------------------------------------
  describe('listSyncs', () => {
    it('delegates to syncService.findAllForWorkbook and returns its result', async () => {
      const expected = [{ id: SYNC_ID }];
      syncService.findAllForWorkbook.mockResolvedValue(expected);

      const result = await controller.listSyncs(WORKBOOK_ID, makeReqWithUser());

      expect(syncService.findAllForWorkbook).toHaveBeenCalledWith(
        WORKBOOK_ID,
        expect.objectContaining({ userId: USER_ID }),
      );
      expect(result).toEqual(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // runSync
  // ---------------------------------------------------------------------------
  describe('runSync', () => {
    const mockWorkbook = { userId: USER_ID, organizationId: ORG_ID };
    const mockSync = { id: SYNC_ID, displayName: 'Test', mappings: {} };

    it('happy path: enqueues job and returns success with jobId', async () => {
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue(mockWorkbook);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(mockSync);
      bullEnqueuerService.enqueueSyncDataFoldersJob.mockResolvedValue({ id: 'job_1' } as any);

      const result = await controller.runSync(WORKBOOK_ID, SYNC_ID, makeReqWithUser());

      expect(result).toEqual({
        success: true,
        jobId: 'job_1',
        message: 'Sync job queued successfully',
      });
    });

    it('throws NotFoundException when workbook not found', async () => {
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(controller.runSync(WORKBOOK_ID, SYNC_ID, makeReqWithUser())).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when sync not found', async () => {
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue(mockWorkbook);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(controller.runSync(WORKBOOK_ID, SYNC_ID, makeReqWithUser())).rejects.toThrow(NotFoundException);
    });

    it('falls back to workbook.organizationId when req.user.organizationId is nullish', async () => {
      const workbookOrgId = 'org_from_workbook';
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({
        userId: USER_ID,
        organizationId: workbookOrgId,
      });
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(mockSync);
      bullEnqueuerService.enqueueSyncDataFoldersJob.mockResolvedValue({ id: 'job_2' } as any);

      await controller.runSync(WORKBOOK_ID, SYNC_ID, makeReqWithUser({ organizationId: null }));

      expect(bullEnqueuerService.enqueueSyncDataFoldersJob).toHaveBeenCalledWith(
        WORKBOOK_ID,
        SYNC_ID,
        expect.objectContaining({ organizationId: workbookOrgId }),
      );
    });

    it('uses req.user.organizationId when present', async () => {
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({
        userId: USER_ID,
        organizationId: 'org_workbook',
      });
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(mockSync);
      bullEnqueuerService.enqueueSyncDataFoldersJob.mockResolvedValue({ id: 'job_3' } as any);

      await controller.runSync(WORKBOOK_ID, SYNC_ID, makeReqWithUser({ organizationId: ORG_ID }));

      expect(bullEnqueuerService.enqueueSyncDataFoldersJob).toHaveBeenCalledWith(
        WORKBOOK_ID,
        SYNC_ID,
        expect.objectContaining({ organizationId: ORG_ID }),
      );
    });

    it('scopes sync query to workbook via syncTablePairs', async () => {
      (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue(mockWorkbook);
      (dbService.client.sync.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(controller.runSync(WORKBOOK_ID, SYNC_ID, makeReqWithUser())).rejects.toThrow(NotFoundException);

      expect(dbService.client.sync.findFirst).toHaveBeenCalledWith({
        where: {
          id: SYNC_ID,
          syncTablePairs: {
            some: {
              sourceDataFolder: { workbookId: WORKBOOK_ID },
            },
          },
        },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // deleteSync
  // ---------------------------------------------------------------------------
  describe('deleteSync', () => {
    it('delegates to syncService.deleteSync', async () => {
      syncService.deleteSync.mockResolvedValue(undefined);

      await controller.deleteSync(WORKBOOK_ID, SYNC_ID, makeReqWithUser());

      expect(syncService.deleteSync).toHaveBeenCalledWith(
        WORKBOOK_ID,
        SYNC_ID,
        expect.objectContaining({ userId: USER_ID }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // previewRecord
  // ---------------------------------------------------------------------------
  describe('previewRecord', () => {
    it('delegates to syncService.previewRecord and returns its result', async () => {
      const body = {
        sourceId: 'dfd_src',
        filePath: 'folder/file.json',
        columnMappings: [{ sourceColumnId: 'a', destinationColumnId: 'b' }],
      };
      const expected = { recordId: 'rec1', fields: [] };
      syncService.previewRecord.mockResolvedValue(expected);

      const result = await controller.previewRecord(WORKBOOK_ID, body as any, makeReqWithUser());

      expect(syncService.previewRecord).toHaveBeenCalledWith(
        WORKBOOK_ID,
        body,
        expect.objectContaining({ userId: USER_ID }),
      );
      expect(result).toEqual(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // validateMapping
  // ---------------------------------------------------------------------------
  describe('validateMapping', () => {
    const body = {
      sourceId: 'dfd_src',
      destId: 'dfd_dest',
      columnMappings: [{ sourceColumnId: 'col1', destinationColumnId: 'col2' }],
    };

    it('returns { valid: true } when service returns true', async () => {
      syncService.validateFolderMapping.mockResolvedValue(true);

      const result = await controller.validateMapping(WORKBOOK_ID, body as any, makeReqWithUser());

      expect(result).toEqual({ valid: true });
    });

    it('returns { valid: false } when service returns false', async () => {
      syncService.validateFolderMapping.mockResolvedValue(false);

      const result = await controller.validateMapping(WORKBOOK_ID, body as any, makeReqWithUser());

      expect(result).toEqual({ valid: false });
    });

    it('passes sourceId/destId cast as DataFolderId and columnMappings to service', async () => {
      syncService.validateFolderMapping.mockResolvedValue(true);

      await controller.validateMapping(WORKBOOK_ID, body as any, makeReqWithUser());

      expect(syncService.validateFolderMapping).toHaveBeenCalledWith(
        WORKBOOK_ID,
        'dfd_src' as DataFolderId,
        'dfd_dest' as DataFolderId,
        [{ sourceColumnId: 'col1', destinationColumnId: 'col2' }],
        expect.objectContaining({ userId: USER_ID }),
      );
    });
  });
});
