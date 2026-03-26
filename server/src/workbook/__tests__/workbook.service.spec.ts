/* eslint-disable @typescript-eslint/unbound-method */
import { NotFoundException } from '@nestjs/common';
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
  authType: 'jwt',
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

  beforeEach(() => {
    dbService = {
      client: {
        workbook: {
          findFirst: jest.fn(),
          delete: jest.fn().mockResolvedValue({}),
        },
        connectorAccount: {
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
      trackRemoveWorkbook: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    auditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;

    const configService = {} as jest.Mocked<ScratchConfigService>;
    const workbookEventService = {} as jest.Mocked<WorkbookEventService>;
    const bullEnqueuerService = {} as jest.Mocked<BullEnqueuerService>;
    const workbookRepoService = {
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

    it('deletes DbJob rows for the workbook', async () => {
      (dbService.client.workbook.findFirst as jest.Mock).mockResolvedValue(createMockWorkbook(1));

      await service.delete(WORKBOOK_ID, ACTOR);

      expect(dbService.client.dbJob.deleteMany).toHaveBeenCalledWith({ where: { workbookId: WORKBOOK_ID } });
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
      expect(dbService.client.dbJob.deleteMany).toHaveBeenCalledWith({ where: { workbookId: WORKBOOK_ID } });
      expect(dbService.client.workbook.delete).toHaveBeenCalledWith({ where: { id: WORKBOOK_ID } });
    });

    it('throws NotFoundException when workbook is not found', async () => {
      (dbService.client.workbook.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.delete(WORKBOOK_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });
  });
});
