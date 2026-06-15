/* eslint-disable @typescript-eslint/unbound-method */
import { NotFoundException } from '@nestjs/common';
import type { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { MigrationLockService } from 'src/migration-lock/migration-lock.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import { SchemaHelperService } from 'src/publish-plan/schema-helper.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import { FilesService } from '../files.service';
import { WorkbookEventService } from '../workbook-event.service';
import { WorkbookService } from '../workbook.service';

const WORKBOOK_ID = 'wkb_test' as WorkbookId;
const FOLDER_ID = 'df_test' as DataFolderId;
const ACTOR: Actor = {
  userId: 'usr_test',
  organizationId: 'org_test',
  authSource: 'user',
};

describe('FilesService', () => {
  let service: FilesService;
  let dbService: jest.Mocked<DbService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let posthogService: jest.Mocked<PostHogService>;
  let workbookEventService: jest.Mocked<WorkbookEventService>;
  let workbookService: jest.Mocked<WorkbookService>;
  let schemaHelperService: jest.Mocked<SchemaHelperService>;
  let refCleanerService: jest.Mocked<RefCleanerService>;
  let fileIndexService: jest.Mocked<FileIndexService>;

  beforeEach(() => {
    dbService = {
      client: {
        dataFolder: {
          findUnique: jest.fn().mockResolvedValue({
            id: FOLDER_ID,
            path: '/my-folder',
            connectorAccountId: null,
          }),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('repo-123'),
      listRepoFilesPaginated: jest.fn().mockResolvedValue({ files: [], nextCursor: undefined }),
      getFolderDiff: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ScratchGitService>;

    posthogService = {} as unknown as jest.Mocked<PostHogService>;
    workbookEventService = {} as unknown as jest.Mocked<WorkbookEventService>;

    workbookService = {
      findOneOrThrow: jest.fn().mockResolvedValue({
        id: WORKBOOK_ID,
        organizationId: 'org_test',
        cluster: { id: 'cluster_test' },
      }),
    } as unknown as jest.Mocked<WorkbookService>;

    schemaHelperService = {} as unknown as jest.Mocked<SchemaHelperService>;
    refCleanerService = {} as unknown as jest.Mocked<RefCleanerService>;
    fileIndexService = {} as unknown as jest.Mocked<FileIndexService>;

    service = new FilesService(
      dbService,
      scratchGitService,
      posthogService,
      workbookEventService,
      workbookService,
      schemaHelperService,
      refCleanerService,
      fileIndexService,
      { assertConnectionNotMigrating: jest.fn().mockResolvedValue(undefined) } as unknown as MigrationLockService,
    );
  });

  describe('listByFolderId', () => {
    it('calls listRepoFilesPaginated with correct arguments', async () => {
      await service.listByFolderId(WORKBOOK_ID, FOLDER_ID, ACTOR);

      expect(scratchGitService.listRepoFilesPaginated).toHaveBeenCalledWith(
        'repo-123',
        'dirty',
        'my-folder',
        200,
        undefined,
      );
    });

    it('throws NotFoundException when folder is not found', async () => {
      (dbService.client.dataFolder.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.listByFolderId(WORKBOOK_ID, FOLDER_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('includes dotfiles like .schema.json in the file list', async () => {
      (scratchGitService.listRepoFilesPaginated as jest.Mock).mockResolvedValue({
        files: [
          { name: 'record-1.json', path: 'my-folder/record-1.json' },
          { name: '.schema.json', path: 'my-folder/.schema.json' },
          { name: 'record-2.json', path: 'my-folder/record-2.json' },
        ],
        nextCursor: undefined,
      });

      const result = await service.listByFolderId(WORKBOOK_ID, FOLDER_ID, ACTOR);

      expect(result.items).toHaveLength(3);
      expect(result.items.map((f) => f.name)).toEqual(['record-1.json', '.schema.json', 'record-2.json']);
    });
  });
});
