import { Injectable } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { Actor } from 'src/users/types';
import { RoutineDefinitionStoreService } from './routine-definition-store.service';

/**
 * Transitional one-way mirror of routine definitions (Postgres, DEV-11399) into `routines/*.yaml`
 * of the workbook config git repo. Pre-DEV-11399 `scratchmd routines pull|status` binaries read
 * that repo directly, so while `ROUTINES_GIT_MIRROR_ENABLED` is on every definition change
 * converges git to the DB: changed/new rows are committed, git files with no row are deleted.
 * Full-state rather than per-operation, so a dropped background call self-heals on the next write.
 *
 * Nothing ever reads routine definitions back from git except the one-time import in
 * {@link RoutineDefinitionStoreService.ensureImportedFromGit}. This is the single hook to remove
 * once the REST-backed CLI has shipped and the `routine-git-cleanup` migration has run.
 */
@Injectable()
export class RoutineGitMirrorService {
  constructor(
    private readonly scratchConfigService: ScratchConfigService,
    private readonly scratchGitService: ScratchGitService,
    private readonly store: RoutineDefinitionStoreService,
  ) {}

  isEnabled(): boolean {
    return this.scratchConfigService.isRoutinesGitMirrorEnabled();
  }

  /** Fire-and-forget mirror; failures are logged, never surfaced (the DB write already succeeded). */
  mirrorWorkbookRoutinesInBackground(workbookId: WorkbookId, actor: Actor): void {
    this.mirrorWorkbookRoutines(workbookId, actor).catch((error: unknown) => {
      WSLogger.warn({
        source: 'RoutineGitMirrorService.mirrorWorkbookRoutinesInBackground',
        message: 'Failed to mirror routine definitions to the workbook config repo',
        error,
        workbookId,
      });
    });
  }

  /**
   * Converges `routines/` on the config repo `main` to the DB rows. Returns the resulting `main`
   * head (what pre-DEV-11399 CLIs re-materialize to after a push), or `null` when the mirror is
   * disabled. Throws on git failure — the background wrapper is what swallows.
   */
  async mirrorWorkbookRoutines(workbookId: WorkbookId, actor: Actor): Promise<string | null> {
    if (!this.isEnabled()) {
      return null;
    }
    const repoId = await this.store.resolveConfigRepoId(workbookId);
    const definitions = await this.store.listDefinitions(workbookId);
    const gitFiles = await this.store.readRoutineFilesFromGit(repoId);
    const gitContentByPath = new Map(gitFiles.map((file) => [file.path, file.content]));
    const definitionFilePathSet = new Set(definitions.map((definition) => definition.filePath));

    const filesToCommit = definitions
      .filter((definition) => gitContentByPath.get(definition.filePath) !== definition.content)
      .map((definition) => ({ path: definition.filePath, content: definition.content }));
    const pathsToDelete = gitFiles
      .map((file) => file.path)
      .filter((gitFilePath) => !definitionFilePathSet.has(gitFilePath));

    if (filesToCommit.length > 0) {
      await this.scratchGitService.commitFilesToBranch(
        repoId,
        MAIN_BRANCH,
        filesToCommit,
        `Mirror routines: ${filesToCommit.length} file(s) (${actor.userId})`,
      );
    }
    if (pathsToDelete.length > 0) {
      await this.scratchGitService.deleteFilesFromBranch(
        repoId,
        MAIN_BRANCH,
        pathsToDelete,
        `Mirror routines: ${pathsToDelete.length} delete(s) (${actor.userId})`,
      );
    }
    if (filesToCommit.length > 0 || pathsToDelete.length > 0) {
      WSLogger.info({
        source: 'RoutineGitMirrorService.mirrorWorkbookRoutines',
        message: `Mirrored routines to git: ${filesToCommit.length} committed, ${pathsToDelete.length} deleted`,
        workbookId,
      });
    }
    return this.scratchGitService.getBranchHead(repoId, MAIN_BRANCH);
  }
}
