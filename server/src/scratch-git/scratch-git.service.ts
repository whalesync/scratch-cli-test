import { BadRequestException, Injectable } from '@nestjs/common';
import {
  DirtyFileCountResponse,
  FileDiffStatus,
  GitObjectCountsResponse,
  HasDirtyFilesResponse,
  TableView,
  WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { GitIndexDump, RepoFileRef, ScratchGitClient } from './scratch-git.client';

export type { RepoFileRef };

export const MAIN_BRANCH = 'main';
export const DIRTY_BRANCH = 'dirty';
export const SCHEMA_JSON_FILENAME = '.schema.json';
export const SCRATCH_DIR = '.scratch';
export const SCHEMA_FILENAME = 'schema.json';

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
  async resolveConnectionRepoPath(connectorAccountId?: string | null): Promise<RepoId> {
    if (!connectorAccountId) {
      throw new BadRequestException('Connector account ID is required');
    }
    const account = await this.db.client.connectorAccount.findUnique({ where: { id: connectorAccountId } });
    if (!account?.repoPath) {
      throw new BadRequestException(`Connector account ${connectorAccountId} has no repoPath`);
    }
    return account.repoPath as RepoId;
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

  async buildIndex(repoId: string): Promise<{ count: number }> {
    return this.scratchGitClient.buildIndex(repoId);
  }

  async dumpIndex(repoId: string): Promise<GitIndexDump> {
    return this.scratchGitClient.dumpIndex(repoId);
  }

  async lookupByRemoteIds(repoId: string, folder: string, remoteIds: string[]): Promise<Map<string, string>> {
    const result = await this.scratchGitClient.lookupByRemoteIds(repoId, folder, remoteIds);
    return new Map(Object.entries(result));
  }

  async lookupFilenamesByFolder(repoId: string, folder: string, filenames: string[]): Promise<Map<string, string>> {
    const result = await this.scratchGitClient.lookupFilenamesByFolder(repoId, folder, filenames);
    return new Map(Object.entries(result));
  }

  async upsertIndexEntries(
    repoId: string,
    entries: { folder: string; filename: string; remoteId: string | null }[],
  ): Promise<void> {
    await this.scratchGitClient.upsertIndexEntries(repoId, entries);
  }

  async deleteIndexEntries(repoId: string, entries: { folder: string; filename: string }[]): Promise<void> {
    await this.scratchGitClient.deleteIndexEntries(repoId, entries);
  }

  async commitFilesToBranch(
    repoId: string,
    branch: string,
    files: { path: string; content: string }[],
    message: string,
  ) {
    return this.commitFilesBatch(repoId, branch, files, message);
  }

  /**
   * Commits files to a branch, automatically chunking into smaller batches
   * to stay under scratch-git's 50MB request body limit.
   */
  private async commitFilesBatch(
    repoId: string,
    branch: string,
    files: { path: string; content: string }[],
    message: string,
  ) {
    if (files.length === 0) return { created: [], updated: [], unchanged: [] };

    const chunks = this.chunkFilesBySize(files);
    const result = { created: [] as string[], updated: [] as string[], unchanged: [] as string[] };

    for (let i = 0; i < chunks.length; i++) {
      const chunkMessage = chunks.length > 1 ? `${message} (${i + 1}/${chunks.length})` : message;
      const chunkResult = await this.scratchGitClient.commitFiles(repoId, branch, chunks[i], chunkMessage);
      result.created.push(...chunkResult.created);
      result.updated.push(...chunkResult.updated);
      result.unchanged.push(...chunkResult.unchanged);
    }

    return result;
  }

  /**
   * Splits files into chunks where each chunk's estimated JSON payload
   * stays under the target size (default 40MB, well under scratch-git's 50MB limit).
   */
  private chunkFilesBySize(
    files: { path: string; content: string }[],
    maxBytesPerChunk = 40 * 1024 * 1024,
  ): { path: string; content: string }[][] {
    const chunks: { path: string; content: string }[][] = [];
    let currentChunk: { path: string; content: string }[] = [];
    let currentSize = 0;

    for (const file of files) {
      // Estimate the JSON size of this file entry: {"path":"...","content":"..."} + overhead
      const entrySize = file.path.length + file.content.length + 40;

      if (currentChunk.length > 0 && currentSize + entrySize > maxBytesPerChunk) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }

      currentChunk.push(file);
      currentSize += entrySize;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  async listRepoFiles(repoId: string, branch: string, folder: string): Promise<RepoFileRef[]> {
    return this.scratchGitClient.list(repoId, branch, folder);
  }

  async getRepoFile(repoId: string, branch: string, path: string): Promise<{ content: string } | null> {
    return this.scratchGitClient.getFile(repoId, branch, path);
  }

  async listRepoFilesPaginated(
    repoId: string,
    branch: string,
    folder: string,
    limit: number,
    cursor?: string,
  ): Promise<{ files: Array<{ name: string; path: string }>; nextCursor?: string }> {
    return this.scratchGitClient.listFilesPaginated(repoId, branch, folder, limit, cursor);
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

  async getRepoStatus(repoId: string): Promise<Array<{ path: string; status: FileDiffStatus }>> {
    return this.scratchGitClient.getStatus(repoId);
  }

  async hasDirtyFiles(repoId: string): Promise<HasDirtyFilesResponse> {
    return this.scratchGitClient.hasDirtyFiles(repoId);
  }

  async getRepoStatusCount(repoId: string): Promise<DirtyFileCountResponse> {
    return this.scratchGitClient.getStatusCount(repoId);
  }

  async getFileDiff(repoId: string, path: string): Promise<string> {
    return this.scratchGitClient.getDiff(repoId, path);
  }

  async getFolderDiff(repoId: string, folderPath: string): Promise<Array<{ path: string; status: FileDiffStatus }>> {
    return this.scratchGitClient.getFolderDiff(repoId, folderPath);
  }

  async getGraph(repoId: string): Promise<unknown> {
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
   * Writes a BaseJsonTableSpec as `schema.json` into `.scratch/{folderPath}/` on both branches.
   * If a legacy `.schema.json` exists in the old location it is deleted in the same operation.
   * Commits to both main and dirty to keep them in sync without needing a rebase.
   * Non-throwing — failures are logged but do not block callers.
   */
  async writeSchemaToGit(repoId: string, folderPath: string, schema: BaseJsonTableSpec): Promise<void> {
    try {
      const normalizedFolder = folderPath.replace(/^\//, '');
      const newGitPath = `${SCRATCH_DIR}/${normalizedFolder}/${SCHEMA_FILENAME}`;
      // Strip defaultView from the serialized schema — it belongs in views/default.json
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { defaultView, ...schemaWithoutView } = schema;
      const file = { path: newGitPath, content: JSON.stringify(schemaWithoutView, null, 2) };
      const message = `Update schema for ${folderPath}`;

      const legacyGitPath = `${normalizedFolder}/${SCHEMA_JSON_FILENAME}`;

      // TODO: Only write to MAIN_BRANCH, not DIRTY_BRANCH. Nothing reads schemas from dirty
      // (readSchemaFromGit and the index route both read from main). Writing to dirty is unnecessary
      // and was the original cause of a bug where "Changes to approve" showed with no actual file
      // differences — the schema's generatedAt timestamp created a .scratch/ diff between merge_base
      // and dirty. The has_dirty endpoint now filters dotfiles (has_visible_tree_changes in
      // scratch-git-2/src/service/git/repo.rs) so this is no longer user-visible, but the extra
      // writes are still wasted work.
      for (const branch of [MAIN_BRANCH, DIRTY_BRANCH]) {
        await this.commitFilesToBranch(repoId, branch, [file], message);
        // Clean up the legacy .schema.json if it still exists on this branch
        const legacy = await this.getRepoFile(repoId, branch, legacyGitPath);
        if (legacy) {
          await this.deleteFilesFromBranch(repoId, branch, [legacyGitPath], `Remove legacy schema for ${folderPath}`);
        }
      }
    } catch (error) {
      WSLogger.error({
        source: 'ScratchGitService.writeSchemaToGit',
        message: 'Failed to write schema to git',
        repoId,
        folderPath,
        error,
      });
    }
  }

  /**
   * Writes a TableView as `views/{viewName}.json` into `.scratch/{folderPath}/` on both branches.
   * Non-throwing — failures are logged but do not block callers.
   */
  async writeViewToGit(repoId: string, folderPath: string, viewName: string, view: TableView): Promise<void> {
    try {
      const normalizedFolder = folderPath.replace(/^\//, '');
      const gitPath = `${SCRATCH_DIR}/${normalizedFolder}/views/${viewName}.json`;
      const file = { path: gitPath, content: JSON.stringify(view, null, 2) };
      const message = `Update ${viewName} view for ${folderPath}`;

      for (const branch of [MAIN_BRANCH, DIRTY_BRANCH]) {
        await this.commitFilesToBranch(repoId, branch, [file], message);
      }
    } catch (error) {
      WSLogger.error({
        source: 'ScratchGitService.writeViewToGit',
        message: 'Failed to write view to git',
        repoId,
        folderPath,
        viewName,
        error,
      });
    }
  }

  /**
   * Reads `schema.json` from `.scratch/{folderPath}/` on the main branch.
   * Falls back to the legacy `.schema.json` location for repos that have not yet migrated.
   * Returns the parsed BaseJsonTableSpec or null if missing/invalid.
   */
  async readSchemaFromGit(repoId: string, folderPath: string): Promise<BaseJsonTableSpec | null> {
    try {
      const normalizedFolder = folderPath.replace(/^\//, '');
      const newGitPath = `${SCRATCH_DIR}/${normalizedFolder}/${SCHEMA_FILENAME}`;
      const legacyGitPath = `${normalizedFolder}/${SCHEMA_JSON_FILENAME}`;

      const file =
        (await this.getRepoFile(repoId, MAIN_BRANCH, newGitPath)) ??
        (await this.getRepoFile(repoId, MAIN_BRANCH, legacyGitPath));
      if (!file) return null;
      return JSON.parse(file.content) as BaseJsonTableSpec;
    } catch (error) {
      WSLogger.error({
        source: 'ScratchGitService.readSchemaFromGit',
        message: 'Failed to read schema from git',
        repoId,
        folderPath,
        error,
      });
      return null;
    }
  }

  async proxyToGitService(repoId: string, path: string, method: string, body?: Record<string, unknown>) {
    return this.scratchGitClient.proxyRequest(repoId, path, method, body);
  }

  // ---------------------------------------------------------------------------
  // Staging API — used by V2 pull job for two-phase fetch/process
  // ---------------------------------------------------------------------------

  async stageFiles(jobId: string, folder: string, files: Array<{ path: string; content: string }>): Promise<void> {
    await this.scratchGitClient.stageFiles(jobId, folder, files);
  }

  async readStagedFiles(
    jobId: string,
    folder: string,
    limit: number,
  ): Promise<{ files: Array<{ path: string; content: string }>; remaining: number }> {
    return this.scratchGitClient.readStagedFiles(jobId, folder, limit);
  }

  async markStagedFilesProcessed(jobId: string, folder: string, paths: string[]): Promise<void> {
    await this.scratchGitClient.markStagedFilesProcessed(jobId, folder, paths);
  }

  async commitStagedFiles(
    jobId: string,
    repoId: string,
    branch: string,
    folder: string,
    message: string,
    batchSize?: number,
  ): Promise<{ committed: number; remaining: number; created: string[]; updated: string[]; unchanged: string[] }> {
    return this.scratchGitClient.commitStagedFiles(jobId, repoId, branch, folder, message, batchSize);
  }

  async cleanupStaging(jobId: string): Promise<void> {
    await this.scratchGitClient.cleanupStaging(jobId);
  }
}
