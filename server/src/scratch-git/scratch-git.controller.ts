import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  DirtyFileCountResponse,
  GitGcResponse,
  GitObjectCountsResponse,
  HasDirtyFilesResponse,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import { DbService } from 'src/db/db.service';
import { MigrationService } from './migration.service';
import { ScratchGitService, getRepoId } from './scratch-git.service';

@Controller('scratch-git')
@UseGuards(ScratchAuthGuard)
export class ScratchGitController {
  constructor(
    private readonly scratchGitService: ScratchGitService,
    private readonly migrationService: MigrationService,
    private readonly db: DbService,
  ) {}

  /**
   * For V2 workbooks with no connectorAccountId, returns all per-connection repo IDs.
   * For V1 workbooks or when connectorAccountId is provided, returns a single-element array.
   */
  private async resolveAllRepoIds(workbookId: WorkbookId, connectorAccountId?: string): Promise<string[]> {
    const workbook = await this.db.client.workbook.findUnique({ where: { id: workbookId } });
    if (!workbook) throw new Error(`Workbook ${workbookId} not found`);

    if (workbook.version < 2 || connectorAccountId) {
      const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
      return [repoId];
    }

    // V2 with no connectorAccountId: aggregate across all connections
    const connAccounts = await this.db.client.connectorAccount.findMany({
      where: { workbookId },
      select: { id: true },
    });

    if (connAccounts.length === 0) {
      return [workbookId]; // no connections yet — nothing to check
    }

    return connAccounts.map((ca) => getRepoId(workbook.version, workbookId, workbook.organizationId, ca.id));
  }

  @Get(':id/list')
  async listRepoFiles(
    @Param('id') workbookId: WorkbookId,
    @Query('branch') branch = 'main',
    @Query('folder') folder = '',
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<any[]> {
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
    return this.scratchGitService.listRepoFiles(repoId, branch, folder);
  }

  @Get(':id/file')
  async getRepoFile(
    @Param('id') workbookId: WorkbookId,
    @Query('branch') branch = 'main',
    @Query('path') path: string,
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<{ content: string } | null> {
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
    return this.scratchGitService.getRepoFile(repoId, branch, path);
  }

  @Get(':id/git-status')
  async getRepoStatus(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<unknown> {
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
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<HasDirtyFilesResponse> {
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
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<DirtyFileCountResponse> {
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
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<unknown> {
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
    return this.scratchGitService.getFileDiff(repoId, path);
  }

  @Get(':id/graph')
  async getGraph(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<unknown> {
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
    return this.scratchGitService.getGraph(repoId);
  }

  @Post(':id/rebase')
  async rebaseDirty(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<void> {
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
    return this.scratchGitService.rebaseDirty(repoId);
  }

  @Get(':id/object-counts')
  async getObjectCounts(
    @Param('id') workbookId: WorkbookId,
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<GitObjectCountsResponse> {
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
    return this.scratchGitService.getObjectCounts(repoId);
  }

  @Post(':id/gc')
  async runGitGc(
    @Param('id') workbookId: WorkbookId,
    @Body('aggressive') aggressive?: boolean,
    @Query('connectorAccountId') connectorAccountId?: string,
  ): Promise<GitGcResponse> {
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, connectorAccountId);
    return this.scratchGitService.runGitGc(repoId, aggressive);
  }

  @Post(':id/checkpoint')
  async createCheckpoint(@Param('id') workbookId: WorkbookId, @Body('name') name: string): Promise<void> {
    return this.scratchGitService.createCheckpoint(workbookId, name);
  }

  @Get(':id/checkpoints')
  async listCheckpoints(
    @Param('id') workbookId: WorkbookId,
  ): Promise<{ name: string; timestamp: number; message: string }[]> {
    return this.scratchGitService.listCheckpoints(workbookId);
  }

  @Post(':id/checkpoint/revert')
  async revertToCheckpoint(@Param('id') workbookId: WorkbookId, @Body('name') name: string): Promise<void> {
    return this.scratchGitService.revertToCheckpoint(workbookId, name);
  }

  @Delete(':id/checkpoint/:name')
  async deleteCheckpoint(@Param('id') workbookId: WorkbookId, @Param('name') name: string): Promise<void> {
    return this.scratchGitService.deleteCheckpoint(workbookId, name);
  }

  @Delete(':id/data-folder/files')
  async deleteAllFilesInDataFolder(
    @Param('id') workbookId: WorkbookId,
    @Query('path') folderPath: string,
  ): Promise<void> {
    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: folderPath },
      select: { connectorAccountId: true },
    });
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, dataFolder?.connectorAccountId ?? undefined);
    return this.scratchGitService.deleteAllFilesInDataFolder(repoId, folderPath);
  }

  @Post(':id/migrate-to-v2')
  async migrateToV2(@Param('id') workbookId: WorkbookId): Promise<{ success: boolean }> {
    await this.migrationService.migrateWorkbookToV2(workbookId);
    return { success: true };
  }
}
