/**
 * File system entity types for the file-based workbook database
 */

import { Service } from './enums';
import { DataFolderId } from './ids';

/**
 * Diff status of a file relative to the published branch.
 */
export type FileDiffStatus = 'added' | 'modified' | 'deleted';

/**
 * Sentinel `connectorAccountId` value used for dirty entries that originate
 * from the workbook's config repo (not tied to any external connector).
 */
export const SCRATCH_WORKBOOK_CONFIG_REPO_ID = 'scratch_workbook_config_repo';

/**
 * A dirty file in a workbook repo, scoped to a specific connector account.
 * Two connectors with folders sharing the same path (e.g. `/Companies` under
 * both Affinity and Attio) must be disambiguated by `connectorAccountId`.
 */
export interface DirtyFile {
  path: string;
  status: FileDiffStatus;
  /** Source connector account, or SCRATCH_WORKBOOK_CONFIG_REPO_ID for the workbook config repo. */
  connectorAccountId: string;
}

/**
 * Response from the fast "has dirty files" check.
 * Compares root tree OIDs — instant regardless of repo size.
 */
export interface HasDirtyFilesResponse {
  dirty: boolean;
}

/**
 * Response from the dirty file count endpoint.
 */
export interface DirtyFileCountResponse {
  count: number;
}

/**
 * Response from the git count-objects endpoint.
 */
export interface GitObjectCountsResponse {
  stats: string;
  gcInProgress: number | null;
  engine?: string;
  repoPath?: string;
}

/**
 * Response from the git gc endpoint.
 */
export interface GitGcResponse {
  success: boolean;
  statsBefore: string;
  statsAfter: string;
}

/**
 * One staging directory reported by scratch-git's `GET /api/staging`: the per-job
 * `{staging_dir}/{jobId}` dir, its last-modified time (ms since the Unix epoch), and its total
 * on-disk size in bytes.
 */
export interface GitStagingDir {
  jobId: string;
  mtimeMs: number;
  sizeBytes: number;
}

/**
 * Response from the scratch-git `GET /api/staging` listing endpoint. Consumed by the server's
 * hourly staging-dir reaper (DEV-11317) to find age + job-liveness orphans.
 */
export interface GitStagingDirsResponse {
  stagingDirs: GitStagingDir[];
}

/**
 * Per-ref walkability snapshot from `git fsck`. `walkable` is the clonability
 * signal: a `git clone --bare` mirrors every ref, so one unwalkable ref (one
 * that reaches a missing/corrupt object) makes the whole clone abort.
 */
export interface GitRefStatus {
  /** Full ref name, e.g. `refs/heads/dirty`. */
  refName: string;
  /** Short name, e.g. `dirty`. */
  shortName: string;
  sha: string | null;
  walkable: boolean;
  /** First line of `git rev-list` stderr when not walkable. */
  error: string | null;
}

/**
 * Structured `git fsck` report for one connection's bare repo (the `fsck`
 * dev-tools endpoint).
 */
export interface GitFsckResponse {
  /** `git fsck` reported no missing/unreadable/broken objects. */
  fsckClean: boolean;
  /** Every ref walks cleanly ⇒ `git clone --bare` will succeed. */
  refsAllWalkable: boolean;
  mainWalkable: boolean;
  dirtyWalkable: boolean;
  corruptRefs: string[];
  missingObjects: string[];
  unreadableObjects: string[];
  refs: GitRefStatus[];
  /** Raw fsck output, truncated for transport. */
  rawFsck: string;
}

/** Outcome of a connection-repo repair. */
export type GitRepairStatus = 'repaired' | 'already_clean' | 'refused_main_corrupt';

/**
 * Result of repairing a corrupt connection repo (reset a corrupt `dirty` branch
 * to `main`). Non-destructive to published (`main`) data — only unpublished
 * `dirty` edits are lost. `refused_main_corrupt` means `main` itself is corrupt
 * and manual recovery is required.
 */
export interface GitRepairResponse {
  status: GitRepairStatus;
  before: GitFsckResponse;
  after: GitFsckResponse | null;
  /** Human-readable list of the surgery performed, in order. */
  actions: string[];
  dirtyResetFrom: string | null;
  dirtyResetTo: string | null;
  deletedRefs: string[];
  gcRan: boolean;
  gcOutput: string | null;
}

/**
 * Reference to a file in the workbook
 */
export interface FileRefEntity {
  type: 'file';
  /** Full path of the file and the unique identifier, e.g. "/folder/file.md" */
  path: string;
  /** Name of the file, e.g. "file.md" */
  name: string;
  /** ID of the parent folder, or null if at workbook root */
  parentFolderId: DataFolderId | null;
  /** Whether the file has unpublished changes */
  dirty?: boolean;
  /** Diff status relative to the published branch */
  status?: FileDiffStatus;
}

/**
 * Reference to a folder in the workbook
 */
export interface FolderRefEntity {
  type: 'folder';
  id: DataFolderId;
  name: string;
  /** ID of the parent folder, or null if at workbook root */
  parentFolderId: DataFolderId | null;
  /** Full path of the folder, e.g. "/parent/child" */
  path: string;
  /** Service type if folder is linked to a snapshot table */
  connectorService?: Service | null;
  /** Remote ID of the source table if synced */
  remoteId?: string | string[] | null;
}

/**
 * Either a file or folder reference
 */
export type FileOrFolderRefEntity = FileRefEntity | FolderRefEntity;

export interface FileDetailsEntity {
  ref: FileRefEntity;
  content: string | null;
  originalContent: string | null;
  suggestedContent: string | null;
  createdAt: string; // ISO-8601 string
  updatedAt: string; // ISO-8601 string
}
