import { Injectable } from '@nestjs/common';
import type { Service } from '@spinner/shared-types';
import { isScratchPendingPublishId } from '@spinner/shared-types';
import _ from 'lodash';
import { WSLogger } from '../logger';
import type { Connector } from '../remote-service/connectors/connector';
import type { BaseJsonTableSpec } from '../remote-service/connectors/types';
import { DIRTY_BRANCH, MAIN_BRANCH, ScratchGitService } from '../scratch-git/scratch-git.service';
import { formatJsonWithPrettier } from '../utils/json-formatter';
import { deduplicateFileName, resolveBaseFileName } from './util';

/**
 * Represents a file to be created (exists in dirty branch but not in main)
 */
export interface FileToCreate {
  path: string;
  content: Record<string, unknown>;
}

/**
 * Represents a file to be updated (exists in both branches but differs)
 */
export interface FileToUpdate {
  path: string;
  content: Record<string, unknown>;
  remoteId: string;
}

/**
 * Represents a file to be deleted (exists in main but not in dirty)
 */
export interface FileToDelete {
  path: string;
  remoteId: string;
}

/**
 * Result of analyzing a data folder for publishing
 */
export interface FilesToPublish {
  creates: FileToCreate[];
  updates: FileToUpdate[];
  deletes: FileToDelete[];
}

/**
 * Service responsible for publishing data folder files to remote services.
 * Uses scratch-git as the source of truth instead of the workbook database.
 *
 * Flow:
 * 1. Get folder diff (dirty vs main branch) to identify changes
 * 2. Process creates/updates/deletes through the connector
 * 3. Update git files with results (new IDs for creates, remove deletes)
 */
@Injectable()
export class DataFolderPublishingService {
  constructor(private readonly scratchGitService: ScratchGitService) {}

  /**
   * Analyzes a data folder to determine which files need to be published.
   * Uses git diff between dirty and main branches.
   *
   * @param repoId - The resolved repo ID to pass to scratch-git (V1: workbookId, V2: composite ID)
   * @param folderPath - The folder path within the repo (e.g., "/BLOG - Blog Posts Premium")
   * @param tableSpec - The table spec to extract ID field name
   */
  async getFilesToPublish(repoId: string, folderPath: string, tableSpec: BaseJsonTableSpec): Promise<FilesToPublish> {
    const result: FilesToPublish = {
      creates: [],
      updates: [],
      deletes: [],
    };

    // Get the diff for this folder (branch vs main)
    const diff = await this.scratchGitService.getFolderDiff(repoId, folderPath);

    WSLogger.debug({
      source: 'DataFolderPublishingService',
      message: 'Got folder diff',
      repoId,
      folderPath,
      diffCount: diff.length,
      diff: diff.map((d) => ({ path: d.path, status: d.status })),
    });

    const idField = tableSpec.idColumnRemoteId;

    // Discard dotfile diffs by syncing main's version to dirty
    const dotfileDiffs = diff.filter((f) => f.path.split('/').some((p) => p.startsWith('.')));
    if (dotfileDiffs.length > 0) {
      try {
        for (const dotfile of dotfileDiffs) {
          const mainFile = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, dotfile.path);
          if (mainFile) {
            await this.scratchGitService.commitFilesToBranch(
              repoId,
              DIRTY_BRANCH,
              [{ path: dotfile.path, content: mainFile.content }],
              `Sync ${dotfile.path} from main`,
            );
          }
        }
      } catch (e) {
        WSLogger.warn({
          source: 'DataFolderPublishingService',
          message: 'Failed to discard dotfile diffs',
          repoId,
          folderPath,
          error: e,
        });
      }
    }

    for (const file of diff) {
      // Only process JSON files, skip dotfiles (e.g. .schema.json)
      if (!file.path.endsWith('.json') || file.path.split('/').some((p) => p.startsWith('.'))) {
        continue;
      }

      if (file.status === 'added') {
        // New file - read from dirty branch
        const fileData = await this.scratchGitService.getRepoFile(repoId, DIRTY_BRANCH, file.path);
        if (fileData) {
          try {
            const content = JSON.parse(fileData.content) as Record<string, unknown>;
            result.creates.push({ path: file.path, content });
          } catch (e) {
            WSLogger.warn({
              source: 'DataFolderPublishingService',
              message: 'Failed to parse JSON file for create',
              path: file.path,
              error: e,
            });
          }
        }
      } else if (file.status === 'modified') {
        // Modified file - read from dirty branch, get ID from content
        const fileData = await this.scratchGitService.getRepoFile(repoId, DIRTY_BRANCH, file.path);
        if (fileData) {
          try {
            const content = JSON.parse(fileData.content) as Record<string, unknown>;
            const remoteId = content[idField] as string;
            if (remoteId) {
              result.updates.push({ path: file.path, content, remoteId });
            } else {
              WSLogger.warn({
                source: 'DataFolderPublishingService',
                message: 'Modified file has no remote ID, treating as create',
                path: file.path,
              });
              result.creates.push({ path: file.path, content });
            }
          } catch (e) {
            WSLogger.warn({
              source: 'DataFolderPublishingService',
              message: 'Failed to parse JSON file for update',
              path: file.path,
              error: e,
            });
          }
        }
      } else if (file.status === 'deleted') {
        // Deleted file - read from main branch to get the remote ID
        const fileData = await this.scratchGitService.getRepoFile(repoId, 'main', file.path);
        if (fileData) {
          try {
            const content = JSON.parse(fileData.content) as Record<string, unknown>;
            const remoteId = content[idField] as string;
            if (remoteId) {
              result.deletes.push({ path: file.path, remoteId });
            } else {
              WSLogger.warn({
                source: 'DataFolderPublishingService',
                message: 'Deleted file has no remote ID, skipping',
                path: file.path,
              });
            }
          } catch (e) {
            WSLogger.warn({
              source: 'DataFolderPublishingService',
              message: 'Failed to parse JSON file for delete',
              path: file.path,
              error: e,
            });
          }
        }
      }
    }

    WSLogger.info({
      source: 'DataFolderPublishingService',
      message: 'Files to publish',
      repoId,
      folderPath,
      creates: result.creates.length,
      updates: result.updates.length,
      deletes: result.deletes.length,
    });

    return result;
  }

  /**
   * Publish new files (creates) to the connector.
   * After successful creation, updates the JSON files with the new remote IDs
   * and renames them to use the remote ID as the filename.
   */
  async publishCreates<S extends Service>(
    repoId: string,
    connector: Connector<S>,
    tableSpec: BaseJsonTableSpec,
    files: FileToCreate[],
    onProgress: (count: number) => Promise<void>,
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }

    const batchSize = connector.getBatchSize('create');
    const idField = tableSpec.idColumnRemoteId;

    const usedFileNames = new Set<string>();

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      // Prepare files for the connector (ConnectorFile is Record<string, unknown>)
      // Strip temporary IDs - let the connector assign real IDs
      const connectorFiles = batch.map((file) => {
        const content = { ...file.content };
        if (isScratchPendingPublishId(content[idField])) {
          delete content[idField];
        }
        return content;
      });

      // Send to connector
      const returnedFiles = await connector.createRecords(tableSpec, connectorFiles);

      // Update files with the new remote IDs
      const filesToCommit: Array<{ path: string; content: string }> = [];
      const filesToDelete: string[] = [];

      for (let j = 0; j < returnedFiles.length; j++) {
        const returned = returnedFiles[j];
        const originalFile = batch[j];

        // Extract the id from the returned file
        const remoteId = returned[idField] || returned.id || returned._id;

        if (remoteId) {
          // Update the content with the new ID
          const updatedContent = { ...originalFile.content, ...returned };

          // Calculate new path: prefer slug, fall back to remoteId
          const remoteIdStr = typeof remoteId === 'string' ? remoteId : JSON.stringify(remoteId);
          const folder = originalFile.path.substring(0, originalFile.path.lastIndexOf('/'));
          const slugPath = tableSpec.slugFieldPath ?? tableSpec.slugColumnRemoteId;
          const slugValue = slugPath ? (_.get(updatedContent, slugPath) as string | undefined) : undefined;
          const baseName = resolveBaseFileName({ slugValue, idValue: remoteIdStr });
          const newFileName = deduplicateFileName(baseName, '.json', usedFileNames, remoteIdStr);
          const newPath = `${folder}/${newFileName}`;

          // Track if we need to delete the old file (rename scenario)
          if (originalFile.path !== newPath) {
            filesToDelete.push(originalFile.path);
          }

          filesToCommit.push({
            path: newPath,
            content: formatJsonWithPrettier(updatedContent),
          });

          WSLogger.debug({
            source: 'DataFolderPublishingService',
            message: 'Created record, updating file',
            originalPath: originalFile.path,
            newPath,
            remoteId: remoteIdStr,
            renamed: originalFile.path !== newPath,
          });
        }
      }

      // Delete old files first (if any need renaming)
      if (filesToDelete.length > 0) {
        WSLogger.info({
          source: 'DataFolderPublishingService',
          message: 'Deleting old files before rename',
          repoId,
          filesToDelete,
        });
        await this.scratchGitService.deleteFilesFromBranch(
          repoId,
          DIRTY_BRANCH,
          filesToDelete,
          `Renamed ${filesToDelete.length} files after publish`,
        );
      }

      // Commit new/updated files
      if (filesToCommit.length > 0) {
        WSLogger.info({
          source: 'DataFolderPublishingService',
          message: 'Committing new/renamed files',
          repoId,
          filesToCommit: filesToCommit.map((f) => f.path),
        });
        await this.scratchGitService.commitFilesToBranch(
          repoId,
          DIRTY_BRANCH,
          filesToCommit,
          `Published ${filesToCommit.length} new records`,
        );
      }

      await onProgress(batch.length);
    }
  }

  /**
   * Publish modified files (updates) to the connector.
   * The files are already updated in the dirty branch, we just need to send to connector.
   */
  async publishUpdates<S extends Service>(
    repoId: string,
    connector: Connector<S>,
    tableSpec: BaseJsonTableSpec,
    files: FileToUpdate[],
    onProgress: (count: number) => Promise<void>,
    // branch not needed for updates as we don't commit back
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }

    const batchSize = connector.getBatchSize('update');

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      // Prepare files for the connector (ConnectorFile is Record<string, unknown>)
      // The content should already have the id field set
      const connectorFiles = batch.map((file) => file.content);

      // Send to connector
      await connector.updateRecords(tableSpec, connectorFiles);

      WSLogger.debug({
        source: 'DataFolderPublishingService',
        message: 'Updated records',
        count: batch.length,
        paths: batch.map((f) => f.path),
      });

      await onProgress(batch.length);
    }
  }

  /**
   * Publish deleted files to the connector.
   * After successful deletion, the files are already gone from dirty branch
   * (that's how we detected them as deleted).
   */
  async publishDeletes<S extends Service>(
    repoId: string,
    connector: Connector<S>,
    tableSpec: BaseJsonTableSpec,
    files: FileToDelete[],
    onProgress: (count: number) => Promise<void>,
    // branch not needed
  ): Promise<void> {
    if (files.length === 0) {
      return;
    }

    const batchSize = connector.getBatchSize('delete');
    const idField = tableSpec.idColumnRemoteId;

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      // Prepare files for the connector (just need the id field)
      const connectorFiles = batch.map((file) => ({ [idField]: file.remoteId, id: file.remoteId }));

      // Send to connector
      await connector.deleteRecords(tableSpec, connectorFiles);

      WSLogger.debug({
        source: 'DataFolderPublishingService',
        message: 'Deleted records',
        count: batch.length,
        remoteIds: batch.map((f) => f.remoteId),
      });

      await onProgress(batch.length);
    }
  }

  /**
   * Convenience method to publish all changes in a data folder.
   * Processes creates, updates, and deletes in order.
   */
  async publishAll<S extends Service>(
    repoId: string,
    folderPath: string,
    connector: Connector<S>,
    tableSpec: BaseJsonTableSpec,
    onProgress: (phase: 'creates' | 'updates' | 'deletes', count: number) => Promise<void>,
  ): Promise<{
    creates: number;
    updates: number;
    deletes: number;
    createdPaths: string[];
    updatedPaths: string[];
    deletedPaths: string[];
  }> {
    // Get files to publish
    const filesToPublish = await this.getFilesToPublish(repoId, folderPath, tableSpec);

    // Publish creates
    await this.publishCreates(repoId, connector, tableSpec, filesToPublish.creates, (count) =>
      onProgress('creates', count),
    );

    // Publish updates
    await this.publishUpdates(repoId, connector, tableSpec, filesToPublish.updates, (count) =>
      onProgress('updates', count),
    );

    // Publish deletes
    await this.publishDeletes(repoId, connector, tableSpec, filesToPublish.deletes, (count) =>
      onProgress('deletes', count),
    );

    return {
      creates: filesToPublish.creates.length,
      updates: filesToPublish.updates.length,
      deletes: filesToPublish.deletes.length,
      createdPaths: filesToPublish.creates.map((f) => f.path),
      updatedPaths: filesToPublish.updates.map((f) => f.path),
      deletedPaths: filesToPublish.deletes.map((f) => f.path),
    };
  }
}
