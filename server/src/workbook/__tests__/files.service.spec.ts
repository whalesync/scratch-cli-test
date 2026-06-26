/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
            connectorAccountId: 'conn-123',
          }),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('repo-123'),
      resolveRepoPathForFolder: jest.fn().mockResolvedValue('repo-123'),
      ensureScratchRepo: jest.fn().mockResolvedValue('repo-123'),
      listRepoFilesPaginated: jest.fn().mockResolvedValue({ files: [], nextCursor: undefined }),
      getFolderDiff: jest.fn().mockResolvedValue([]),
      getRepoFile: jest.fn().mockResolvedValue({ content: '' }),
      commitFile: jest.fn().mockResolvedValue(undefined),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScratchGitService>;

    posthogService = {
      trackRecordDeleted: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;
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

    it('lists a connector-less scratch folder from main and skips the dirty diff (DEV-10424)', async () => {
      (dbService.client.dataFolder.findUnique as jest.Mock).mockResolvedValue({
        id: FOLDER_ID,
        path: '/my-scratch',
        connectorAccountId: null,
      });

      const result = await service.listByFolderId(WORKBOOK_ID, FOLDER_ID, ACTOR);

      // Scratch repos are main-only — read from `main`, never the dirty working branch.
      expect(scratchGitService.listRepoFilesPaginated).toHaveBeenCalledWith(
        'repo-123',
        'main',
        'my-scratch',
        200,
        undefined,
      );
      // No review ladder for scratch → the dirty-vs-main diff is skipped and nothing is "pending".
      expect(scratchGitService.getFolderDiff).not.toHaveBeenCalled();
      expect(result.dirtyCount).toBe(0);
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

  describe('getFileByPathGit (scratch nested)', () => {
    it('resolves a nested scratch file to the scratch repo on main (DEV-10424)', async () => {
      // A nested file's parent dir ("/Notes/drafts") is a git subdirectory, not a DataFolder, so the
      // lookup returns null → the path resolves to the per-workbook scratch repo, read on `main`.
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue(null);
      (scratchGitService.getRepoFile as jest.Mock).mockResolvedValue({ content: 'hello' });

      const res = await service.getFileByPathGit(WORKBOOK_ID, '/Notes/drafts/post.md', ACTOR);

      // Folder-aware resolver called with no connector account → scratch repo.
      expect(scratchGitService.resolveRepoPathForFolder).toHaveBeenCalledWith(undefined, WORKBOOK_ID);
      // Read from main only; scratch has no dirty working copy and no diff.
      expect(scratchGitService.getRepoFile).toHaveBeenCalledWith('repo-123', 'main', '/Notes/drafts/post.md');
      expect(scratchGitService.getFolderDiff).not.toHaveBeenCalled();
      expect(res.file.content).toBe('hello');
      expect(res.file.ref.dirty).toBe(false);
    });
  });

  describe('deleteFileByPathGit (scratch)', () => {
    it('deletes a scratch file at a folder root from the scratch repo on main (DEV-10584)', async () => {
      // The owning top-level scratch folder ("/notes") is a DataFolder row with a null connector.
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue({ connectorAccountId: null });
      (scratchGitService.getRepoFile as jest.Mock).mockResolvedValue({ content: 'alpha' });

      await service.deleteFileByPathGit(WORKBOOK_ID, '/notes/post.md', ACTOR);

      // Connector-less → resolve the scratch repo and delete on `main` (not the default dirty branch).
      expect(scratchGitService.resolveRepoPathForFolder).toHaveBeenLastCalledWith(null, WORKBOOK_ID);
      expect(scratchGitService.deleteFile).toHaveBeenCalledWith(
        'repo-123',
        ['/notes/post.md'],
        expect.any(String),
        'main',
      );
    });

    it('deletes a nested scratch file from the scratch repo on main (DEV-10584)', async () => {
      // A nested file's parent dir ("/notes/drafts") is a git subdirectory, not a DataFolder row, so
      // the lookup returns null → still resolves to the per-workbook scratch repo on `main`.
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue(null);
      (scratchGitService.getRepoFile as jest.Mock).mockResolvedValue({ content: 'alpha' });

      await service.deleteFileByPathGit(WORKBOOK_ID, '/notes/drafts/post.md', ACTOR);

      expect(scratchGitService.resolveRepoPathForFolder).toHaveBeenLastCalledWith(undefined, WORKBOOK_ID);
      expect(scratchGitService.deleteFile).toHaveBeenCalledWith(
        'repo-123',
        ['/notes/drafts/post.md'],
        expect.any(String),
        'main',
      );
    });

    it('still deletes a connector file on the dirty branch (no regression)', async () => {
      (dbService.client.dataFolder.findFirst as jest.Mock).mockResolvedValue({ connectorAccountId: 'conn-123' });
      (scratchGitService.getRepoFile as jest.Mock).mockResolvedValue({ content: 'rec' });

      await service.deleteFileByPathGit(WORKBOOK_ID, '/my-folder/rec.json', ACTOR);

      expect(scratchGitService.resolveRepoPathForFolder).toHaveBeenLastCalledWith('conn-123', WORKBOOK_ID);
      expect(scratchGitService.deleteFile).toHaveBeenCalledWith(
        'repo-123',
        ['/my-folder/rec.json'],
        expect.any(String),
        'dirty',
      );
    });
  });

  describe('createFile (scratch)', () => {
    it('rejects a duplicate scratch file instead of silently overwriting it (DEV-10424)', async () => {
      // Parent is a connector-less scratch folder.
      (dbService.client.dataFolder.findUnique as jest.Mock).mockResolvedValue({
        id: FOLDER_ID,
        path: '/notes',
        workbookId: WORKBOOK_ID,
        connectorAccountId: null,
      });
      // A file already exists at the target path on main.
      (scratchGitService.getRepoFile as jest.Mock).mockResolvedValue({ content: 'existing' });

      await expect(
        service.createFile(WORKBOOK_ID, { name: 'post.md', parentFolderId: FOLDER_ID }, ACTOR),
      ).rejects.toThrow(BadRequestException);

      // The collision is caught before any write — no overwrite.
      expect(scratchGitService.commitFile).not.toHaveBeenCalled();
    });
  });
});
