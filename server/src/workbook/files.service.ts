import { Injectable, InternalServerErrorException, NotFoundException, NotImplementedException } from '@nestjs/common';
import type { DataFolderId, FileDiffStatus, FileRefEntity, WorkbookId } from '@spinner/shared-types';
import {
  FileDetailsResponseDto,
  ListFilesResponseDto,
  ValidatedCreateFileDto,
  ValidatedUpdateFileDto,
} from '@spinner/shared-types';
import { WorkbookCluster } from 'src/db/cluster-types';
import { PostHogService } from 'src/posthog/posthog.service';
import { DbService } from '../db/db.service';
import { DIRTY_BRANCH, MAIN_BRANCH, RepoFileRef, ScratchGitService } from '../scratch-git/scratch-git.service';
import { Actor } from '../users/types';
import { extractFilenameFromPath } from './util';
import { WorkbookEventService } from './workbook-event.service';

@Injectable()
export class FilesService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly posthogService: PostHogService,
    private readonly workbookEventService: WorkbookEventService,
  ) {}

  /**
   * Verify that the actor has access to the workbook and return it (with cluster include for tracking).
   */
  public async verifyWorkbookAccess(workbookId: WorkbookId, actor: Actor): Promise<WorkbookCluster.Workbook> {
    const workbook = await this.db.client.workbook.findFirst({
      where: {
        id: workbookId,
        organizationId: actor.organizationId,
      },
      include: WorkbookCluster._validator.include,
    });

    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }
    return workbook;
  }

  /**
   * Create a new file
   */
  async createFile(
    workbookId: WorkbookId,
    createFileDto: ValidatedCreateFileDto,
    actor: Actor,
  ): Promise<FileRefEntity> {
    const workbook = await this.verifyWorkbookAccess(workbookId, actor);

    const content = createFileDto.content ?? '';

    let parentPath = '';
    // Verify parent folder exists if specified
    if (createFileDto.parentFolderId) {
      // Check DataFolder. FilesService doesn't need DataFolderService for DB lookups.
      const dataFolder = await this.db.client.dataFolder.findUnique({
        where: { id: createFileDto.parentFolderId },
        select: { path: true, workbookId: true },
      });

      if (dataFolder) {
        if (dataFolder.workbookId !== workbookId) {
          throw new NotFoundException('Parent folder found but belongs to different workbook');
        }
        parentPath = dataFolder.path ?? ''; // DataFolder paths are usually set
      } else {
        throw new NotFoundException('Parent folder not found');
      }
    }

    const fullPath = (parentPath === '/' ? '' : parentPath) + '/' + createFileDto.name;

    await this.scratchGitService.commitFile(workbookId, fullPath, content, `Create file ${createFileDto.name}`);

    this.posthogService.trackRecordCreated(actor, workbook, fullPath);

    return {
      type: 'file',
      name: createFileDto.name,
      parentFolderId: createFileDto.parentFolderId ?? null,
      path: fullPath,
    };
  }

  async listByFolderId(workbookId: WorkbookId, folderId: DataFolderId, actor: Actor): Promise<ListFilesResponseDto> {
    await this.verifyWorkbookAccess(workbookId, actor);

    const folder = await this.db.client.dataFolder.findUnique({
      where: { id: folderId },
    });

    if (!folder) {
      throw new NotFoundException('Data folder not found');
    }

    if (!folder.path) {
      throw new InternalServerErrorException(`Path missing from DataFolder ${folderId}`);
    }

    const folderPath = folder.path.replace(/^\//, ''); // remove preceding / for git paths
    const repoFiles = (await this.scratchGitService.listRepoFiles(
      workbookId,
      DIRTY_BRANCH,
      folderPath,
    )) as RepoFileRef[];

    // TODO: this solution is too simplistic.
    // We need to do a more active diff between main and dirty to show pending deletes
    const diffs = await this.scratchGitService.getFolderDiff(workbookId, folderPath);

    const checkDirty = (path: string): boolean => {
      return diffs.some((d) => d.path === path);
    };

    const modifiedStatus = (path: string): FileDiffStatus | undefined => {
      return diffs.find((d) => d.path === path)?.status;
    };

    // Convert files to FileRefEntity
    const fileEntities: FileRefEntity[] = repoFiles.map((f) => ({
      type: 'file',
      name: f.name,
      parentFolderId: null,
      path: f.path,
      dirty: checkDirty(f.path),
      status: modifiedStatus(f.path),
    }));

    return { items: fileEntities };
  }

  /**
   * Get a single file by its path.
   * Used by the file agent's `cat` command.
   */
  async getFileByPathGit(workbookId: WorkbookId, path: string, actor: Actor): Promise<FileDetailsResponseDto> {
    await this.verifyWorkbookAccess(workbookId, actor);

    const mainResponse = await this.scratchGitService.getRepoFile(workbookId, MAIN_BRANCH, path);
    const dirtyResponse = await this.scratchGitService.getRepoFile(workbookId, DIRTY_BRANCH, path);

    // Check if file is dirty by comparing main and dirty branches
    const folderPath = path.substring(0, path.lastIndexOf('/')) || '.';
    const diffs = await this.scratchGitService.getFolderDiff(workbookId, folderPath);
    const fileDiff = diffs.find((d) => d.path === path);
    const isDirty = !!fileDiff;
    const status = fileDiff?.status;

    return {
      file: {
        ref: {
          type: 'file',
          name: extractFilenameFromPath(path),
          parentFolderId: null,
          path: path,
          dirty: isDirty,
          status: status,
        },
        content: dirtyResponse?.content ?? null,
        originalContent: mainResponse?.content ?? null,
        suggestedContent: null, // has no equivilent in the new world
        createdAt: '', // TODO - get this metadata from git?
        updatedAt: '', // TODO - get this metadata from git?
      },
    };
  }

  /**
   * Delete a file by path.
   * Used by the file agent's `rm` command.
   */
  async deleteFileByPathGit(workbookId: WorkbookId, path: string, actor: Actor): Promise<void> {
    const workbook = await this.verifyWorkbookAccess(workbookId, actor);

    const existingFile = await this.getFileByPathGit(workbookId, path, actor);

    if (!existingFile) {
      throw new NotFoundException(`Unable to find ${path}`);
    }
    await this.scratchGitService.deleteFile(workbookId, [path], `Delete ${path}`);

    // this.workbookEventService.sendWorkbookEvent(workbookId, {
    //   type: 'folder-contents-changed',
    //   data: { source: 'user', entityId: workbookId, message: 'File deleted', path: path },
    // });

    this.posthogService.trackRecordDeleted(actor, workbook, path);
  }

  /**
   * Update the content of the file by path.
   */
  async updateFileByPathGit(
    workbookId: WorkbookId,
    path: string,
    updateFileDto: ValidatedUpdateFileDto,
    actor: Actor,
  ): Promise<void> {
    const workbook = await this.verifyWorkbookAccess(workbookId, actor);

    if (updateFileDto.name) {
      throw new NotImplementedException('move and rename not supported yet');
    }

    if (updateFileDto.content !== undefined && updateFileDto.content !== null) {
      await this.scratchGitService.commitFile(workbookId, path, updateFileDto.content, `Update ${path}`);
      this.posthogService.trackRecordEdited(actor, workbook, path);
    }
  }
}
