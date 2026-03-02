import { Injectable } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ScratchGitClient } from './scratch-git.client';
import { DIRTY_BRANCH, getRepoId, MAIN_BRANCH } from './scratch-git.service';

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

    const v2RepoId = getRepoId(2, workbookId, orgId, connAccount.id);

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
      const mainFiles = await this.readFolderFiles(v1RepoId, MAIN_BRANCH, folderPath);
      if (mainFiles.length > 0) {
        await this.scratchGitClient.commitFiles(v2RepoId, MAIN_BRANCH, mainFiles, `Migrate ${folderPath} from V1`);
      }
    }

    // 3. Rebase dirty onto the new main HEAD so that dirty's parent is main (not the initial
    //    commit).  In steady state V1 dirty is always rebased from main, so this preserves
    //    that invariant in the V2 repo.
    await this.scratchGitClient.rebaseDirty(v2RepoId);

    // 4. Commit only the dirty-delta files for every folder — i.e. files that exist on the
    //    V1 dirty branch but whose content differs from V1 main.  Files that are identical
    //    on both branches carry no user edits and don't need a dirty commit.
    for (const folder of connAccount.dataFolders) {
      const folderPath = (folder.path ?? folder.name).replace(/^\//, '');
      const dirtyDelta = await this.readDirtyDelta(v1RepoId, folderPath);
      if (dirtyDelta.length > 0) {
        await this.scratchGitClient.commitFiles(
          v2RepoId,
          DIRTY_BRANCH,
          dirtyDelta,
          `Migrate dirty changes for ${folderPath} from V1`,
        );
      }
    }

    WSLogger.info({
      source: 'MigrationService.migrateConnection',
      message: 'Connection migrated',
      workbookId,
      connAccountId: connAccount.id,
    });
  }

  /**
   * Returns the files that exist on the dirty branch of v1RepoId under folderPath whose
   * content differs from main.  These are the uncommitted user edits that need to be
   * carried over to the V2 dirty branch.
   */
  private async readDirtyDelta(
    v1RepoId: string,
    folderPath: string,
  ): Promise<Array<{ path: string; content: string }>> {
    const [mainFiles, dirtyFiles] = await Promise.all([
      this.readFolderFiles(v1RepoId, MAIN_BRANCH, folderPath),
      this.readFolderFiles(v1RepoId, DIRTY_BRANCH, folderPath),
    ]);

    const mainByPath = new Map(mainFiles.map((f) => [f.path, f.content]));

    // Keep only dirty files whose content differs from main (new or modified)
    return dirtyFiles.filter((f) => mainByPath.get(f.path) !== f.content);
  }

  /**
   * List all files under folderPath on a branch and return their path+content.
   * Returns an empty array if the folder doesn't exist on that branch.
   */
  private async readFolderFiles(
    repoId: string,
    branch: string,
    folderPath: string,
  ): Promise<Array<{ path: string; content: string }>> {
    try {
      const entries = await this.scratchGitClient.list(repoId, branch, folderPath);
      const filePaths = entries
        .filter((e: { type: string; path: string }) => e.type === 'file')
        .map((e: { path: string }) => e.path);

      if (filePaths.length === 0) return [];

      const results = await this.scratchGitClient.readFiles(repoId, branch, filePaths);
      return results
        .filter((r): r is { path: string; content: string } => r.content !== null)
        .map((r) => ({ path: r.path, content: r.content }));
    } catch {
      // Folder may not exist on this branch — not an error
      return [];
    }
  }
}
