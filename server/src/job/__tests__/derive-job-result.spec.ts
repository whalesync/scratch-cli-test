import {
  deriveJobResult,
  DiscardPendingChangesPublicProgress,
  JobType,
  PublishPublicProgress,
  PullLinkedFolderFilesPublicProgress,
  SyncDataFoldersPublicProgress,
} from '@spinner/shared-types';

/**
 * The shared job → render-ready result derivation (`packages/shared-types/src/db/job-result.ts`).
 * shared-types has no test runner of its own, so its behaviour is covered here — the server is the
 * heaviest consumer (routine steps + the routine run summary).
 *
 * The focus is DEV-11256: a job that is still running must be described in the present tense, with
 * progress, instead of as a finished tally of counters that have not moved yet.
 */

function pullProgress(
  overrides: Partial<PullLinkedFolderFilesPublicProgress> = {},
): PullLinkedFolderFilesPublicProgress {
  return {
    totalFiles: 0,
    folderCount: 1,
    connectionName: 'HubSpot',
    folderId: 'dfd_1',
    folderName: 'Companies',
    connector: 'HUBSPOT',
    filter: null,
    status: 'active',
    createdPaths: [],
    updatedPaths: [],
    deletedPaths: [],
    createdCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    folders: [],
    ...overrides,
  };
}

function pullFolderProgress(
  overrides: Partial<PullLinkedFolderFilesPublicProgress['folders'][number]> = {},
): PullLinkedFolderFilesPublicProgress['folders'][number] {
  return {
    id: 'dfd_1',
    name: 'Companies',
    connector: 'HUBSPOT',
    creates: 0,
    updates: 0,
    deletes: 0,
    totalFiles: 0,
    createdPaths: [],
    updatedPaths: [],
    deletedPaths: [],
    status: 'pending',
    ...overrides,
  };
}

function syncTableProgress(
  overrides: Partial<SyncDataFoldersPublicProgress['tables'][number]> = {},
): SyncDataFoldersPublicProgress['tables'][number] {
  return {
    id: 'dfd_1',
    name: 'Deals',
    connector: 'HUBSPOT',
    creates: 0,
    updates: 0,
    deletes: 0,
    skipped: 0,
    createdPaths: [],
    updatedPaths: [],
    deletedPaths: [],
    errorCount: 0,
    errors: [],
    warningCount: 0,
    warnings: [],
    status: 'pending',
    ...overrides,
  };
}

function publishProgress(overrides: Partial<PublishPublicProgress> = {}): PublishPublicProgress {
  return {
    status: 'running',
    assetUploadsExecuted: 0,
    assetUploadsPlanned: 0,
    editsExecuted: 0,
    createsExecuted: 0,
    deletesExecuted: 0,
    backfillsExecuted: 0,
    renameFilesExecuted: 0,
    editsPlanned: 0,
    createsPlanned: 0,
    deletesPlanned: 0,
    backfillsPlanned: 0,
    renameFilesPlanned: 0,
    errorCount: 0,
    ...overrides,
  };
}

describe('deriveJobResult', () => {
  describe('a pull that is still running', () => {
    it('names the folder in flight and reports the records fetched so far', () => {
      const result = deriveJobResult({
        type: JobType.PullLinkedFolderFiles,
        isRunning: true,
        publicProgress: pullProgress({
          folderCount: 3,
          totalFiles: 1200,
          folders: [
            pullFolderProgress({ id: 'dfd_1', name: 'Contacts', status: 'completed' }),
            pullFolderProgress({ id: 'dfd_2', name: 'Companies', status: 'active' }),
            pullFolderProgress({ id: 'dfd_3', name: 'Deals', status: 'pending' }),
          ],
        }),
      });

      expect(result.summary).toBe('Pulling Companies — 1,200 records fetched');
    });

    it('reports the folder count while several folders are fetched concurrently', () => {
      const result = deriveJobResult({
        type: JobType.PullLinkedFolderFiles,
        isRunning: true,
        publicProgress: pullProgress({
          folderCount: 3,
          totalFiles: 400,
          folders: [
            pullFolderProgress({ id: 'dfd_1', name: 'Contacts', status: 'active' }),
            pullFolderProgress({ id: 'dfd_2', name: 'Companies', status: 'active' }),
            pullFolderProgress({ id: 'dfd_3', name: 'Deals', status: 'pending' }),
          ],
        }),
      });

      expect(result.summary).toBe('Pulling 3 folders — 400 records fetched');
    });

    it('omits the record count until something has been fetched', () => {
      const result = deriveJobResult({
        type: JobType.PullLinkedFolderFiles,
        isRunning: true,
        publicProgress: pullProgress({ folderCount: 2, folders: [], totalFiles: 0 }),
      });

      expect(result.summary).toBe('Pulling 2 folders…');
    });

    it("drops the 'Unchanged' stat, which mid-run would count every record fetched but not yet written", () => {
      const result = deriveJobResult({
        type: JobType.PullLinkedFolderFiles,
        isRunning: true,
        publicProgress: pullProgress({ totalFiles: 1200 }),
      });

      expect(result.stats.map((stat) => stat.label)).toEqual(['New', 'Updated', 'Deleted']);
    });
  });

  describe('a finished pull', () => {
    it('still reads as a past-tense final tally', () => {
      const result = deriveJobResult({
        type: JobType.PullLinkedFolderFiles,
        publicProgress: pullProgress({ folderCount: 3, totalFiles: 2100, status: 'completed' }),
      });

      expect(result.summary).toBe('Pulled 3 folders — no changes');
      expect(result.stats.map((stat) => stat.label)).toEqual(['New', 'Updated', 'Deleted', 'Unchanged']);
    });

    it('reports the changed record count when the pull changed something', () => {
      const result = deriveJobResult({
        type: JobType.PullLinkedFolderFiles,
        publicProgress: pullProgress({ folderCount: 3, totalFiles: 2100, createdCount: 5, updatedCount: 2 }),
      });

      expect(result.summary).toBe('Pulled 7 records across 3 folders');
    });
  });

  describe('a sync that is still running', () => {
    it('names the table in flight', () => {
      const result = deriveJobResult({
        type: JobType.SyncDataFolders,
        isRunning: true,
        publicProgress: {
          totalFilesSynced: 450,
          tables: [
            syncTableProgress({ id: 'dfd_1', name: 'Contacts', status: 'completed' }),
            syncTableProgress({ id: 'dfd_2', name: 'Deals', status: 'in_progress' }),
          ],
        } satisfies SyncDataFoldersPublicProgress,
      });

      expect(result.summary).toBe('Syncing Deals — 450 records synced');
    });

    it('falls back to the table count when no table has started', () => {
      const result = deriveJobResult({
        type: JobType.SyncDataFolders,
        isRunning: true,
        publicProgress: {
          totalFilesSynced: 0,
          tables: [syncTableProgress({ id: 'dfd_1' }), syncTableProgress({ id: 'dfd_2', name: 'Deals' })],
        } satisfies SyncDataFoldersPublicProgress,
      });

      expect(result.summary).toBe('Syncing 2 tables…');
    });
  });

  describe('a publish that is still running', () => {
    it('reports progress against the planned change count', () => {
      const result = deriveJobResult({
        type: JobType.Publish,
        isRunning: true,
        publicProgress: publishProgress({
          createsPlanned: 200,
          editsPlanned: 140,
          createsExecuted: 100,
          editsExecuted: 20,
        }),
      });

      expect(result.summary).toBe('Publishing 120 of 340 changes');
    });

    it('says it is planning before the plan exists', () => {
      const result = deriveJobResult({
        type: JobType.Publish,
        isRunning: true,
        publicProgress: publishProgress({ status: 'planning' }),
      });

      expect(result.summary).toBe('Planning the publish…');
    });

    it('describes a publish-PLAN step as building the plan', () => {
      const result = deriveJobResult({
        type: JobType.Publish,
        publishMode: 'plan',
        isRunning: true,
        publicProgress: publishProgress({ status: 'planning' }),
      });

      expect(result.summary).toBe('Building the publish plan…');
    });

    it('still reports the completed plan/run headline once it finishes', () => {
      const staged = deriveJobResult({
        type: JobType.Publish,
        publishMode: 'plan',
        publicProgress: publishProgress({ status: 'completed', createsPlanned: 3 }),
      });
      const published = deriveJobResult({
        type: JobType.Publish,
        publicProgress: publishProgress({ status: 'completed', createsExecuted: 3 }),
      });

      expect(staged.summary).toBe('Staged a publish plan (3 changes)');
      expect(published.summary).toBe('Published 3 changes');
    });
  });

  describe('a discard-pending-changes step that is still running', () => {
    it('says it is clearing, not that the workspace is ready', () => {
      const result = deriveJobResult({
        type: JobType.DiscardPendingChanges,
        isRunning: true,
        publicProgress: {
          status: 'active',
          totalDiscarded: 0,
          connections: [],
        } satisfies DiscardPendingChangesPublicProgress,
      });

      expect(result.summary).toBe('Clearing leftover changes…');
    });
  });

  it('describes a job whose progress has not been checkpointed yet', () => {
    expect(deriveJobResult({ type: JobType.PullLinkedFolderFiles, isRunning: true }).summary).toBe('Pulling…');
    expect(deriveJobResult({ type: JobType.SyncDataFolders, isRunning: true }).summary).toBe('Syncing…');
    expect(deriveJobResult({ type: JobType.PullLinkedFolderFiles }).summary).toBe('Pull completed');
  });
});
