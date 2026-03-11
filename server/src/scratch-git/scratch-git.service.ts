import { BadRequestException, Injectable } from '@nestjs/common';
import {
  DirtyFileCountResponse,
  FileDiffStatus,
  GitObjectCountsResponse,
  HasDirtyFilesResponse,
  WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { ScratchGitClient } from './scratch-git.client';

// The object returned by listRepoFiles
export interface RepoFileRef {
  name: string;
  path: string;
  type: 'file' | 'folder';
}

export const MAIN_BRANCH = 'main';
export const DIRTY_BRANCH = 'dirty';
export const SCHEMA_JSON_FILENAME = '.schema.json';

export type RepoId = `${string}/${string}/${string}`;

/**
 * Returns the repo ID to pass to scratch-git for a given workbook connection.
 * Format: `{orgId}/{workbookId}/{connAccountId}`  →  `repos-v2/{orgId}/{workbookId}/{connAccountId}.git`
 */
export function getDefaultRepoPath(orgId: string, workbookId: WorkbookId, connAccountId: string): RepoId {
  return [orgId, workbookId, connAccountId].join('/') as RepoId;
}

@Injectable()
export class ScratchGitService {
  constructor(
    private readonly scratchGitClient: ScratchGitClient,
    private readonly db: DbService,
  ) {}

  /**
   * Resolves the repo ID for a workbook connection.
   * Returns the composite `{orgId}--{workbookId}--{connAccountId}` ID from the connector account's repoPath.
   * Throws if connectorAccountId is missing or has no repoPath.
   */
  async resolveRepoId(_workbookId: WorkbookId, connectorAccountId: string | undefined | null): Promise<RepoId> {
    if (!connectorAccountId) {
      throw new Error('No connector account ID provided');
    }
    const account = await this.db.client.connectorAccount.findUnique({ where: { id: connectorAccountId } });
    if (account?.repoPath) {
      return account.repoPath as RepoId;
    }
    throw new BadRequestException(`Connector account ${connectorAccountId} has no repoPath`);
  }

  async initRepo(repoId: string): Promise<void> {
    await this.scratchGitClient.initRepo(repoId);
  }

  async deleteRepo(repoId: string): Promise<void> {
    await this.scratchGitClient.deleteRepo(repoId);
  }

  async discardChanges(repoId: string, path?: string): Promise<void> {
    await this.scratchGitClient.resetRepo(repoId, path);
  }

  async rebaseDirty(repoId: string) {
    await this.scratchGitClient.rebaseDirty(repoId);
  }

  async runGitGc(repoId: string, aggressive?: boolean) {
    return this.scratchGitClient.gc(repoId, aggressive);
  }

  async getObjectCounts(repoId: string): Promise<GitObjectCountsResponse> {
    return this.scratchGitClient.getObjectCounts(repoId);
  }

  async commitFilesToBranch(
    repoId: string,
    branch: string,
    files: { path: string; content: string }[],
    message: string,
  ) {
    return this.commitFilesBatch(repoId, branch, files, message);
  }

  private async commitFilesBatch(
    repoId: string,
    branch: string,
    files: { path: string; content: string }[],
    message: string,
  ) {
    if (files.length === 0) return { created: [], updated: [], unchanged: [] };
    return this.scratchGitClient.commitFiles(repoId, branch, files, message);
  }

  async listRepoFiles(repoId: string, branch: string, folder: string): Promise<any[]> {
    return this.scratchGitClient.list(repoId, branch, folder);
  }

  async getRepoFile(repoId: string, branch: string, path: string): Promise<{ content: string } | null> {
    return this.scratchGitClient.getFile(repoId, branch, path);
  }

  async getRepoFilesPaginated(
    repoId: string,
    branch: string,
    folder: string,
    limit: number,
    cursor?: string,
  ): Promise<{ files: Array<{ name: string; content: string }>; nextCursor?: string }> {
    return this.scratchGitClient.readFilesPaginated(repoId, branch, folder, limit, cursor);
  }

  async readRepoFiles(
    repoId: string,
    branch: string,
    paths: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    return this.scratchGitClient.readFiles(repoId, branch, paths);
  }

  async readRepoFilesFromFolder(
    repoId: string,
    branch: string,
    folderPath: string,
    filenames: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    return this.scratchGitClient.readFilesFromFolder(repoId, branch, folderPath, filenames);
  }

  // Groups paths by their parent folder and calls readFilesFromFolder per group,
  // which uses a single optimized tree walk per folder instead of one per file.
  async readRepoFilesByFolder(
    repoId: string,
    branch: string,
    paths: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    if (paths.length === 0) return [];

    const byFolder = new Map<string, string[]>();
    for (const p of paths) {
      const normalized = p.startsWith('/') ? p.slice(1) : p;
      const folder = normalized.includes('/') ? normalized.substring(0, normalized.lastIndexOf('/')) : '';
      const filename = normalized.includes('/') ? normalized.substring(normalized.lastIndexOf('/') + 1) : normalized;
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(filename);
    }

    const groups = await Promise.all(
      Array.from(byFolder.entries()).map(([folder, filenames]) =>
        this.scratchGitClient.readFilesFromFolder(repoId, branch, folder, filenames),
      ),
    );

    return groups.flat();
  }

  async readBlobsByOid(repoId: string, oids: string[]): Promise<Array<{ oid: string; content: string | null }>> {
    return this.scratchGitClient.readBlobsByOid(repoId, oids);
  }

  async commitFile(repoId: string, path: string, content: string, message: string): Promise<void> {
    await this.scratchGitClient.commitFiles(repoId, 'dirty', [{ path, content }], message);
  }

  async deleteFile(repoId: string, paths: string[], message: string): Promise<void> {
    await this.deleteFilesFromBranch(repoId, DIRTY_BRANCH, paths, message);
  }

  async deleteFilesFromBranch(repoId: string, branch: string, paths: string[], message: string): Promise<void> {
    await this.scratchGitClient.deleteFiles(repoId, branch, paths, message);
  }

  async renameFiles(
    repoId: string,
    folderPath: string,
    renames: { oldName: string; newName: string }[],
    message: string,
  ): Promise<void> {
    await this.scratchGitClient.renameFiles(repoId, folderPath, renames, message);
  }

  async deleteFolder(repoId: string, folderPath: string, message: string, branch?: string): Promise<void> {
    await this.scratchGitClient.deleteFolder(repoId, folderPath, message, branch);
  }

  async deleteFolderFromAllBranches(repoId: string, folderPath: string, message: string): Promise<void> {
    // Delete from both main and dirty branches to avoid orphaned files in git status
    await this.scratchGitClient.deleteFolder(repoId, folderPath, message, MAIN_BRANCH);
    await this.scratchGitClient.deleteFolder(repoId, folderPath, message, DIRTY_BRANCH);
  }

  async removeDataFolder(repoId: string, folderPath: string): Promise<void> {
    await this.scratchGitClient.removeDataFolder(repoId, folderPath);
  }

  async publishFile(repoId: string, path: string, content: string, message: string): Promise<void> {
    await this.scratchGitClient.publishFile(repoId, { path, content }, message);
  }

  async getRepoStatus(repoId: string): Promise<any> {
    return this.scratchGitClient.getStatus(repoId);
  }

  async hasDirtyFiles(repoId: string): Promise<HasDirtyFilesResponse> {
    return this.scratchGitClient.hasDirtyFiles(repoId);
  }

  async getRepoStatusCount(repoId: string): Promise<DirtyFileCountResponse> {
    return this.scratchGitClient.getStatusCount(repoId);
  }

  async getFileDiff(repoId: string, path: string): Promise<any> {
    return this.scratchGitClient.getDiff(repoId, path);
  }

  async getFolderDiff(repoId: string, folderPath: string): Promise<Array<{ path: string; status: FileDiffStatus }>> {
    return this.scratchGitClient.getFolderDiff(repoId, folderPath);
  }

  async getGraph(repoId: string): Promise<any> {
    return this.scratchGitClient.getGraph(repoId);
  }

  async createCheckpoint(workbookId: WorkbookId, name: string): Promise<void> {
    await this.scratchGitClient.createCheckpoint(workbookId, name);
  }

  async listCheckpoints(workbookId: WorkbookId): Promise<{ name: string; timestamp: number; message: string }[]> {
    return this.scratchGitClient.listCheckpoints(workbookId);
  }

  async revertToCheckpoint(workbookId: WorkbookId, name: string): Promise<void> {
    await this.scratchGitClient.revertToCheckpoint(workbookId, name);
  }

  async deleteCheckpoint(workbookId: WorkbookId, name: string): Promise<void> {
    await this.scratchGitClient.deleteCheckpoint(workbookId, name);
  }

  async deleteAllFilesInDataFolder(repoId: string, folderPath: string): Promise<void> {
    // Delete the folder from dirty branch only to ensure a diff is generated
    await this.deleteFolder(repoId, folderPath, `Delete all records in ${folderPath}`, DIRTY_BRANCH);
  }

  /**
   * Writes a BaseJsonTableSpec as `.schema.json` into the git repo on both branches.
   * Commits to both main and dirty to keep them in sync without needing a rebase.
   * Non-throwing — failures are logged but do not block callers.
   */
  async writeSchemaToGit(repoId: string, folderPath: string, schema: BaseJsonTableSpec): Promise<void> {
    try {
      const gitPath = folderPath.replace(/^\//, '') + '/' + SCHEMA_JSON_FILENAME;
      const file = { path: gitPath, content: JSON.stringify(schema, null, 2) };
      const message = `Update ${SCHEMA_JSON_FILENAME} for ${folderPath}`;
      await this.commitFilesToBranch(repoId, MAIN_BRANCH, [file], message);
      await this.commitFilesToBranch(repoId, DIRTY_BRANCH, [file], message);
    } catch (error) {
      WSLogger.error({
        source: 'ScratchGitService.writeSchemaToGit',
        message: 'Failed to write .schema.json to git',
        repoId,
        folderPath,
        error,
      });
    }
  }

  /**
   * Reads `.schema.json` from the git repo on the main branch.
   * Returns the parsed BaseJsonTableSpec or null if missing/invalid.
   */
  async readSchemaFromGit(repoId: string, folderPath: string): Promise<BaseJsonTableSpec | null> {
    try {
      const gitPath = folderPath.replace(/^\//, '') + '/' + SCHEMA_JSON_FILENAME;
      const file = await this.getRepoFile(repoId, MAIN_BRANCH, gitPath);
      if (!file) return null;
      return JSON.parse(file.content) as BaseJsonTableSpec;
    } catch (error) {
      WSLogger.error({
        source: 'ScratchGitService.readSchemaFromGit',
        message: 'Failed to read .schema.json from git',
        repoId,
        folderPath,
        error,
      });
      return null;
    }
  }
}
