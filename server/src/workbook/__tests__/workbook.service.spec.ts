/* eslint-disable @typescript-eslint/unbound-method */
import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import type { WorkbookId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { WorkbookEventService } from '../workbook-event.service';
import { WorkbookRepoService } from '../workbook-repo.service';
import { WorkbookService } from '../workbook.service';

const WORKBOOK_ID = 'wkb_test' as WorkbookId;
const ACTOR: Actor = {
  userId: 'usr_test',
  organizationId: 'org_test',
  authSource: 'user',
};

function createMockWorkbook(version: number) {
  return {
    id: WORKBOOK_ID,
    name: 'Test Workbook',
    organizationId: 'org_test',
    userId: 'usr_test',
    version,
    cluster: { id: 'cluster_test' },
    dataFolders: [],
    syncs: [],
    connectorAccounts: [],
  };
}

describe('WorkbookService', () => {
  let service: WorkbookService;
  let dbService: jest.Mocked<DbService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let fileIndexService: jest.Mocked<FileIndexService>;
  let fileReferenceService: jest.Mocked<FileReferenceService>;
  let posthogService: jest.Mocked<PostHogService>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;
  let workbookRepoService: jest.Mocked<WorkbookRepoService>;

  beforeEach(() => {
    dbService = {
      client: {
        workbook: {
          create: jest.fn(),
          findFirst: jest.fn(),
          delete: jest.fn().mockResolvedValue({}),
        },
        connectorAccount: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        dataFolder: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        sync: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        syncMatchKeys: {
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        dbJob: {
          deleteMany: jest.fn().mockResolvedValue({}),
        },
        schedule: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    scratchGitService = {
      deleteRepo: jest.fn().mockResolvedValue(undefined),
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('resolved-repo-id'),
    } as unknown as jest.Mocked<ScratchGitService>;

    fileIndexService = {
      deleteForWorkbook: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileIndexService>;

    fileReferenceService = {
      deleteForWorkbook: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileReferenceService>;

    posthogService = {
      trackCreateWorkbook: jest.fn(),
      trackRemoveWorkbook: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    auditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;

    const configService = {} as jest.Mocked<ScratchConfigService>;
    const workbookEventService = {} as jest.Mocked<WorkbookEventService>;
    bullEnqueuerService = {
      enqueueRehostAssetsJob: jest
        .fn()
        .mockImplementation((_wkbId, _actor, folderId) => Promise.resolve({ id: `job_${folderId}` })),
    } as unknown as jest.Mocked<BullEnqueuerService>;
    workbookRepoService = {
      initWorkbookRepo: jest.fn().mockResolvedValue(undefined),
      deleteWorkbookRepo: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WorkbookRepoService>;

    service = new WorkbookService(
      dbService,
      configService,
      workbookEventService,
      posthogService,
      bullEnqueuerService,
      auditLogService,
      scratchGitService,
      fileIndexService,
      fileReferenceService,
      workbookRepoService,
    );
  });

  describe('create', () => {
    it('initializes the workbook config repo after creating the workbook', async () => {
      const createdWorkbook = createMockWorkbook(2);
      (dbService.client.workbook.create as jest.Mock).mockResolvedValue(createdWorkbook);

      const result = await service.create({ name: 'Test Workbook' }, ACTOR);

      expect(result).toBe(createdWorkbook);
      expect(workbookRepoService.initWorkbookRepo).toHaveBeenCalledWith('org_test', WORKBOOK_ID);
    });

    it('rolls back the workbook record when workbook repo init fails', async () => {
      const createdWorkbook = createMockWorkbook(2);
      (dbService.client.workbook.create as jest.Mock).mockResolvedValue(createdWorkbook);
      workbookRepoService.initWorkbookRepo.mockRejectedValue(new Error('git down'));

      await expect(service.create({ name: 'Test Workbook' }, ACTOR)).rejects.toThrow(InternalServerErrorException);

      expect(dbService.client.workbook.delete).toHaveBeenCalledWith({ where: { id: WORKBOOK_ID } });
    });
  });

  describe('fetchSchedulesByEntityId', () => {
    it('groups schedules by entityId for a single workbook', async () => {
      const schedules = [
        { id: 'sch_1', workbookId: WORKBOOK_ID, entityId: 'df_1', action: 'PULL' },
        { id: 'sch_2', workbookId: WORKBOOK_ID, entityId: 'df_1', action: 'PUBLISH' },
        { id: 'sch_3', workbookId: WORKBOOK_ID, entityId: 'df_2', action: 'PULL' },
      ];
      (dbService.client.schedule.findMany as jest.Mock).mockResolvedValue(schedules);

      const result = await service.fetchSchedulesByEntityId(WORKBOOK_ID);

      expect(dbService.client.schedule.findMany).toHaveBeenCalledWith({ where: { workbookId: WORKBOOK_ID } });
      expect(result.get('df_1')).toEqual([schedules[0], schedules[1]]);
      expect(result.get('df_2')).toEqual([schedules[2]]);
    });

    it('returns an empty map when no schedules exist', async () => {
      (dbService.client.schedule.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.fetchSchedulesByEntityId(WORKBOOK_ID);

      expect(result.size).toBe(0);
    });
  });

  describe('fetchSchedulesByWorkbookIds', () => {
    const WORKBOOK_ID_2 = 'wkb_test_2' as WorkbookId;

    it('fetches schedules for multiple workbooks in a single query', async () => {
      const schedules = [
        { id: 'sch_1', workbookId: WORKBOOK_ID, entityId: 'df_1', action: 'PULL' },
        { id: 'sch_2', workbookId: WORKBOOK_ID, entityId: 'df_2', action: 'PULL' },
        { id: 'sch_3', workbookId: WORKBOOK_ID_2, entityId: 'df_3', action: 'PUBLISH' },
      ];
      (dbService.client.schedule.findMany as jest.Mock).mockResolvedValue(schedules);

      const result = await service.fetchSchedulesByWorkbookIds([WORKBOOK_ID, WORKBOOK_ID_2]);

      expect(dbService.client.schedule.findMany).toHaveBeenCalledWith({
        where: { workbookId: { in: [WORKBOOK_ID, WORKBOOK_ID_2] } },
      });
      expect(result.get(WORKBOOK_ID)?.get('df_1')).toEqual([schedules[0]]);
      expect(result.get(WORKBOOK_ID)?.get('df_2')).toEqual([schedules[1]]);
      expect(result.get(WORKBOOK_ID_2)?.get('df_3')).toEqual([schedules[2]]);
    });

    it('groups multiple schedules per entity within each workbook', async () => {
      const schedules = [
        { id: 'sch_1', workbookId: WORKBOOK_ID, entityId: 'df_1', action: 'PULL' },
        { id: 'sch_2', workbookId: WORKBOOK_ID, entityId: 'df_1', action: 'PUBLISH' },
      ];
      (dbService.client.schedule.findMany as jest.Mock).mockResolvedValue(schedules);

      const result = await service.fetchSchedulesByWorkbookIds([WORKBOOK_ID]);

      expect(result.get(WORKBOOK_ID)?.get('df_1')).toEqual([schedules[0], schedules[1]]);
    });

    it('returns an empty map for workbooks with no schedules', async () => {
      (dbService.client.schedule.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.fetchSchedulesByWorkbookIds([WORKBOOK_ID, WORKBOOK_ID_2]);

      expect(result.size).toBe(0);
      expect(result.get(WORKBOOK_ID)).toBeUndefined();
    });

    it('returns an empty map when given no workbook IDs', async () => {
      const result = await service.fetchSchedulesByWorkbookIds([]);

      expect(result.size).toBe(0);
      expect(dbService.client.schedule.findMany).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes a V2 workbook with per-connection repos', async () => {
      (dbService.client.workbook.findFirst as jest.Mock).mockResolvedValue(createMockWorkbook(2));
      (dbService.client.connectorAccount.findMany as jest.Mock).mockResolvedValue([{ id: 'ca_1' }, { id: 'ca_2' }]);
      (scratchGitService.resolveConnectionRepoPath as jest.Mock)
        .mockResolvedValueOnce('repo-ca-1')
        .mockResolvedValueOnce('repo-ca-2');

      await service.delete(WORKBOOK_ID, ACTOR);

      expect(scratchGitService.resolveConnectionRepoPath).toHaveBeenCalledWith('ca_1');
      expect(scratchGitService.resolveConnectionRepoPath).toHaveBeenCalledWith('ca_2');
      expect(scratchGitService.deleteRepo).toHaveBeenCalledWith('repo-ca-1');
      expect(scratchGitService.deleteRepo).toHaveBeenCalledWith('repo-ca-2');
      expect(dbService.client.workbook.delete).toHaveBeenCalledWith({ where: { id: WORKBOOK_ID } });
    });

    it('deletes DbJob rows for the workbook (excluding the running delete-workbook job)', async () => {
      (dbService.client.workbook.findFirst as jest.Mock).mockResolvedValue(createMockWorkbook(1));

      await service.delete(WORKBOOK_ID, ACTOR);

      // The DeleteWorkbook job's own DbJob row must survive cleanup so the worker can
      // mark itself complete after the handler returns.
      expect(dbService.client.dbJob.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, type: { not: 'delete-workbook' } },
      });
    });

    it('deletes SyncMatchKeys when syncs exist', async () => {
      (dbService.client.workbook.findFirst as jest.Mock).mockResolvedValue(createMockWorkbook(1));
      (dbService.client.sync.findMany as jest.Mock).mockResolvedValue([{ id: 'sync_1' }, { id: 'sync_2' }]);

      await service.delete(WORKBOOK_ID, ACTOR);

      expect(dbService.client.sync.findMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID },
        select: { id: true },
      });
      expect(dbService.client.syncMatchKeys.deleteMany).toHaveBeenCalledWith({
        where: { syncId: { in: ['sync_1', 'sync_2'] } },
      });
    });

    it('skips SyncMatchKeys deletion when no syncs exist', async () => {
      (dbService.client.workbook.findFirst as jest.Mock).mockResolvedValue(createMockWorkbook(1));
      (dbService.client.sync.findMany as jest.Mock).mockResolvedValue([]);

      await service.delete(WORKBOOK_ID, ACTOR);

      expect(dbService.client.syncMatchKeys.deleteMany).not.toHaveBeenCalled();
    });

    it('continues cleanup when git repo deletion fails', async () => {
      (dbService.client.workbook.findFirst as jest.Mock).mockResolvedValue(createMockWorkbook(1));
      (scratchGitService.deleteRepo as jest.Mock).mockRejectedValue(new Error('git error'));

      await service.delete(WORKBOOK_ID, ACTOR);

      expect(fileIndexService.deleteForWorkbook).toHaveBeenCalledWith(WORKBOOK_ID);
      expect(fileReferenceService.deleteForWorkbook).toHaveBeenCalledWith(WORKBOOK_ID);
      expect(dbService.client.dbJob.deleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, type: { not: 'delete-workbook' } },
      });
      expect(dbService.client.workbook.delete).toHaveBeenCalledWith({ where: { id: WORKBOOK_ID } });
    });

    it('throws NotFoundException when workbook is not found', async () => {
      (dbService.client.workbook.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.delete(WORKBOOK_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });
  });

  describe('pullAssets', () => {
    beforeEach(() => {
      (dbService.client.workbook.findFirst as jest.Mock).mockResolvedValue(createMockWorkbook(2));
    });

    it('enqueues a rehost job for each matching data folder', async () => {
      const folders = [
        { id: 'dfd_1', name: 'Brands', workbookId: WORKBOOK_ID },
        { id: 'dfd_2', name: 'Products', workbookId: WORKBOOK_ID },
      ];
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue(folders);

      const result = await service.pullAssets(WORKBOOK_ID, ACTOR, ['dfd_1', 'dfd_2'], {
        runId: 'run_test',
        trigger: 'web',
      });

      expect(bullEnqueuerService.enqueueRehostAssetsJob).toHaveBeenCalledTimes(2);
      expect(result.jobIds).toEqual(['job_dfd_1', 'job_dfd_2']);
    });

    it('returns a warning when no matching folders are found', async () => {
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.pullAssets(WORKBOOK_ID, ACTOR, ['dfd_nonexistent'], {
        runId: 'run_test',
        trigger: 'web',
      });

      expect(bullEnqueuerService.enqueueRehostAssetsJob).not.toHaveBeenCalled();
      expect(result.warning).toBeDefined();
    });

    it('only enqueues jobs for folders that exist in the workbook', async () => {
      const folders = [{ id: 'dfd_1', name: 'Brands', workbookId: WORKBOOK_ID }];
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue(folders);

      const result = await service.pullAssets(WORKBOOK_ID, ACTOR, ['dfd_1', 'dfd_missing'], {
        runId: 'run_test',
        trigger: 'web',
      });

      expect(bullEnqueuerService.enqueueRehostAssetsJob).toHaveBeenCalledTimes(1);
      expect(result.jobIds).toHaveLength(1);
    });
  });
});
