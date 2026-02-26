import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  DirtyFileCountResponse,
  GitGcResponse,
  GitObjectCountsResponse,
  HasDirtyFilesResponse,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import { ScratchGitService } from './scratch-git.service';

@Controller('scratch-git')
@UseGuards(ScratchAuthGuard)
export class ScratchGitController {
  constructor(private readonly scratchGitService: ScratchGitService) {}

  @Get(':id/list')
  async listRepoFiles(
    @Param('id') workbookId: WorkbookId,
    @Query('branch') branch = 'main',
    @Query('folder') folder = '',
  ): Promise<any[]> {
    return this.scratchGitService.listRepoFiles(workbookId, branch, folder);
  }

  @Get(':id/file')
  async getRepoFile(
    @Param('id') workbookId: WorkbookId,
    @Query('branch') branch = 'main',
    @Query('path') path: string,
  ): Promise<{ content: string } | null> {
    return this.scratchGitService.getRepoFile(workbookId, branch, path);
  }
  @Get(':id/git-status')
  async getRepoStatus(@Param('id') workbookId: WorkbookId): Promise<unknown> {
    console.log(`[ScratchGitController] getRepoStatus called for ${workbookId}`);
    return this.scratchGitService.getRepoStatus(workbookId);
  }

  @Get(':id/git-has-dirty')
  async hasDirtyFiles(@Param('id') workbookId: WorkbookId): Promise<HasDirtyFilesResponse> {
    return this.scratchGitService.hasDirtyFiles(workbookId);
  }

  @Get(':id/git-status-count')
  async getRepoStatusCount(@Param('id') workbookId: WorkbookId): Promise<DirtyFileCountResponse> {
    return this.scratchGitService.getRepoStatusCount(workbookId);
  }

  @Get(':id/git-diff')
  async getFileDiff(@Param('id') workbookId: WorkbookId, @Query('path') path: string): Promise<unknown> {
    console.log(`[ScratchGitController] getFileDiff called for ${workbookId} path=${path}`);
    return this.scratchGitService.getFileDiff(workbookId, path);
  }

  @Get(':id/graph')
  async getGraph(@Param('id') workbookId: WorkbookId): Promise<unknown> {
    console.log(`[ScratchGitController] getGraph called for ${workbookId}`);
    return this.scratchGitService.getGraph(workbookId);
  }

  @Post(':id/rebase')
  async rebaseDirty(@Param('id') workbookId: WorkbookId): Promise<void> {
    console.log(`[ScratchGitController] rebaseDirty called for ${workbookId}`);
    return this.scratchGitService.rebaseDirty(workbookId);
  }

  @Get(':id/object-counts')
  async getObjectCounts(@Param('id') workbookId: WorkbookId): Promise<GitObjectCountsResponse> {
    return this.scratchGitService.getObjectCounts(workbookId);
  }

  @Post(':id/gc')
  async runGitGc(
    @Param('id') workbookId: WorkbookId,
    @Body('aggressive') aggressive?: boolean,
  ): Promise<GitGcResponse> {
    console.log(`[ScratchGitController] runGitGc called for ${workbookId} (aggressive: ${aggressive})`);
    return this.scratchGitService.runGitGc(workbookId, aggressive);
  }

  @Post(':id/checkpoint')
  async createCheckpoint(@Param('id') workbookId: WorkbookId, @Body('name') name: string): Promise<void> {
    console.log(`[ScratchGitController] createCheckpoint called for ${workbookId} name=${name}`);
    return this.scratchGitService.createCheckpoint(workbookId, name);
  }

  @Get(':id/checkpoints')
  async listCheckpoints(
    @Param('id') workbookId: WorkbookId,
  ): Promise<{ name: string; timestamp: number; message: string }[]> {
    console.log(`[ScratchGitController] listCheckpoints called for ${workbookId}`);
    return this.scratchGitService.listCheckpoints(workbookId);
  }

  @Post(':id/checkpoint/revert')
  async revertToCheckpoint(@Param('id') workbookId: WorkbookId, @Body('name') name: string): Promise<void> {
    console.log(`[ScratchGitController] revertToCheckpoint called for ${workbookId} name=${name}`);
    return this.scratchGitService.revertToCheckpoint(workbookId, name);
  }

  @Delete(':id/checkpoint/:name')
  async deleteCheckpoint(@Param('id') workbookId: WorkbookId, @Param('name') name: string): Promise<void> {
    console.log(`[ScratchGitController] deleteCheckpoint called for ${workbookId} name=${name}`);
    return this.scratchGitService.deleteCheckpoint(workbookId, name);
  }

  @Delete(':id/data-folder/files')
  async deleteAllFilesInDataFolder(
    @Param('id') workbookId: WorkbookId,
    @Query('path') folderPath: string,
  ): Promise<void> {
    console.log(`[ScratchGitController] deleteAllFilesInDataFolder called for ${workbookId} path=${folderPath}`);
    return this.scratchGitService.deleteAllFilesInDataFolder(workbookId, folderPath);
  }
}
