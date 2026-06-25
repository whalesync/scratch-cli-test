import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import type { DataFolderId, FileDiffStatus, FileRefEntity, WorkbookId } from '@spinner/shared-types';
import {
  FileDetailsResponseDto,
  ListFilesResponseDto,
  ValidatedCreateFileDto,
  ValidatedUpdateFileDto,
} from '@spinner/shared-types';
import { MigrationLockService } from 'src/migration-lock/migration-lock.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { DbService } from '../db/db.service';
import { FileIndexService } from '../publish-plan/file-index.service';
import { RefCleanerService } from '../publish-plan/ref-cleaner.service';
import { SchemaHelperService } from '../publish-plan/schema-helper.service';
import {
  DIRTY_BRANCH,
  MAIN_BRANCH,
  ScratchGitService,
  workingBranchForConnector,
} from '../scratch-git/scratch-git.service';
import { Actor } from '../users/types';
import {
  validateScratchFileSize,
  validateScratchRelativePath,
  validateScratchSegmentName,
} from './scratch-path-validation';
import { extractFilenameFromPath } from './util';
import { WorkbookEventService } from './workbook-event.service';
import { WorkbookService } from './workbook.service';

@Injectable()
export class FilesService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly posthogService: PostHogService,
    private readonly workbookEventService: WorkbookEventService,
    private readonly workbookService: WorkbookService,
    private readonly schemaHelperService: SchemaHelperService,
    private readonly refCleanerService: RefCleanerService,
    private readonly fileIndexService: FileIndexService,
    private readonly migrationLockService: MigrationLockService,
  ) {}

  /**
   * Create a new file
   */
  async createFile(
    workbookId: WorkbookId,
    createFileDto: ValidatedCreateFileDto,
    actor: Actor,
  ): Promise<FileRefEntity> {
    const workbook = await this.workbookService.findOneOrThrow(workbookId, actor);
    if (!workbook) {
      throw new NotFoundException('Workbook not found');
    }

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
    let parentConnectorAccountId: string | null | undefined;
    if (parentFolderId) {
      const parentFolder = await this.db.client.dataFolder.findUnique({
        where: { id: parentFolderId as string },
        select: { connectorAccountId: true },
      });
      parentConnectorAccountId = parentFolder?.connectorAccountId;
    }
    // T4: refuse a live edit while the connection is being migrated (a write racing
    // the folder move would orphan the record at the old path).
    await this.migrationLockService.assertConnectionNotMigrating(parentConnectorAccountId);

    if (!parentFolderId) {
      // Files must live in a folder; connector-less workbook-root files are not supported.
      throw new BadRequestException('A parent folder is required to create a file');
    }

    // Scratch (connector-less) files: validate the user-supplied name + size and commit straight to
    // `main` (no review ladder). Connector files keep the existing dirty-branch behavior.
    if (!parentConnectorAccountId) {
      // The name may be a nested relative path (e.g. "drafts/post.md") so files can be created inside
      // scratch subdirectories; git creates the intermediate dirs on commit.
      validateScratchRelativePath(createFileDto.name);
      validateScratchFileSize(content);
    }
    // Scratch writes init-if-absent so a file create self-heals even on a folder whose repo was never
    // created (idempotent); connector files resolve their existing repo as before.
    const repoId = parentConnectorAccountId
      ? await this.scratchGitService.resolveRepoPathForFolder(parentConnectorAccountId, workbookId)
      : await this.scratchGitService.ensureScratchRepo(workbookId);
    const branch = workingBranchForConnector(parentConnectorAccountId);

    // Don't silently overwrite an existing scratch file. A new file is created with empty content, so
    // a duplicate name would blank the file — data loss. (Mirrors createScratchFolder's collision
    // check; connector creates keep their existing behavior.)
    if (!parentConnectorAccountId) {
      const existing = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, fullPath);
      if (existing) {
        throw new BadRequestException(`A file named "${createFileDto.name}" already exists`);
      }
    }

    await this.scratchGitService.commitFile(repoId, fullPath, content, `Create file ${createFileDto.name}`, branch);

    this.posthogService.trackRecordCreated(actor, workbook, fullPath);

    return {
      type: 'file',
      name: createFileDto.name,
      parentFolderId: createFileDto.parentFolderId ?? null,
      path: fullPath,
    };
  }

  async listByFolderId(
    workbookId: WorkbookId,
    folderId: DataFolderId,
    actor: Actor,
    options?: { cursor?: string; limit?: number },
  ): Promise<ListFilesResponseDto> {
    await this.workbookService.findOneOrThrow(workbookId, actor);

    const folder = await this.db.client.dataFolder.findUnique({
      where: { id: folderId },
    });

    if (!folder) {
      throw new NotFoundException('Data folder not found');
    }

    if (!folder.path) {
      throw new InternalServerErrorException(`Path missing from DataFolder ${folderId}`);
    }

    const isScratch = !folder.connectorAccountId;
    const repoId = await this.scratchGitService.resolveRepoPathForFolder(folder.connectorAccountId, workbookId);
    const folderPath = folder.path.replace(/^\//, ''); // remove preceding / for git paths
    const branch = workingBranchForConnector(folder.connectorAccountId);

    // Paginate at the git level — sorting, cursor, and limit are handled by scratch-git
    const limit = options?.limit ?? 200;
    const page = await this.scratchGitService.listRepoFilesPaginated(
      repoId,
      branch,
      folderPath,
      limit,
      options?.cursor,
    );

    // Scratch folders are main-only and have no pending state, so the dirty-vs-main diff is always
    // empty. Connector folders compute the diff to surface pending deletes/edits.
    // TODO: this connector diff is too simplistic — needs a fuller main↔dirty diff for pending deletes.
    const diffMap = new Map<string, FileDiffStatus>();
    let dirtyCount = 0;
    if (!isScratch) {
      const diffs = await this.scratchGitService.getFolderDiff(repoId, folderPath);
      for (const d of diffs) {
        diffMap.set(d.path, d.status);
      }
      dirtyCount = diffs.length;
    }

    const fileEntities: FileRefEntity[] = page.files.map((f) => ({
      type: 'file',
      name: f.name,
      parentFolderId: null,
      path: f.path,
      dirty: diffMap.has(f.path),
      status: diffMap.get(f.path),
    }));

    return { items: fileEntities, nextCursor: page.nextCursor, dirtyCount };
  }

  /**
   * Get a single file by its path.
   * Used by the file agent's `cat` command.
   */
  async getFileByPathGit(workbookId: WorkbookId, path: string, actor: Actor): Promise<FileDetailsResponseDto> {
    await this.workbookService.findOneOrThrow(workbookId, actor);

    // Resolve the correct repo ID for this file's folder
    const folderPath = path.substring(0, path.lastIndexOf('/')) || '.';
    const gitFolderPath = folderPath === '.' ? '' : folderPath.replace(/^\//, '');
    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: `/${gitFolderPath}` },
      select: { connectorAccountId: true },
    });
    const isScratch = !dataFolder?.connectorAccountId;
    const repoId = await this.scratchGitService.resolveRepoPathForFolder(dataFolder?.connectorAccountId, workbookId);

    const mainResponse = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, path);

    // Scratch repos are main-only with no review ladder: a file is never "dirty" and there is no
    // separate working copy. Connector files read the dirty working copy and diff it against main.
    let workingContent = mainResponse?.content ?? null;
    let isDirty = false;
    let status: FileDiffStatus | undefined;
    if (!isScratch) {
      const dirtyResponse = await this.scratchGitService.getRepoFile(repoId, DIRTY_BRANCH, path);
      workingContent = dirtyResponse?.content ?? null;
      const diffs = await this.scratchGitService.getFolderDiff(repoId, gitFolderPath || '.');
      const fileDiff = diffs.find((d) => d.path === path);
      isDirty = !!fileDiff;
      status = fileDiff?.status;
    }

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
        content: workingContent,
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
    const workbook = await this.workbookService.findOneOrThrow(workbookId, actor);

    const existingFile = await this.getFileByPathGit(workbookId, path, actor);

    if (!existingFile) {
      throw new NotFoundException(`Unable to find ${path}`);
    }

    const folderPathRaw = path.substring(0, path.lastIndexOf('/'));
    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: folderPathRaw || '/' },
      select: { connectorAccountId: true },
    });
    // T4: refuse a live edit while the connection is being migrated.
    await this.migrationLockService.assertConnectionNotMigrating(dataFolder?.connectorAccountId);
    const repoId = await this.scratchGitService.resolveRepoPathForFolder(dataFolder?.connectorAccountId, workbookId);
    const branch = workingBranchForConnector(dataFolder?.connectorAccountId);
    await this.scratchGitService.deleteFile(repoId, [path], `Delete ${path}`, branch);

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
    const workbook = await this.workbookService.findOneOrThrow(workbookId, actor);

    const folderPathRaw = path.substring(0, path.lastIndexOf('/'));
    const folderPath = folderPathRaw ? (folderPathRaw.startsWith('/') ? folderPathRaw : `/${folderPathRaw}`) : '/';
    const dataFolder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, path: folderPath },
      select: { connectorAccountId: true },
    });
    // T4: refuse a live edit while the connection is being migrated.
    await this.migrationLockService.assertConnectionNotMigrating(dataFolder?.connectorAccountId);
    const repoId = await this.scratchGitService.resolveRepoPathForFolder(dataFolder?.connectorAccountId, workbookId);
    const branch = workingBranchForConnector(dataFolder?.connectorAccountId);

    if (updateFileDto.name) {
      const newPath = path.substring(0, path.lastIndexOf('/')) + '/' + updateFileDto.name;
      await this.renameFileGit(workbookId, path, newPath, actor);
      // We don't support content update at the same time as rename in this simplified version,
      // though we could. Assuming rename is a standalone operation for now.
    } else if (updateFileDto.content !== undefined && updateFileDto.content !== null) {
      // Scratch (connector-less) files commit straight to main; enforce the per-file size cap.
      if (!dataFolder?.connectorAccountId) {
        validateScratchFileSize(updateFileDto.content);
      }
      await this.scratchGitService.commitFile(repoId, path, updateFileDto.content, `Update ${path}`, branch);
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

    const repoId = await this.scratchGitService.resolveRepoPathForFolder(dataFolder?.connectorAccountId, workbookId);

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
        select: { path: true, connectorAccountId: true },
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

      // Resolve via SQLite index in the Rust git service (no PostgreSQL FileIndex needed)
      const targetFolderForIndex = targetFolder.path.replace(/^\//, '');
      const targetRepoId = await this.scratchGitService.resolveRepoPathForFolder(
        targetFolder.connectorAccountId,
        workbookId,
      );
      const filenameMap = await this.scratchGitService.lookupByRemoteIds(targetRepoId, targetFolderForIndex, remoteIds);

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
    await this.workbookService.findOneOrThrow(workbookId, actor);

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
    const repoId = await this.scratchGitService.resolveRepoPathForFolder(dataFolder?.connectorAccountId, workbookId);

    if (!dataFolder?.connectorAccountId) {
      // Scratch repos are main-only and the Rust rename targets the dirty working tree, so move the
      // file directly on `main`: write the new path, delete the old. Connector-less files have no
      // FileIndex/FileReference rows, so there is nothing to rewrite afterwards.
      validateScratchSegmentName(newFilename);
      const fileOnMain = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, oldPath);
      if (!fileOnMain) {
        throw new NotFoundException(`Unable to find ${oldPath}`);
      }
      // Don't silently overwrite a different file already at the destination path.
      if (newPath !== oldPath) {
        const existingAtNewPath = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, newPath);
        if (existingAtNewPath) {
          throw new BadRequestException(`A file named "${newFilename}" already exists`);
        }
      }
      await this.scratchGitService.commitFile(
        repoId,
        newPath,
        fileOnMain.content,
        `Rename ${oldPath} to ${newPath}`,
        MAIN_BRANCH,
      );
      await this.scratchGitService.deleteFile(repoId, [oldPath], `Rename ${oldPath} to ${newPath}`, MAIN_BRANCH);
      return;
    }

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
