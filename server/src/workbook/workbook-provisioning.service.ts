import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createWorkbookId, createWorkspacePermissionId, WorkbookManager } from '@spinner/shared-types';
import { WorkbookCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { getScratchRepoPath, ScratchGitService } from '../scratch-git/scratch-git.service';
import { getWorkbookRepoPath } from './workbook-repo.service';

export interface CreateWorkbookWithConfigRepoParams {
  /** Display name for the new workbook. */
  name: string;
  /** Owner of the workbook; also granted the initial `editor` workspace permission. */
  ownerUserId: string;
  /** Organization the workbook belongs to. */
  organizationId: string;
  /** Which external app manages this workbook, if any. Defaults to a standalone (null) workbook. */
  managedByApp?: WorkbookManager | null;
  /**
   * When true, also set this workbook as the owner's default ("last") workspace. Used by the signup
   * default-workspace flow; the manual "create workspace" flow leaves this false.
   */
  setAsOwnerDefaultWorkspace?: boolean;
}

/**
 * The single source of truth for bringing a workbook into existence.
 *
 * Creating a workbook means two things that MUST happen together: the Postgres `Workbook` row (plus the
 * owner's editor permission) and the bare git "config" repo on scratch-git that the desktop/CLI clone
 * during `init-workspace`. If the row exists without the repo, every desktop `init-workspace` for that
 * workbook fails with `Repository not found` — exactly the signup-default-workspace regression this
 * service was introduced to prevent.
 *
 * Both entry points — the manual "create workspace" API (`WorkbookService.create`) and the signup
 * default-workspace flow (`UsersService.createUserWithOrgAndDefaultWorkbook`) — delegate here so the two
 * can never drift apart again. The service lives in its own module (depending only on Db + ScratchGit) so
 * both `WorkbookModule` and `UserModule` can use it without a circular module dependency.
 */
@Injectable()
export class WorkbookProvisioningService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
  ) {}

  async createWorkbookWithConfigRepo(params: CreateWorkbookWithConfigRepoParams): Promise<WorkbookCluster.Workbook> {
    const { name, ownerUserId, organizationId, managedByApp, setAsOwnerDefaultWorkspace } = params;
    const workbookId = createWorkbookId();

    const newWorkbook = await this.db.client.workbook.create({
      data: {
        id: workbookId,
        userId: ownerUserId,
        organizationId,
        name,
        managedBy: managedByApp ?? null,
        version: 2,
        workspacePermissions: {
          create: {
            id: createWorkspacePermissionId(),
            userId: ownerUserId,
            role: 'editor',
          },
        },
        ...(setAsOwnerDefaultWorkspace ? { usersWithAsDefault: { connect: { id: ownerUserId } } } : {}),
      },
      include: WorkbookCluster._validator.include,
    });

    try {
      await this.scratchGitService.initRepo(getWorkbookRepoPath(organizationId, workbookId));
    } catch (error) {
      WSLogger.error({
        source: 'WorkbookProvisioningService.createWorkbookWithConfigRepo',
        message: 'Failed to initialize workbook config repo; rolling back the workbook row',
        workbookId,
        organizationId,
        error,
      });

      await this.db.client.workbook.delete({ where: { id: workbookId } });

      throw new InternalServerErrorException('Failed to initialize workbook config repo');
    }

    // Eagerly init the per-workbook scratch repo (standalone connector-less files, DEV-10424) so it
    // exists for the desktop clone and the first scratch write. Non-critical: unlike the config repo
    // we do NOT roll back the workbook on failure — the `init-scratch-repos` backfill migration and
    // the self-healing `ensureScratchRepo` on the write path repair any missing repo.
    try {
      await this.scratchGitService.initRepo(getScratchRepoPath(organizationId, workbookId));
    } catch (error) {
      WSLogger.error({
        source: 'WorkbookProvisioningService.createWorkbookWithConfigRepo',
        message: 'Failed to initialize scratch repo (will be repaired by init-scratch-repos backfill)',
        workbookId,
        organizationId,
        error,
      });
    }

    return newWorkbook;
  }
}
