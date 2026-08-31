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
  /**
   * True when scratch-git did NOT run `git gc` because background maintenance is enabled
   * (DEV-11316): the maintenance loop owns compaction/pruning, so the after-job call is a no-op.
   */
  skipped?: boolean;
  /** Why it was skipped (`maintenance_enabled`). */
  reason?: string;
}

/**
 * scratch-git's background-maintenance switch (`GET/PUT /api/maintenance/config`, DEV-11316).
 * In memory, persisted to the maintenance SQLite DB and read at boot; missing ⇒ `enabled: false`.
 */
export interface GitMaintenanceConfigResponse {
  enabled: boolean;
  /** When the switch was last flipped (ms since epoch); null when never persisted. */
  updatedAtMs: number | null;
}

/** `loose` / `packs` / packed bytes of one repo at one instant. */
export interface GitMaintenanceObjectCounts {
  loose: number;
  /** Total bytes of the loose object files (0 in journal rows — not journaled per run). */
  looseBytes?: number;
  packs: number;
  packBytes: number;
  largestPackBytes: number;
}

/** What one maintenance step did to one repo (journaled in the maintenance DB, 30-day retention). */
export interface GitMaintenanceStepOutcome {
  mode: 'quick' | 'full';
  /** `completed` | `failed` | `timed_out` | `aborted` | `fsck_failed` | `fsck_inconclusive` (gc ran, canary did not pass / could not finish) */
  state: string;
  /** Why the step was due (e.g. `loose=18240`, `smallPackShare=0.31`, `neverMaintained`). */
  reason: string;
  startedAtMs: number;
  durationMs: number;
  before: GitMaintenanceObjectCounts;
  after: GitMaintenanceObjectCounts;
  /** The git commands that ran, in order. */
  commands: string[];
  exitCode?: number;
  stderr?: string;
  /** Only on full steps: the post-gc `fsck` canary. */
  fsckClean?: boolean;
}

/** One tick of the maintenance loop. */
export interface GitMaintenanceTickSummary {
  startedAtMs: number;
  durationMs: number;
  scanMs: number;
  reposScanned: number;
  reposUnreadable: number;
  dueQuick: number;
  dueFull: number;
  ran: Array<{ repoId: string; outcome: GitMaintenanceStepOutcome }>;
  aborted: boolean;
}

/** One journaled maintenance step (`GET /api/maintenance/runs` on scratch-git; 30-day retention). */
export interface GitMaintenanceRun {
  id: number;
  repoId: string;
  outcome: GitMaintenanceStepOutcome;
}

/** One `settings` row of the maintenance DB (`GET /api/maintenance/settings`). */
export interface GitMaintenanceSettingRow {
  key: string;
  value: string;
  updatedAtMs: number;
}

/** One repo as the maintenance sweep sees it right now (`GET /api/maintenance/repos`). */
export interface GitMaintenanceRepoRow {
  repoId: string;
  /** Filesystem creation (birth) time of the repo directory; null where the FS does not record it. */
  createdAtMs: number | null;
  /** Owner of the repo's workbook — enriched by the server (scratch-git knows nothing about users). */
  userName?: string | null;
  userEmail?: string | null;
  loose: number;
  /** Total bytes of the loose object files. */
  looseBytes: number;
  packs: number;
  packBytes: number;
  largestPackBytes: number;
  /** Share of packed bytes outside the largest pack (0 for a single-pack repo). */
  smallPackShare: number;
  lastWriteAtMs: number;
  /** Derived: newest pack mtime. Null = never. */
  lastQuickAtMs: number | null;
  /** Derived: `objects/info/commit-graph` mtime. Null = never. */
  lastFullAtMs: number | null;
  /** What the next tick would do: `quick` | `full` | `nothing`. */
  plan: 'quick' | 'full' | 'nothing';
  reason: string;
  /** Set when the repo could not be scanned. */
  error?: string;
}

/** One `ticks` row of the maintenance DB (`GET /api/maintenance/ticks`). */
export interface GitMaintenanceTickRow {
  id: number;
  startedAtMs: number;
  durationMs: number;
  scanMs: number;
  reposScanned: number;
  reposUnreadable: number;
  dueQuick: number;
  dueFull: number;
  ran: number;
  aborted: boolean;
}

/** `POST /api/maintenance/run` on scratch-git — one manually triggered step on one repo. */
export interface GitMaintenanceRunNowResponse {
  /**
   * The outcome state when the step finished within the wait window; `started` when it is still
   * running (poll the runs journal); `skipped_already_running` when a GC already holds the repo.
   */
  state: string;
  outcome?: GitMaintenanceStepOutcome;
}

/** `GET /api/maintenance/status` on scratch-git. */
export interface GitMaintenanceStatusResponse {
  enabled: boolean;
  /** The throw-away cache/journal DB (`<root>/maintenance/maintenance.sqlite`). */
  dbPath: string;
  settings: {
    tickIntervalSecs: number;
    quickMinIntervalMs: number;
    fullMinIntervalMs: number;
    fullMaxIntervalMs: number;
    looseThreshold: number;
    maxPacks: number;
    smallPackShareThreshold: number;
    quickBudgetSecs: number;
    fullBudgetSecs: number;
    fsckAfterFull: boolean;
  };
  tickInProgress: boolean;
  current: { repoId: string; mode: 'quick' | 'full'; startedAtMs: number } | null;
  lastTick: GitMaintenanceTickSummary | null;
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
