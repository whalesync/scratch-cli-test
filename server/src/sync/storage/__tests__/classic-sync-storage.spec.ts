/* eslint-disable @typescript-eslint/unbound-method */
import type { DataFolderId, SyncId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { DIRTY_BRANCH, type RepoId, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import type { DataFolderTableSpecStoreService } from 'src/workbook/table-spec-store/data-folder-table-spec-store.service';
import { ClassicStagedGitCommitOutputSink, createClassicSyncStoragePorts } from '../classic-sync-storage';
import type { SyncDestinationFolderLocation } from '../sync-storage-ports';

const SYNC_ID = 'syn_1' as SyncId;
const REPO_ID = 'org_1/wkb_1/coa_1' as RepoId;
const DESTINATION_FOLDER: SyncDestinationFolderLocation = {
  dataFolderId: 'dfd_dest' as DataFolderId,
  folderPathWithoutLeadingSlash: 'Posts',
  connectorAccountId: 'coa_1',
};

function createScratchGitServiceMock(stagedFileCount: () => number): jest.Mocked<ScratchGitService> {
  return {
    stageFiles: jest.fn().mockResolvedValue(undefined),
    commitStagedFilesAtomic: jest.fn().mockImplementation(() => Promise.resolve({ committed: stagedFileCount() })),
    commitFilesToBranch: jest.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] }),
    cleanupStaging: jest.fn().mockResolvedValue(undefined),
    deleteFilesFromBranch: jest.fn().mockResolvedValue(undefined),
    resolveConnectionRepoPath: jest.fn().mockResolvedValue(REPO_ID),
    readRepoFilesByFolder: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ScratchGitService>;
}

function queueRecordFiles(sink: ClassicStagedGitCommitOutputSink, folderPath: string, count: number): void {
  for (let index = 0; index < count; index++) {
    const path = folderPath === '' ? `record-${index}.json` : `${folderPath}/record-${index}.json`;
    sink.queueRecordFileWrite({ path, content: `{"id":${index}}` });
  }
}

describe('ClassicStagedGitCommitOutputSink', () => {
  it('commits a write set that fits in one buffer directly, without touching staging', async () => {
    const scratchGitService = createScratchGitServiceMock(() => 0);
    const sink = new ClassicStagedGitCommitOutputSink(scratchGitService, SYNC_ID, DESTINATION_FOLDER, REPO_ID);

    queueRecordFiles(sink, 'Posts', 3);
    await sink.flushQueuedRecordFileWritesAtPageBoundary();
    await sink.commitQueuedRecordFileWrites();

    expect(sink.queuedRecordFileWriteCount).toBe(3);
    expect(scratchGitService.stageFiles).not.toHaveBeenCalled();
    expect(scratchGitService.commitFilesToBranch).toHaveBeenCalledWith(
      REPO_ID,
      DIRTY_BRANCH,
      expect.arrayContaining([{ path: 'Posts/record-0.json', content: '{"id":0}' }]),
      'Sync: batch write files',
    );
    expect(scratchGitService.cleanupStaging).not.toHaveBeenCalled();
  });

  it('spills a full page to staging (paths relative to the folder) and lands everything as one atomic commit', async () => {
    let stagedFileCount = 0;
    const scratchGitService = createScratchGitServiceMock(() => stagedFileCount);
    scratchGitService.stageFiles.mockImplementation((_key, _folder, files) => {
      stagedFileCount += files.length;
      return Promise.resolve();
    });
    const sink = new ClassicStagedGitCommitOutputSink(scratchGitService, SYNC_ID, DESTINATION_FOLDER, REPO_ID);

    queueRecordFiles(sink, 'Posts', 1000);
    await sink.flushQueuedRecordFileWritesAtPageBoundary();
    sink.queueRecordFileWrite({ path: 'Posts/tail.json', content: '{}' });
    await sink.commitQueuedRecordFileWrites();

    expect(scratchGitService.stageFiles).toHaveBeenCalledTimes(2);
    const [stagingKey, stagingFolder, firstStagedFiles] = scratchGitService.stageFiles.mock.calls[0];
    expect(stagingKey).toMatch(/^sync-syn_1-dfd_dest-/);
    expect(stagingFolder).toBe('Posts');
    expect(firstStagedFiles[0]).toEqual({ path: 'record-0.json', content: '{"id":0}' });
    expect(scratchGitService.commitStagedFilesAtomic).toHaveBeenCalledWith(
      stagingKey,
      REPO_ID,
      DIRTY_BRANCH,
      'Posts',
      'Sync: batch write files',
    );
    expect(scratchGitService.commitFilesToBranch).not.toHaveBeenCalled();
    expect(scratchGitService.cleanupStaging).toHaveBeenCalledWith(stagingKey);
    expect(sink.queuedRecordFileWriteCount).toBe(1001);
  });

  it('fails the commit when the atomic commit reports zero files (staging state lost), and still cleans up', async () => {
    const scratchGitService = createScratchGitServiceMock(() => 0);
    const sink = new ClassicStagedGitCommitOutputSink(scratchGitService, SYNC_ID, DESTINATION_FOLDER, REPO_ID);

    queueRecordFiles(sink, 'Posts', 1000);
    await sink.flushQueuedRecordFileWritesAtPageBoundary();

    await expect(sink.commitQueuedRecordFileWrites()).rejects.toThrow(/wrote 0 of 1000 staged file\(s\)/);
    expect(scratchGitService.cleanupStaging).toHaveBeenCalledTimes(1);
  });

  it('keeps a root-level destination folder on the buffered direct-commit path regardless of size', async () => {
    const scratchGitService = createScratchGitServiceMock(() => 0);
    const sink = new ClassicStagedGitCommitOutputSink(
      scratchGitService,
      SYNC_ID,
      { ...DESTINATION_FOLDER, folderPathWithoutLeadingSlash: '' },
      REPO_ID,
    );

    queueRecordFiles(sink, '', 1500);
    await sink.flushQueuedRecordFileWritesAtPageBoundary();
    await sink.commitQueuedRecordFileWrites();

    expect(scratchGitService.stageFiles).not.toHaveBeenCalled();
    expect(scratchGitService.commitFilesToBranch).toHaveBeenCalledTimes(1);
  });

  it('refuses to stage a write outside the destination folder', async () => {
    const scratchGitService = createScratchGitServiceMock(() => 0);
    const sink = new ClassicStagedGitCommitOutputSink(scratchGitService, SYNC_ID, DESTINATION_FOLDER, REPO_ID);

    queueRecordFiles(sink, 'Other', 1000);

    await expect(sink.flushQueuedRecordFileWritesAtPageBoundary()).rejects.toThrow(
      'is not under destination folder "Posts"',
    );
  });

  it('deletes record files from the dirty branch', async () => {
    const scratchGitService = createScratchGitServiceMock(() => 0);
    const sink = new ClassicStagedGitCommitOutputSink(scratchGitService, SYNC_ID, DESTINATION_FOLDER, REPO_ID);

    await sink.deleteRecordFiles(['Posts/a.json']);

    expect(scratchGitService.deleteFilesFromBranch).toHaveBeenCalledWith(
      REPO_ID,
      DIRTY_BRANCH,
      ['Posts/a.json'],
      'Sync: delete orphaned destination records',
    );
  });
});

describe('createClassicSyncStoragePorts', () => {
  it('resolves the destination repo once, when the output sink opens, and reuses it for destination reads', async () => {
    const scratchGitService = createScratchGitServiceMock(() => 0);
    const storagePorts = createClassicSyncStoragePorts({
      db: {} as DbService,
      dataFolderService: {} as DataFolderService,
      scratchGitService,
      dataFolderTableSpecStore: {} as DataFolderTableSpecStoreService,
      syncId: SYNC_ID,
      workbookId: 'wkb_1' as WorkbookId,
      actor: { userId: 'usr_1', organizationId: 'org_1' } as Actor,
    });

    await storagePorts.openDestinationOutputSink(DESTINATION_FOLDER);
    await storagePorts.recordSource.readDestinationRecordFilesByPath(DESTINATION_FOLDER, ['Posts/a.json']);

    expect(scratchGitService.resolveConnectionRepoPath).toHaveBeenCalledTimes(1);
    expect(scratchGitService.readRepoFilesByFolder).toHaveBeenCalledWith(REPO_ID, DIRTY_BRANCH, ['Posts/a.json']);
  });

  it('fails opening the output sink when the destination connection has no repo', async () => {
    const scratchGitService = createScratchGitServiceMock(() => 0);
    scratchGitService.resolveConnectionRepoPath.mockRejectedValue(new Error('Connector account ID is required'));
    const storagePorts = createClassicSyncStoragePorts({
      db: {} as DbService,
      dataFolderService: {} as DataFolderService,
      scratchGitService,
      dataFolderTableSpecStore: {} as DataFolderTableSpecStoreService,
      syncId: SYNC_ID,
      workbookId: 'wkb_1' as WorkbookId,
      actor: { userId: 'usr_1', organizationId: 'org_1' } as Actor,
    });

    await expect(
      storagePorts.openDestinationOutputSink({ ...DESTINATION_FOLDER, connectorAccountId: null }),
    ).rejects.toThrow('Connector account ID is required');
  });
});
