import { PublishFailedOperation } from '../dto/publish-plan/publish-job-responses.dto';
import { FolderError } from '../job-types';

///
/// Per-job-type `publicProgress` shapes — the UI-facing progress object a job writes to its BullMQ
/// checkpoint and that surfaces on `Job.publicProgress`. These are the single source of truth shared
/// by the server (which produces them), the web client, the desktop app, and the `scratchmd` CLI
/// (which render them). Each job type emits a DIFFERENT shape, discriminated by `Job.type`.
///
/// Keep these in sync with the job handlers in
/// `server/src/worker/jobs/job-definitions/*.job.ts`, which re-export the type they implement.
///

// ── Pull (pull-linked-folder-files) ──────────────────────────────────────────

/** Lifecycle status of a single pulled folder. */
export type PullFolderProgressStatus = 'pending' | 'active' | 'completed' | 'failed';

/**
 * Per-folder breakdown for a pull job, mirroring sync's per-table breakdown
 * ({@link SyncTableProgress}) so the two render through the same uniform contract. A pull job can
 * target many folders; this carries the counts and impacted paths for ONE of them.
 *
 * Declared as a `type` (not `interface`) so it stays structurally assignable to the JSON-safe index
 * signature that `Job.publicProgress` flows through on the server (BullMQ data / Prisma `Json`).
 */
export type PullFolderProgress = {
  /** DataFolderId of the pulled folder. */
  id: string;
  /** The folder's display name. */
  name: string;
  /** The folder's connector service (e.g. "AIRTABLE"). */
  connector: string;
  /** Records created / updated / deleted in THIS folder. Named to match {@link SyncTableProgress}. */
  creates: number;
  updates: number;
  deletes: number;
  /** Total records fetched from the connector for this folder (not just the changed ones). */
  totalFiles: number;
  /** Impacted record file paths for this folder (capped server-side for UI display). */
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
  status: PullFolderProgressStatus;
  /** Effective pull mode for this folder (an incremental request can demote to full per-folder). */
  mode?: 'full' | 'incremental';
  /** Set when this folder failed in Phase 1 (fetch) or Phase 2 (process). */
  error?: FolderError;
};

export type PullLinkedFolderFilesPublicProgress = {
  totalFiles: number;
  folderCount: number;
  connectionName: string;
  folderId: string;
  folderName: string;
  connector: string;
  filter: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
  /**
   * Effective pull mode for the current folder. Set when a folder's resolution
   * finishes in Phase 1 and updated per-folder as Phase 2 advances. Incremental
   * requests can demote to full per-folder (capability check, bootstrap), so
   * this can differ from the job's requested mode.
   */
  mode?: 'full' | 'incremental';
  /** All folder IDs being pulled (multi-folder jobs). */
  dataFolderIds?: string[];
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
  /** Actual counts (not capped like path arrays) for accurate analytics. */
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
  /**
   * Per-folder breakdown — one entry per pulled folder, parallel to sync's `tables`. Lets the UI show
   * "3 created in Countries, 0 in QB Bills" instead of a single aggregate row with one folder's name.
   * The flat `created/updated/deletedCount` and `*Paths` fields above remain the run-wide aggregate.
   */
  folders: PullFolderProgress[];
  /** Per-folder errors keyed by folderId. Populated when a folder fails in Phase 1 or Phase 2. */
  folderErrors?: Record<string, FolderError>;
  /** Display-only hint surfaced by some client progress widgets; never produced by the server today. */
  hasDirtyDiscoveredDeletes?: boolean;
};

// ── Sync (sync-data-folders) ─────────────────────────────────────────────────

/** Lifecycle status of a single synced table. */
export type SyncTableProgressStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Per-table breakdown for a sync job — counts, impacted paths, and per-record errors/warnings.
 * Declared as a `type` (not `interface`) so it stays structurally assignable to the JSON-safe index
 * signature that `Job.publicProgress` flows through on the server (BullMQ data / Prisma `Json`).
 */
export type SyncTableProgress = {
  id: string;
  name: string;
  connector: string;
  creates: number;
  updates: number;
  deletes: number;
  skipped: number;
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
  errorCount: number;
  errors: Array<{ sourceRemoteId: string; error: string }>;
  warningCount: number;
  warnings: Array<{ sourceRemoteId: string; warning: string }>;
  status: SyncTableProgressStatus;
};

export type SyncDataFoldersPublicProgress = {
  totalFilesSynced: number;
  tables: SyncTableProgress[];
};

// ── Publish (publish) ────────────────────────────────────────────────────────

export type PublishPublicProgress = {
  status: 'planning' | 'running' | 'completed' | 'failed';
  step?: string;
  currentPhase?: string;
  assetUploadsExecuted: number;
  assetUploadsPlanned: number;
  editsExecuted: number;
  createsExecuted: number;
  deletesExecuted: number;
  backfillsExecuted: number;
  renameFilesExecuted: number;
  editsPlanned: number;
  createsPlanned: number;
  deletesPlanned: number;
  backfillsPlanned: number;
  renameFilesPlanned: number;
  lastSyncError?: string;
  errorCount: number;
  /**
   * DEV-10243: count of operations the destination connector rejected (rows
   * marked `failed-batch` during the run). Set on the terminal `completed`
   * checkpoint so the CLI/desktop can detect a per-row failure even though the
   * BullMQ job itself still ends `completed`. Both consumers read it as
   * `failedCount ?? 0`, so it stays optional and the other checkpoint literals
   * don't need to set it.
   */
  failedCount?: number;
  /**
   * Bounded sample of the run's per-record connector rejections (rows left
   * `failed-batch`), each carrying the connector's own user-facing message.
   * Set on the terminal `completed` checkpoint alongside `failedCount` so the
   * desktop/CLI can show *why* a record didn't publish (e.g. Pipedrive's
   * "'person_id' is a read-only field…"), not just a count. Extends DEV-10243.
   */
  failedOperations?: PublishFailedOperation[];
  /**
   * Human-friendly display name of the destination service (e.g. "PostgreSQL"), resolved server-side
   * from the plan's connector account. Set on the terminal `completed` checkpoint so a per-record
   * rejection can be attributed to the service that rejected it ("… rejected by PostgreSQL") rather
   * than reading as though Scratch rejected it. Optional — undefined when the service can't be resolved.
   */
  destinationServiceName?: string;
  /**
   * DEV-10316 publish-time TOCTOU abort. Set (with `status: 'failed'`) when the
   * connection's dirty HEAD drifted past the client's `expectedBaseDirtyHead`
   * since upload, so the plan was aborted before building. The desktop modal
   * reads this off the plan job's progress to route into its count-only `dirty`
   * redirect (with the "server changed while you were reviewing" lead) instead
   * of showing a generic failure.
   */
  blockedDirtyDrift?: { connectorAccountId: string; dirtyCount: number };
  /**
   * DEV-10436 (routines, self-planning publish): the resolved PublishPlan id, set on
   * terminal (completed/failed) checkpoints so a routine step can record it on
   * RoutineRunStep.pipelineId. Intermediate planning/running checkpoints omit it.
   */
  pipelineId?: string;
};
