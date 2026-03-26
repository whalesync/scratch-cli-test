import { All, Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type {
  DirtyFileCountResponse,
  GitGcResponse,
  GitObjectCountsResponse,
  HasDirtyFilesResponse,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { DbService } from 'src/db/db.service';
import { checkWorkspacePermissions } from 'src/users/permissions';
import { userToActor } from 'src/users/types';
import { getWorkbookRepoPath } from 'src/workbook/workbook-repo.service';
import { GitIndexDump, RepoFileRef, ScratchGitNotFoundError } from './scratch-git.client';
import { ScratchGitService } from './scratch-git.service';

@Controller('scratch-git')
@UseGuards(ScratchAuthGuard)
export class ScratchGitController {
  constructor(
    private readonly scratchGitService: ScratchGitService,
    private readonly db: DbService,
  ) {}

  /**
   * When connectorAccountId is provided, returns that connection's repo ID.
   * Otherwise returns all per-connection repo IDs for the workbook.
   */
  private async resolveAllRepoIds(workbookId: WorkbookId, connectorAccountId?: string): Promise<string[]> {
    if (connectorAccountId) {
      const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
      return [repoId];
    }

    const connAccounts = await this.db.client.connectorAccount.findMany({
      where: { workbookId, repoPath: { not: null } },
      select: { repoPath: true },
    });

    return connAccounts.map((ca) => ca.repoPath as string);
  }

  @Get(':id/list')
  async listRepoFiles(
    @Param('id') workbookId: WorkbookId,
    @Query('branch') branch = 'main',
    @Query('folder') folder = '',
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Query('useConfigRepo') useConfigRepo: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<RepoFileRef[]> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId =
      useConfigRepo === 'true'
        ? getWorkbookRepoPath(actor.organizationId, workbookId)
        : await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.listRepoFiles(repoId, branch, folder);
  }

  @Get(':id/file')
  async getRepoFile(
    @Param('id') workbookId: WorkbookId,
    @Query('branch') branch = 'main',
    @Query('path') path: string,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Query('useConfigRepo') useConfigRepo: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<{ content: string } | null> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId =
      useConfigRepo === 'true'
        ? getWorkbookRepoPath(actor.organizationId, workbookId)
        : await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.getRepoFile(repoId, branch, path);
  }

  @Get(':id/git-status')
  async getRepoStatus(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoIds = await this.resolveAllRepoIds(workbookId, connectorAccountId);
    // V2 aggregation: concatenate dirty file lists across all connection repos.
    // Repos that don't exist yet (not pulled) are skipped — they have no status.
    const results = await Promise.all(
      repoIds.map((id) =>
        this.scratchGitService.getRepoStatus(id).catch((err) => {
          if (err instanceof ScratchGitNotFoundError) return [];
          throw err;
        }),
      ),
    );
    return (results as unknown[][]).flat();
  }

  @Get(':id/git-has-dirty')
  async hasDirtyFiles(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<HasDirtyFilesResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoIds = await this.resolveAllRepoIds(workbookId, connectorAccountId);
    // Repos that don't exist yet (not pulled) are not dirty.
    const results = await Promise.all(
      repoIds.map((id) =>
        this.scratchGitService.hasDirtyFiles(id).catch((err) => {
          if (err instanceof ScratchGitNotFoundError) return { dirty: false };
          throw err;
        }),
      ),
    );
    return { dirty: results.some((r) => r.dirty) };
  }

  @Get(':id/git-status-count')
  async getRepoStatusCount(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<DirtyFileCountResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoIds = await this.resolveAllRepoIds(workbookId, connectorAccountId);
    // Repos that don't exist yet (not pulled) have 0 dirty files.
    const results = await Promise.all(
      repoIds.map((id) =>
        this.scratchGitService.getRepoStatusCount(id).catch((err) => {
          if (err instanceof ScratchGitNotFoundError) return { count: 0 };
          throw err;
        }),
      ),
    );
    return { count: results.reduce((sum, r) => sum + r.count, 0) };
  }

  @Get(':id/git-diff')
  async getFileDiff(
    @Param('id') workbookId: WorkbookId,
    @Query('path') path: string,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.getFileDiff(repoId, path);
  }

  @Get(':id/graph')
  async getGraph(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Query('useConfigRepo') useConfigRepo: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId =
      useConfigRepo === 'true'
        ? getWorkbookRepoPath(actor.organizationId, workbookId)
        : await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.getGraph(repoId);
  }

  @Post(':id/rebase')
  async rebaseDirty(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.rebaseDirty(repoId);
  }

  @Post(':id/index/build')
  async buildIndex(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<{ count: number }> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.buildIndex(repoId);
  }

  @Get(':id/index/dump')
  async dumpIndex(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<GitIndexDump> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.dumpIndex(repoId);
  }

  @Get(':id/object-counts')
  async getObjectCounts(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<GitObjectCountsResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.getObjectCounts(repoId);
  }

  @Post(':id/gc')
  async runGitGc(
    @Param('id') workbookId: WorkbookId,
    @Body('aggressive') aggressive: boolean | undefined,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<GitGcResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.runGitGc(repoId, aggressive);
  }

  @Post(':id/checkpoint')
  async createCheckpoint(
    @Param('id') workbookId: WorkbookId,
    @Body('name') name: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.scratchGitService.createCheckpoint(workbookId, name);
  }

  @Get(':id/checkpoints')
  async listCheckpoints(
    @Param('id') workbookId: WorkbookId,
    @Req() req: RequestWithUser,
  ): Promise<{ name: string; timestamp: number; message: string }[]> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.scratchGitService.listCheckpoints(workbookId);
  }

  @Post(':id/checkpoint/revert')
  async revertToCheckpoint(
    @Param('id') workbookId: WorkbookId,
    @Body('name') name: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.scratchGitService.revertToCheckpoint(workbookId, name);
  }

  @Delete(':id/checkpoint/:name')
  async deleteCheckpoint(
    @Param('id') workbookId: WorkbookId,
    @Param('name') name: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    return this.scratchGitService.deleteCheckpoint(workbookId, name);
  }

  @Delete(':id/data-folder/files')
  async deleteAllFilesInDataFolder(
    @Param('id') workbookId: WorkbookId,
    @Query('path') folderPath: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: folderPath },
      select: { connectorAccountId: true },
    });
    if (!dataFolder?.connectorAccountId) {
      throw new Error(`Data folder ${folderPath} not found or not linked to a connection`);
    }
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(dataFolder.connectorAccountId);
    return this.scratchGitService.deleteAllFilesInDataFolder(repoId, folderPath);
  }

  @All(':id/git-service/:connectionId/*')
  async proxyToGitService(
    @Param('id') workbookId: WorkbookId,
    @Param('connectionId') connectorAccountId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);

    // Extract path robustly from the raw URL to bypass NestJS/Express parameter mapping inconsistencies.
    // URL typically looks like: /api/scratch-git/{id}/git-service/{connectionId}/api/repo/...
    const urlParts = req.url.split('/git-service/');
    let path = '';
    if (urlParts.length > 1) {
      const remaining = urlParts[1].split('?')[0]; // strip query string
      const segments = remaining.split('/');
      segments.shift(); // remove connectionId
      path = segments.join('/');
    }

    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    return this.scratchGitService.proxyToGitService(repoId, path, req.method, body);
  }
}
