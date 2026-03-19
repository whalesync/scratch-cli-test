import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
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
import { MigrationService, StripPrefixConnectionResult } from './migration.service';
import { GitIndexDump } from './scratch-git.client';
import { ScratchGitService } from './scratch-git.service';

@Controller('scratch-git')
@UseGuards(ScratchAuthGuard)
export class ScratchGitController {
  constructor(
    private readonly scratchGitService: ScratchGitService,
    private readonly migrationService: MigrationService,
    private readonly db: DbService,
  ) {}

  /**
   * When connectorAccountId is provided, returns that connection's repo ID.
   * Otherwise returns all per-connection repo IDs for the workbook.
   */
  private async resolveAllRepoIds(workbookId: WorkbookId, connectorAccountId?: string): Promise<string[]> {
    if (connectorAccountId) {
      const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
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
    @Req() req: RequestWithUser,
  ): Promise<any[]> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
    return this.scratchGitService.listRepoFiles(repoId, branch, folder);
  }

  @Get(':id/file')
  async getRepoFile(
    @Param('id') workbookId: WorkbookId,
    @Query('branch') branch = 'main',
    @Query('path') path: string,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<{ content: string } | null> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
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
    if (repoIds.length === 1) {
      return this.scratchGitService.getRepoStatus(repoIds[0]);
    }
    // V2 aggregation: concatenate dirty file lists across all connection repos
    const results = await Promise.all(repoIds.map((id) => this.scratchGitService.getRepoStatus(id)));
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
    if (repoIds.length === 1) {
      return this.scratchGitService.hasDirtyFiles(repoIds[0]);
    }
    // V2 aggregation: dirty if any connection repo has diffs
    const results = await Promise.all(repoIds.map((id) => this.scratchGitService.hasDirtyFiles(id)));
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
    if (repoIds.length === 1) {
      return this.scratchGitService.getRepoStatusCount(repoIds[0]);
    }
    // V2 aggregation: sum counts across all connection repos
    const results = await Promise.all(repoIds.map((id) => this.scratchGitService.getRepoStatusCount(id)));
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
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
    return this.scratchGitService.getFileDiff(repoId, path);
  }

  @Get(':id/graph')
  async getGraph(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<unknown> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
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
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
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
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
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
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
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
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
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
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
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
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, dataFolder?.connectorAccountId ?? undefined);
    return this.scratchGitService.deleteAllFilesInDataFolder(repoId, folderPath);
  }

  @Post(':id/migrate-to-v2')
  async migrateToV2(@Param('id') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<{ success: boolean }> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    await this.migrationService.migrateWorkbookToV2(workbookId);
    return { success: true };
  }

  @Post(':id/strip-connection-prefix')
  async stripConnectionPrefix(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<{ results: StripPrefixConnectionResult[] }> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId);
    const results = await this.migrationService.stripConnectionPrefixForWorkbook(workbookId, connectorAccountId);
    return { results };
  }
}
