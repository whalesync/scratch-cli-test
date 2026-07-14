import { BadRequestException, Injectable } from '@nestjs/common';
import {
  DirtyFileCountResponse,
  FileDiffStatus,
  formatRecordJson,
  GitObjectCountsResponse,
  HasDirtyFilesResponse,
  TableView,
  WorkbookId,
} from '@spinner/shared-types';
import { isEqual } from 'lodash';
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

/**
 * Backward-compat shim (DEV-10092): `BaseJsonTableSpec`'s path-shaped fields
 * were renamed and unified on the `*Path: DotPath` (lodash dot-path string)
 * convention. `schema.json` files committed into workbook git repos before the
 * rename still carry the old names. This normalizes a freshly-parsed stored
 * schema in place — filling the new field from the legacy one only when the new
 * field is absent (new writers always emit the new names) and converting the
 * old `string[]` segment arrays for title/mainContent into dot-path strings.
 *
 * The legacy keys are dropped after normalizing so the returned object matches
 * `BaseJsonTableSpec` (`slugColumnRemoteId` is intentionally kept — it remains a
 * recognised `@deprecated` field). Stored schemas are migrated to the new shape
 * lazily: the next pull regenerates the spec and `writeSchemaToGit` rewrites it.
 * Returns the legacy field names that were found, for a one-time warn log.
 *
 * Remove this shim in a follow-up once every workbook has re-pulled.
 */
function normalizeStoredSchemaPathFields(parsed: Record<string, unknown>): { legacyFieldsFound: string[] } {
  const legacyFieldsFound: string[] = [];

  if (parsed.idPath === undefined && typeof parsed.idColumnRemoteId === 'string') {
    parsed.idPath = parsed.idColumnRemoteId;
    legacyFieldsFound.push('idColumnRemoteId');
  }
  if (
    parsed.titlePath === undefined &&
    Array.isArray(parsed.titleColumnRemoteId) &&
    parsed.titleColumnRemoteId.length > 0
  ) {
    parsed.titlePath = parsed.titleColumnRemoteId
      .filter((segment): segment is string => typeof segment === 'string')
      .join('.');
    legacyFieldsFound.push('titleColumnRemoteId');
  }
  if (
    parsed.mainContentPath === undefined &&
    Array.isArray(parsed.mainContentColumnRemoteId) &&
    parsed.mainContentColumnRemoteId.length > 0
  ) {
    parsed.mainContentPath = parsed.mainContentColumnRemoteId
      .filter((segment): segment is string => typeof segment === 'string')
      .join('.');
    legacyFieldsFound.push('mainContentColumnRemoteId');
  }
  if (parsed.slugPath === undefined && typeof parsed.slugFieldPath === 'string') {
    parsed.slugPath = parsed.slugFieldPath;
    legacyFieldsFound.push('slugFieldPath');
  }

  delete parsed.idColumnRemoteId;
  delete parsed.titleColumnRemoteId;
  delete parsed.mainContentColumnRemoteId;
  delete parsed.slugFieldPath;

  return { legacyFieldsFound };
}

/**
 * Repo ID for the per-workbook "scratch" repo that holds standalone, connector-less user files and
 * folders (DEV-10424). Sibling of the workbook config repo; the literal `scratch` segment cannot
 * collide (connector repos key on a cuid, the config repo keys on workbookId). Scratch repos are
 * MAIN-only — edits commit straight to `main` with no review ladder.
 */
export function getScratchRepoPath(orgId: string, workbookId: WorkbookId): RepoId {
  return [orgId, workbookId, 'scratch'].join('/') as RepoId;
}

/**
 * The working branch for a folder's repo. Connector folders stage edits on `dirty` (the
 * published/approved/local review ladder); scratch folders (no connector) commit straight to `main`
 * — there is no external service to publish to, so nothing is ever "pending".
 */
export function workingBranchForConnector(connectorAccountId: string | null | undefined): string {
  return connectorAccountId ? DIRTY_BRANCH : MAIN_BRANCH;
}

function stripGeneratedAt(spec: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { generatedAt, ...rest } = spec as Record<string, unknown> & { generatedAt?: unknown };
  // Round-trip through JSON to drop any `undefined`-valued keys. This matches what
  // gets serialized to disk — otherwise `{slugPath: undefined}` (in-memory)
  // would compare unequal to `{}` (on-disk, after JSON.stringify dropped it).
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
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

  /**
   * Resolves the repo ID for a data folder, regardless of whether it is connector-backed or a
   * standalone scratch folder (DEV-10424). A folder with no connector account lives in the
   * per-workbook scratch repo; everything else resolves through the connector account's repoPath.
   * This is the single entry point browse/edit code uses so a connector-less folder never trips
   * the connector-required guard in `resolveConnectionRepoPath`.
   */
  async resolveRepoPathForFolder(
    connectorAccountId: string | null | undefined,
    workbookId: WorkbookId,
  ): Promise<RepoId> {
    if (connectorAccountId) {
      return this.resolveConnectionRepoPath(connectorAccountId);
    }
    const workbook = await this.db.client.workbook.findUnique({
      where: { id: workbookId },
      select: { organizationId: true },
    });
    if (!workbook) {
      throw new BadRequestException(`Workbook ${workbookId} not found`);
    }
    return getScratchRepoPath(workbook.organizationId, workbookId);
  }

  /**
   * Resolve the per-workbook scratch repo and create it if it does not exist yet (DEV-10424).
   * `initRepo` is idempotent (scratch-git skips an already-initialized repo), so this is safe to call
   * on every scratch write. It makes scratch creates self-healing on workbooks that predate the
   * eager init in `WorkbookService.create` (and never ran the `init-scratch-repos` backfill) — without
   * it, the scratch-git backend's `commit_files` would `GitRepo::open` a missing repo and throw an
   * opaque NotFound on the first folder/file write.
   */
  async ensureScratchRepo(workbookId: WorkbookId): Promise<RepoId> {
    const repoId = await this.resolveRepoPathForFolder(null, workbookId);
    await this.initRepo(repoId);
    return repoId;
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

  /**
   * Force-reset the connection's `dirty` branch back to `main`, discarding every
   * change currently staged on it. Whole-branch reset — for a single path use
   * `discardChanges(repoId, path)`.
   *
   * Used by the publish flow (non-accumulation model, DEV-10630): each upload
   * rebuilds `dirty` from `main` and applies only the current approved patch, so
   * `dirty` is a pure projection of what this publish will do rather than an
   * accumulator of prior edits. That is what stops a locally-discarded edit which
   * still lingered on `dirty` from reappearing in the next publish plan.
   */
  async resetDirtyToMain(repoId: string): Promise<void> {
    await this.scratchGitClient.resetRepo(repoId);
  }

  /**
   * Reconcile `dirty` onto `main`, re-applying the user's edits. `excludePaths`
   * are paths to **converge to `main`** (skip re-applying), used by the publish
   * reconcile to drop published / no-op / desktop-failed edits from `dirty` while
   * preserving every other edit. Empty/omitted ⇒ the legacy "re-apply everything"
   * behavior. See the publish redesign (DEV-10048).
   */
  async rebaseDirty(repoId: string, excludePaths?: string[]) {
    await this.scratchGitClient.rebaseDirty(repoId, excludePaths);
  }

  async runGitGc(repoId: string, aggressive?: boolean) {
    return this.scratchGitClient.gc(repoId, aggressive);
  }

  async getObjectCounts(repoId: string): Promise<GitObjectCountsResponse> {
    return this.scratchGitClient.getObjectCounts(repoId);
  }

  /**
   * Returns the SHA at the tip of `branch` (defaults to `main`), or `null`
   * when the branch doesn't exist. Thin wrapper around the client; the
   * `/upload-patch/commit` controller uses it to compare against the
   * client's `baseHead` for the staleness gate.
   */
  async getBranchHead(repoId: string, branch: string = MAIN_BRANCH): Promise<string | null> {
    return this.scratchGitClient.getBranchHead(repoId, branch);
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

  /**
   * Record-file count per folder for an entire repo (one tree walk). Keys are slash-free
   * folder paths (root is ""); values count direct-child non-dotfile blobs — matching the
   * folder viewer's per-folder file count. Defaults to `main` (the persisted record set).
   * Backs the denormalized {@link DataFolder.recordCount}; an absent key means 0.
   */
  async countRecordFilesByFolder(repoId: string, branch: string = MAIN_BRANCH): Promise<Map<string, number>> {
    const counts = await this.scratchGitClient.countFilesByFolder(repoId, branch);
    return new Map(Object.entries(counts));
  }

  /** Record-file count for a single folder (direct-child non-dotfile blobs); 0 if absent. */
  async countRecordFilesInFolder(repoId: string, folder: string, branch: string = MAIN_BRANCH): Promise<number> {
    return this.scratchGitClient.countFolderFiles(repoId, branch, folder);
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
      let filenames = byFolder.get(folder);
      if (!filenames) {
        filenames = [];
        byFolder.set(folder, filenames);
      }
      filenames.push(filename);
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

  async commitFile(
    repoId: string,
    path: string,
    content: string,
    message: string,
    branch: string = DIRTY_BRANCH,
  ): Promise<void> {
    await this.scratchGitClient.commitFiles(repoId, branch, [{ path, content }], message);
  }

  async deleteFile(repoId: string, paths: string[], message: string, branch: string = DIRTY_BRANCH): Promise<void> {
    await this.deleteFilesFromBranch(repoId, branch, paths, message);
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

  /**
   * Move a folder (records + `.scratch/` metadata) from `oldPath` to `newPath` on both branches,
   * preserving blob OIDs and advancing merge_base in lockstep. Idempotent and crash-safe — used by
   * the Webflow folder-structure migration to re-parent collections under `/<Site>/Collections/`.
   * Returns whether anything was actually moved.
   */
  async moveFolder(repoId: string, oldPath: string, newPath: string, message: string): Promise<{ moved: boolean }> {
    const result = await this.scratchGitClient.moveFolder(repoId, oldPath, newPath, message);
    return { moved: result.moved };
  }

  async deleteFolderFromAllBranches(repoId: string, folderPath: string, message: string): Promise<void> {
    // Delete from both main and dirty branches to avoid orphaned files in git status
    await this.scratchGitClient.deleteFolder(repoId, folderPath, message, MAIN_BRANCH);
    await this.scratchGitClient.deleteFolder(repoId, folderPath, message, DIRTY_BRANCH);
  }

  async removeDataFolder(repoId: string, folderPath: string): Promise<void> {
    await this.scratchGitClient.removeDataFolder(repoId, folderPath);
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

  /**
   * Read-only count of pending (unpublished) record changes on `dirty`
   * measured against live `refs/heads/main`. Backs the DEV-10316 dirty gate
   * (`UploadPatchController.commit`): if this is > 0 for a connection, the
   * desktop/CLI is refused so it never piles its approved edits onto a staging
   * area that isn't already clean. Diffs against `main` (not the `merge_base`
   * tag) so a routine pull doesn't false-positive — see decision #6.
   */
  async getPendingChangeCountVsMain(repoId: string): Promise<number> {
    const { count } = await this.scratchGitClient.getStatusCountVsMain(repoId);
    return count;
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

  /**
   * Tag the commit that `ref` resolves to (branch, tag, or oid) with `name`.
   * Overwrites any existing tag with the same name.
   */
  async writeTag(repoId: string, name: string, ref: string): Promise<void> {
    await this.scratchGitClient.writeTag(repoId, name, ref);
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
      // The default view is written separately (views/default.json) by the caller via
      // `connector.buildDefaultView(spec)`; it is never part of the spec, so schema.json
      // is just the spec as-is.
      const file = { path: newGitPath, content: formatRecordJson(schema as Record<string, unknown>) };
      const message = `Update schema for ${folderPath}`;

      const legacyGitPath = `${normalizedFolder}/${SCHEMA_JSON_FILENAME}`;
      const newCompare = stripGeneratedAt(schema as Record<string, unknown>);

      // TODO: Only write to MAIN_BRANCH, not DIRTY_BRANCH. Nothing reads schemas from dirty
      // (readSchemaFromGit and the index route both read from main). Writing to dirty is unnecessary
      // and was the original cause of a bug where "Changes to approve" showed with no actual file
      // differences — the schema's generatedAt timestamp created a .scratch/ diff between merge_base
      // and dirty. The has_dirty endpoint now filters dotfiles (has_visible_tree_changes in
      // scratch-git-2/src/service/git/repo.rs) so this is no longer user-visible, but the extra
      // writes are still wasted work.
      for (const branch of [MAIN_BRANCH, DIRTY_BRANCH]) {
        // Skip the commit if the current schema on this branch is identical to what we'd write,
        // ignoring the volatile `generatedAt` timestamp. Avoids no-op commits on every publish.
        let shouldWriteSchema = true;
        const existing = await this.getRepoFile(repoId, branch, newGitPath);
        if (existing) {
          try {
            const existingSpec = JSON.parse(existing.content) as Record<string, unknown>;
            if (isEqual(stripGeneratedAt(existingSpec), newCompare)) {
              shouldWriteSchema = false;
            }
          } catch {
            // Malformed existing file — fall through and overwrite.
          }
        }

        if (shouldWriteSchema) {
          await this.commitFilesToBranch(repoId, branch, [file], message);
        }
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
      const file = { path: gitPath, content: formatRecordJson(view as unknown as Record<string, unknown>) };
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
      const parsed = JSON.parse(file.content) as Record<string, unknown>;
      const { legacyFieldsFound } = normalizeStoredSchemaPathFields(parsed);
      if (legacyFieldsFound.length > 0) {
        WSLogger.warn({
          source: 'ScratchGitService.readSchemaFromGit',
          message:
            'Read a schema.json using legacy path-field names (DEV-10092); normalized to *Path. The stored schema will be rewritten on the next pull.',
          repoId,
          folderPath,
          legacyFieldsFound,
        });
      }
      return parsed as unknown as BaseJsonTableSpec;
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

  /**
   * Reads a TableView (`views/{viewName}.json`) from `.scratch/{folderPath}/` on
   * the main branch — the read complement of `writeViewToGit`. The connector's
   * curated default view is persisted separately from the schema (it is stripped
   * out of `schema.json` by `writeSchemaToGit`), so this is the only way to read
   * it back offline. Returns the parsed TableView or null if missing/invalid.
   * Non-throwing — failures are logged but do not block callers.
   */
  async readViewFromGit(repoId: string, folderPath: string, viewName: string): Promise<TableView | null> {
    try {
      const normalizedFolder = folderPath.replace(/^\//, '');
      const gitPath = `${SCRATCH_DIR}/${normalizedFolder}/views/${viewName}.json`;
      const file = await this.getRepoFile(repoId, MAIN_BRANCH, gitPath);
      if (!file) return null;
      return JSON.parse(file.content) as TableView;
    } catch (error) {
      WSLogger.error({
        source: 'ScratchGitService.readViewFromGit',
        message: 'Failed to read view from git',
        repoId,
        folderPath,
        viewName,
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
