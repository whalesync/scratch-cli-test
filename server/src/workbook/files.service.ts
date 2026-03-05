import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
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
import { FileIndexService } from '../publish-plan/file-index.service';
import { RefCleanerService } from '../publish-plan/ref-cleaner.service';
import { SchemaHelperService } from '../publish-plan/schema-helper.service';
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
    private readonly schemaHelperService: SchemaHelperService,
    private readonly refCleanerService: RefCleanerService,
    private readonly fileIndexService: FileIndexService,
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

    const parentFolderId = createFileDto.parentFolderId;
    const repoId = parentFolderId
      ? await this.db.client.dataFolder
          .findUnique({ where: { id: parentFolderId as string }, select: { connectorAccountId: true } })
          .then((df) => this.scratchGitService.resolveRepoId(workbookId, df?.connectorAccountId ?? undefined))
      : await this.scratchGitService.resolveRepoId(workbookId);

    await this.scratchGitService.commitFile(repoId, fullPath, content, `Create file ${createFileDto.name}`);

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

    const repoId = await this.scratchGitService.resolveRepoId(workbookId, folder.connectorAccountId ?? undefined);
    const folderPath = folder.path.replace(/^\//, ''); // remove preceding / for git paths
    const repoFiles = (await this.scratchGitService.listRepoFiles(repoId, DIRTY_BRANCH, folderPath)) as RepoFileRef[];

    // TODO: this solution is too simplistic.
    // We need to do a more active diff between main and dirty to show pending deletes
    const diffs = await this.scratchGitService.getFolderDiff(repoId, folderPath);

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

    // Resolve the correct repo ID for this file's folder
    const folderPath = path.substring(0, path.lastIndexOf('/')) || '.';
    const gitFolderPath = folderPath === '.' ? '' : folderPath.replace(/^\//, '');
    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: `/${gitFolderPath}` },
      select: { connectorAccountId: true },
    });
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, dataFolder?.connectorAccountId ?? undefined);

    const mainResponse = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, path);
    const dirtyResponse = await this.scratchGitService.getRepoFile(repoId, DIRTY_BRANCH, path);

    // Check if file is dirty by comparing main and dirty branches
    const diffs = await this.scratchGitService.getFolderDiff(repoId, gitFolderPath || '.');
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

    const folderPathRaw = path.substring(0, path.lastIndexOf('/'));
    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: folderPathRaw || '/' },
      select: { connectorAccountId: true },
    });
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, dataFolder?.connectorAccountId ?? undefined);
    await this.scratchGitService.deleteFile(repoId, [path], `Delete ${path}`);

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

    const folderPathRaw = path.substring(0, path.lastIndexOf('/'));
    const folderPath = folderPathRaw ? (folderPathRaw.startsWith('/') ? folderPathRaw : `/${folderPathRaw}`) : '/';
    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: folderPath },
      select: { connectorAccountId: true },
    });
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, dataFolder?.connectorAccountId ?? undefined);

    if (updateFileDto.name) {
      const newPath = path.substring(0, path.lastIndexOf('/')) + '/' + updateFileDto.name;
      await this.renameFileGit(workbookId, path, newPath, actor);
      // We don't support content update at the same time as rename in this simplified version,
      // though we could. Assuming rename is a standalone operation for now.
    } else if (updateFileDto.content !== undefined && updateFileDto.content !== null) {
      await this.scratchGitService.commitFile(repoId, path, updateFileDto.content, `Update ${path}`);
      this.posthogService.trackRecordEdited(actor, workbook, path);
    }
  }

  /**
   * Resolve foreign key values in a file to their referenced file paths.
   * Reads the file from the specified branch, identifies FK fields via the folder's schema,
   * and resolves each FK value (remote ID) to the full file path of the referenced record.
   */
  async resolveReferences(
    workbookId: WorkbookId,
    path: string,
    branch: string,
  ): Promise<Record<string, Record<string, string>>> {
    // 1. Resolve repo and read file content from the specified branch
    const folderPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const normalizedFolderPath = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;

    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: normalizedFolderPath },
      select: { connectorAccountId: true, path: true },
    });

    const repoId = await this.scratchGitService.resolveRepoId(workbookId, dataFolder?.connectorAccountId ?? undefined);

    const fileResponse = await this.scratchGitService.getRepoFile(repoId, branch, path);
    if (!fileResponse) {
      return {};
    }

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(fileResponse.content) as Record<string, unknown>;
    } catch {
      return {};
    }

    // 2. Read schema and extract FK field paths
    const spec = await this.schemaHelperService.getTableSpec(workbookId, normalizedFolderPath);
    if (!spec?.schema) {
      return {};
    }

    const fkPaths = this.refCleanerService.extractForeignKeyPaths(spec.schema);
    if (fkPaths.length === 0) {
      return {};
    }

    // 3. For each FK field, collect remote IDs and resolve to file paths
    const result: Record<string, Record<string, string>> = {};

    for (const fk of fkPaths) {
      // Find the target DataFolder by matching linkedTableId against tableId array
      const targetFolder = await this.db.client.dataFolder.findFirst({
        where: {
          workbookId,
          tableId: { has: fk.targetRemoteTableId },
        },
        select: { path: true },
      });

      if (!targetFolder?.path) {
        continue;
      }

      // Extract FK values from the file content
      const nodes = this.getNodesByPath(content, fk.path);
      const remoteIds: string[] = [];
      for (const node of nodes) {
        if (Array.isArray(node)) {
          for (const item of node) {
            if (typeof item === 'string' && !item.startsWith('@/')) {
              remoteIds.push(item);
            }
          }
        } else if (typeof node === 'string' && !node.startsWith('@/')) {
          remoteIds.push(node);
        }
      }

      if (remoteIds.length === 0) {
        continue;
      }

      // Cap at 500 to avoid expensive lookups on very large files
      if (remoteIds.length > 500) {
        remoteIds.length = 500;
      }

      // FileIndex uses folderPath without leading slash
      const targetFolderPathForIndex = targetFolder.path.replace(/^\//, '');

      const filenameMap = await this.fileIndexService.getFilenamesByRecordIds(
        workbookId,
        targetFolderPathForIndex,
        remoteIds,
      );

      // Build the field key from the FK path (e.g., ["fieldData", "sectors"] -> "sectors")
      const fieldKey = fk.path.filter((p) => p !== '[]').join('.');
      const resolved: Record<string, string> = {};

      for (const remoteId of remoteIds) {
        const filename = filenameMap.get(remoteId);
        if (filename) {
          resolved[remoteId] = `${targetFolder.path}/${filename}`;
        }
      }

      if (Object.keys(resolved).length > 0) {
        result[fieldKey] = resolved;
      }
    }

    return result;
  }

  /**
   * Get values at a given path in a content object.
   * Handles '[]' segments by iterating arrays.
   */
  private getNodesByPath(root: unknown, path: string[]): unknown[] {
    if (!root) return [];
    if (path.length === 0) return [root];

    let current: unknown[] = [root];

    for (const segment of path) {
      const next: unknown[] = [];
      for (const node of current) {
        if (!node || typeof node !== 'object') continue;

        if (segment === '[]') {
          if (Array.isArray(node)) {
            next.push(...(node as unknown[]));
          }
        } else {
          const value = (node as Record<string, unknown>)[segment];
          if (value !== undefined) {
            next.push(value);
          }
        }
      }
      current = next;
    }

    return current;
  }

  async renameFileGit(workbookId: WorkbookId, oldPath: string, newPath: string, actor: Actor): Promise<void> {
    await this.verifyWorkbookAccess(workbookId, actor);

    const existingFile = await this.getFileByPathGit(workbookId, oldPath, actor);

    if (!existingFile) {
      throw new NotFoundException(`Unable to find ${oldPath}`);
    }

    const oldFilename = extractFilenameFromPath(oldPath);
    const newFilename = extractFilenameFromPath(newPath);
    const folderPathRaw = oldPath.substring(0, oldPath.lastIndexOf('/'));
    const folderPath = folderPathRaw ? (folderPathRaw.startsWith('/') ? folderPathRaw : `/${folderPathRaw}`) : '/';

    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: folderPath },
      select: { connectorAccountId: true },
    });
    const repoId = await this.scratchGitService.resolveRepoId(workbookId, dataFolder?.connectorAccountId ?? undefined);

    try {
      await this.scratchGitService.renameFiles(
        repoId,
        folderPath,
        [{ oldName: oldFilename, newName: newFilename }],
        `Rename ${oldPath} to ${newPath}`,
      );
    } catch (e) {
      throw new InternalServerErrorException(
        `Failed to rename file in git: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // FileIndex uses paths without leading slash
    const folderPathWithoutPrefix = folderPath.replace(/^\//, '');

    // 1. Update FileIndex
    await this.db.client.fileIndex.updateMany({
      where: {
        workbookId,
        folderPath: folderPathWithoutPrefix,
        filename: oldFilename,
      },
      data: {
        filename: newFilename,
      },
    });

    // 2. Update FileReference outbound references
    await this.db.client.fileReference.updateMany({
      where: {
        workbookId,
        sourceFilePath: oldPath,
      },
      data: {
        sourceFilePath: newPath,
      },
    });

    // this.posthogService.trackRecordRenamed(actor, workbook, oldPath, newPath); // Example if tracking existed
  }
}
