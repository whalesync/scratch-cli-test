import { Injectable } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ScratchGitClient } from './scratch-git.client';
import { DIRTY_BRANCH, getDefaultRepoPath, MAIN_BRANCH } from './scratch-git.service';

const MIGRATION_BATCH_SIZE = 500;

@Injectable()
export class MigrationService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitClient: ScratchGitClient,
  ) {}

  /**
   * Migrate a workbook from V1 (single repo per workbook) to V2 (one repo per connection).
   *
   * For each ConnectorAccount linked to the workbook:
   *  1. Init a new V2 repo at `repos-v2/{orgId}/{workbookId}/{connAccountId}.git`.
   *  2. Collect all DataFolders for this connection.
   *  3. For each folder, read all files from main + dirty branches in the V1 repo and commit
   *     them into the V2 repo on the matching branch.
   *
   * The V1 repo is NOT deleted — it remains as a fallback.
   * Once all repos are migrated, the workbook version is set to 2.
   */
  async migrateWorkbookToV2(workbookId: WorkbookId): Promise<void> {
    const workbook = await this.db.client.workbook.findUnique({
      where: { id: workbookId },
      include: {
        connectorAccounts: {
          include: {
            dataFolders: true,
          },
        },
      },
    });

    if (!workbook) {
      throw new Error(`Workbook ${workbookId} not found`);
    }

    if (workbook.version >= 2) {
      throw new Error(`Workbook ${workbookId} is already at version ${workbook.version}`);
    }

    const orgId = workbook.organizationId;
    if (!orgId) {
      throw new Error(`Workbook ${workbookId} has no organizationId`);
    }

    const v1RepoId = workbookId;

    WSLogger.info({
      source: 'MigrationService.migrateWorkbookToV2',
      message: 'Starting V1→V2 migration',
      workbookId,
      connectionCount: workbook.connectorAccounts.length,
    });

    for (const connAccount of workbook.connectorAccounts) {
      await this.migrateConnection({ v1RepoId, workbookId, orgId, connAccount });
    }

    // Bump workbook version to 2
    await this.db.client.workbook.update({
      where: { id: workbookId },
      data: { version: 2 },
    });

    WSLogger.info({
      source: 'MigrationService.migrateWorkbookToV2',
      message: 'Migration complete',
      workbookId,
    });
  }

  private async migrateConnection(params: {
    v1RepoId: string;
    workbookId: WorkbookId;
    orgId: string;
    connAccount: { id: string; displayName: string; dataFolders: { path: string | null; name: string }[] };
  }): Promise<void> {
    const { v1RepoId, workbookId, orgId, connAccount } = params;

    const v2RepoId = getDefaultRepoPath(orgId, workbookId, connAccount.id);

    WSLogger.info({
      source: 'MigrationService.migrateConnection',
      message: 'Migrating connection',
      workbookId,
      connAccountId: connAccount.id,
      v2RepoId,
      folderCount: connAccount.dataFolders.length,
    });

    // 1. Init the V2 repo (creates main + dirty both pointing to the same initial commit)
    await this.scratchGitClient.initRepo(v2RepoId);

    // 2. Commit all main-branch files for every folder
    for (const folder of connAccount.dataFolders) {
      const folderPath = (folder.path ?? folder.name).replace(/^\//, '');
      const filePaths = await this.listFolderFiles(v1RepoId, MAIN_BRANCH, folderPath);
      for (let i = 0; i < filePaths.length; i += MIGRATION_BATCH_SIZE) {
        const chunkPaths = filePaths.slice(i, i + MIGRATION_BATCH_SIZE);
        const chunkFiles = await this.readBatchFiles(v1RepoId, MAIN_BRANCH, chunkPaths);
        if (chunkFiles.length > 0) {
          await this.scratchGitClient.commitFiles(v2RepoId, MAIN_BRANCH, chunkFiles, `Migrate ${folderPath} from V1`);
          WSLogger.info({
            source: 'MigrationService.migrateConnection',
            message: 'Committed main branch batch',
            workbookId,
            connAccountId: connAccount.id,
            v2RepoId,
            folderPath,
            batchStart: i,
            batchSize: chunkFiles.length,
            totalFiles: filePaths.length,
          });
        }
      }
    }

    // 3. Rebase dirty onto the new main HEAD so that dirty's parent is main (not the initial
    //    commit).  In steady state V1 dirty is always rebased from main, so this preserves
    //    that invariant in the V2 repo.
    await this.scratchGitClient.rebaseDirty(v2RepoId);

    // 4. Commit only the dirty-delta files for every folder — i.e. files that exist on the
    //    V1 dirty branch but whose content differs from V1 main.
    for (const folder of connAccount.dataFolders) {
      const folderPath = (folder.path ?? folder.name).replace(/^\//, '');
      const folderDiff = await this.scratchGitClient.getFolderDiff(v1RepoId, folderPath);

      const modifiedOrAdded = folderDiff
        .filter((d) => d.status === 'modified' || d.status === 'added')
        .map((d) => d.path);
      const deletedPaths = folderDiff.filter((d) => d.status === 'deleted').map((d) => d.path);

      for (let i = 0; i < modifiedOrAdded.length; i += MIGRATION_BATCH_SIZE) {
        const chunkPaths = modifiedOrAdded.slice(i, i + MIGRATION_BATCH_SIZE);
        const chunkFiles = await this.readBatchFiles(v1RepoId, DIRTY_BRANCH, chunkPaths);

        if (chunkFiles.length > 0) {
          await this.scratchGitClient.commitFiles(
            v2RepoId,
            DIRTY_BRANCH,
            chunkFiles,
            `Migrate dirty changes for ${folderPath} from V1`,
          );
          WSLogger.info({
            source: 'MigrationService.migrateConnection',
            message: 'Committed dirty branch batch',
            workbookId,
            connAccountId: connAccount.id,
            v2RepoId,
            folderPath,
            batchStart: i,
            batchSize: chunkFiles.length,
            totalFiles: modifiedOrAdded.length,
          });
        }
      }

      for (let i = 0; i < deletedPaths.length; i += MIGRATION_BATCH_SIZE) {
        const chunkPaths = deletedPaths.slice(i, i + MIGRATION_BATCH_SIZE);
        await this.scratchGitClient.deleteFiles(
          v2RepoId,
          DIRTY_BRANCH,
          chunkPaths,
          `Migrate dirty deletes for ${folderPath} from V1`,
        );
        WSLogger.info({
          source: 'MigrationService.migrateConnection',
          message: 'Committed dirty deletes batch',
          workbookId,
          connAccountId: connAccount.id,
          v2RepoId,
          folderPath,
          batchStart: i,
          batchSize: chunkPaths.length,
          totalFiles: deletedPaths.length,
        });
      }
    }
    // 5. Persist the V2 repo path on the connector account
    await this.db.client.connectorAccount.update({
      where: { id: connAccount.id },
      data: { repoPath: v2RepoId },
    });

    WSLogger.info({
      source: 'MigrationService.migrateConnection',
      message: 'Connection migrated',
      workbookId,
      connAccountId: connAccount.id,
      v2RepoId,
    });
  }

  /**
   * List all files under folderPath on a branch and return their paths.
   * Returns an empty array if the folder doesn't exist on that branch.
   */
  private async listFolderFiles(repoId: string, branch: string, folderPath: string): Promise<string[]> {
    try {
      const entries = await this.scratchGitClient.list(repoId, branch, folderPath);
      return entries
        .filter((e: { type: string; path: string }) => e.type === 'file')
        .map((e: { path: string }) => e.path);
    } catch {
      // Folder may not exist on this branch — not an error
      return [];
    }
  }

  /**
   * Read the contents of a specific batch of file paths.
   */
  private async readBatchFiles(
    repoId: string,
    branch: string,
    filePaths: string[],
  ): Promise<Array<{ path: string; content: string }>> {
    if (filePaths.length === 0) return [];
    try {
      const results = await this.scratchGitClient.readFiles(repoId, branch, filePaths);
      return results
        .filter((r): r is { path: string; content: string } => r.content !== null)
        .map((r) => ({ path: r.path, content: r.content }));
    } catch {
      return [];
    }
  }
}
