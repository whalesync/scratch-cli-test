/* eslint-disable @typescript-eslint/unbound-method */
import { NotFoundException } from '@nestjs/common';
import type { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import { FilesService } from '../files.service';
import { WorkbookEventService } from '../workbook-event.service';

const WORKBOOK_ID = 'wkb_test' as WorkbookId;
const FOLDER_ID = 'df_test' as DataFolderId;
const ACTOR: Actor = {
  userId: 'usr_test',
  organizationId: 'org_test',
  authType: 'jwt',
  authSource: 'user',
};

describe('FilesService', () => {
  let service: FilesService;
  let dbService: jest.Mocked<DbService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let posthogService: jest.Mocked<PostHogService>;
  let workbookEventService: jest.Mocked<WorkbookEventService>;

  beforeEach(() => {
    dbService = {
      client: {
        workbook: {
          findFirst: jest.fn().mockResolvedValue({
            id: WORKBOOK_ID,
            organizationId: 'org_test',
            cluster: { id: 'cluster_test' },
          }),
        },
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
      resolveRepoId: jest.fn().mockResolvedValue('repo-123'),
      listRepoFiles: jest.fn().mockResolvedValue([]),
      getFolderDiff: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ScratchGitService>;

    posthogService = {} as unknown as jest.Mocked<PostHogService>;
    workbookEventService = {} as unknown as jest.Mocked<WorkbookEventService>;

    service = new FilesService(dbService, scratchGitService, posthogService, workbookEventService);
  });

  describe('listByFolderId', () => {
    it('calls listRepoFiles with correct arguments', async () => {
      await service.listByFolderId(WORKBOOK_ID, FOLDER_ID, ACTOR);

      expect(scratchGitService.listRepoFiles).toHaveBeenCalledWith('repo-123', 'dirty', 'my-folder');
    });

    it('throws NotFoundException when folder is not found', async () => {
      (dbService.client.dataFolder.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.listByFolderId(WORKBOOK_ID, FOLDER_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('includes dotfiles like .schema.json in the file list', async () => {
      (scratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
        { name: 'record-1.json', path: 'my-folder/record-1.json', type: 'file' },
        { name: '.schema.json', path: 'my-folder/.schema.json', type: 'file' },
        { name: 'record-2.json', path: 'my-folder/record-2.json', type: 'file' },
      ]);

      const result = await service.listByFolderId(WORKBOOK_ID, FOLDER_ID, ACTOR);

      expect(result.items).toHaveLength(3);
      expect(result.items.map((f) => f.name)).toEqual(['record-1.json', '.schema.json', 'record-2.json']);
    });
  });
});
