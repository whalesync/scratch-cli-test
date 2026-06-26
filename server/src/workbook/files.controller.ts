import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { DataFolderId, WorkbookId } from '@spinner/shared-types';
import {
  FileDetailsResponseDto,
  FileRefEntity,
  ListFilesResponseDto,
  ValidatedCreateFileDto,
} from '@spinner/shared-types';
import archiver from 'archiver';
import type { Response } from 'express';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { DbService } from '../db/db.service';
import { WSLogger } from '../logger';
import { ApiRateLimitGuard } from '../rate-limiter/api-rate-limit.guard';
import { DIRTY_BRANCH, ScratchGitService } from '../scratch-git/scratch-git.service';
import { userToActor } from '../users/types';
import { CreateFileDto, UpdateFileDto } from './dto/files.dto';
import { FilesService } from './files.service';
import { WorkbookService } from './workbook.service';

@Controller('workbooks/:workbookId/files')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly scratchGitService: ScratchGitService,
    private readonly db: DbService,
    private readonly workbookService: WorkbookService,
  ) {}

  /**
   * List files and folders at a given path (non-recursive, like `ls`).
   * GET /workbooks/:workbookId/files/list/by-path?path=/folder/path
   */
  @Get('list/by-folder')
  async listFilesByFolder(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('folderId') folderId: DataFolderId,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limitStr: string | undefined,
    @Req() req: RequestWithUser,
  ): Promise<ListFilesResponseDto> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    if (limit !== undefined && (isNaN(limit) || limit < 1)) {
      return await this.filesService.listByFolderId(workbookId, folderId, actor, { cursor });
    }
    return await this.filesService.listByFolderId(workbookId, folderId, actor, { cursor, limit });
  }

  /**
   * Resolve foreign key values in a file to their referenced file paths.
   * GET /workbooks/:workbookId/files/resolve-references?path=/folder/file.json&branch=main
   */
  @Get('resolve-references')
  async resolveReferences(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('path') path: string,
    @Query('branch') branch: string = DIRTY_BRANCH,
    @Req() req: RequestWithUser,
  ): Promise<{ references: Record<string, Record<string, string>> }> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);

    try {
      const references = await this.filesService.resolveReferences(workbookId, path, branch);
      return { references };
    } catch (e) {
      WSLogger.error({
        source: 'FilesController.resolveReferences',
        message: 'Failed to resolve references',
        path,
        branch,
        workbookId,
        error: e instanceof Error ? e.message : String(e),
      });
      return { references: {} };
    }
  }

  /**
   * Get a single file by its path.
   * GET /workbooks/:workbookId/files/by-path?path=/folder/file.md
   */
  @Get('by-path')
  async getFileByPath(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('path') path: string,
    @Req() req: RequestWithUser,
  ): Promise<FileDetailsResponseDto> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return await this.filesService.getFileByPathGit(workbookId, path, actor);
  }

  /**
   * Update a file by path.
   * PATCH /workbooks/:workbookId/files/by-path?path=/folder/file.md
   */
  @Patch('by-path')
  @HttpCode(204)
  async updateFileByPath(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('path') path: string,
    @Body() updateFileDto: UpdateFileDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    await this.filesService.updateFileByPathGit(workbookId, path, updateFileDto, actor);
  }

  /**
   * Delete a file by path (like `rm`).
   * DELETE /workbooks/:workbookId/files/by-path?path=/folder/file.md
   *
   * Delegates to the scratch-aware `FilesService.deleteFileByPathGit`, which resolves the repo via
   * `resolveRepoPathForFolder` and the branch via `workingBranchForConnector` — so a connector-less
   * scratch file (DEV-10424) is deleted from the per-workbook scratch repo on `main`, matching how
   * the GET (read) and PATCH (update) paths already resolve. (DEV-10584)
   */
  @Delete('by-path')
  @HttpCode(204)
  async deleteFileByPath(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('path') path: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    await this.filesService.deleteFileByPathGit(workbookId, path, actor);
  }

  /**
   * Create a new file
   * POST /workbooks/:workbookId/files
   */
  @Post()
  async createFile(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() createFileDto: CreateFileDto,
    @Req() req: RequestWithUser,
  ): Promise<FileRefEntity> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    const dto = createFileDto as ValidatedCreateFileDto;
    return this.filesService.createFile(workbookId, dto, actor);
  }

  /**
   * Download all files in a data folder as a ZIP archive.
   * GET /workbooks/:workbookId/files/download?folderId=...
   */
  @Get('download')
  async downloadFolder(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('folderId') folderId: DataFolderId,
    @Query('branch') branch: string = DIRTY_BRANCH,
    @Req() req: RequestWithUser,
    @Res() res: Response,
  ): Promise<void> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);

    const folder = await this.db.client.dataFolder.findUnique({ where: { id: folderId } });
    if (!folder || !folder.path) {
      throw new NotFoundException('Data folder not found');
    }

    const repoId = await this.scratchGitService.resolveConnectionRepoPath(folder.connectorAccountId);
    const folderPath = folder.path.replace(/^\//, '');
    const zipName = `${folder.name}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    archive.on('error', (err) => {
      WSLogger.error({
        source: 'FilesController.downloadFolder',
        message: 'Archive error',
        error: err,
        workbookId,
        folderId,
      });
      if (!res.headersSent) {
        throw new InternalServerErrorException('Failed to create archive');
      }
    });

    try {
      const PAGE_SIZE = 100;
      let cursor: string | undefined;
      do {
        const page = await this.scratchGitService.getRepoFilesPaginated(repoId, branch, folderPath, PAGE_SIZE, cursor);
        for (const file of page.files) {
          archive.append(file.content, { name: file.name });
        }
        cursor = page.nextCursor;
      } while (cursor);

      await archive.finalize();
    } catch (e) {
      WSLogger.error({
        source: 'FilesController.downloadFolder',
        message: 'Failed to download folder',
        error: e,
        workbookId,
        folderId,
      });
      archive.abort();
      if (!res.headersSent) {
        throw new InternalServerErrorException('Failed to download folder');
      }
    }
  }
}
