import { BadRequestException, Controller, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { WorkbookId } from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { userToActor } from 'src/users/types';
import { DataFolderTableSpecStoreService } from './data-folder-table-spec-store.service';

/**
 * POST /scratch-git/:id/index/build — rebuild a connection repo's scratch-git file index on demand (dev tooling).
 * Same path and response as when it lived on `ScratchGitController`; it moved here (DEV-12616) because it now sends
 * the folders' stored table specs, and `ScratchGitModule` can't depend on the table spec store without a module cycle.
 */
@Controller('scratch-git')
@UseGuards(ScratchAuthGuard)
export class ConnectionRepoIndexController {
  constructor(
    private readonly scratchGitService: ScratchGitService,
    private readonly dataFolderTableSpecStore: DataFolderTableSpecStoreService,
  ) {}

  @Post(':id/index/build')
  async buildIndex(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<{ count: number }> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    if (!connectorAccountId) throw new BadRequestException('Connector account ID is required');
    // Scoped to the workbook (the DEV-12337 pattern): this route now reads the connection's stored table specs, so a
    // connection from another workbook must not resolve.
    const repoId = await this.scratchGitService.resolveConnectionRepoPathScopedToWorkbook(
      workbookId,
      connectorAccountId,
    );
    return this.dataFolderTableSpecStore.rebuildConnectionRepoIndexWithStoredTableSpecs(connectorAccountId, repoId);
  }
}
