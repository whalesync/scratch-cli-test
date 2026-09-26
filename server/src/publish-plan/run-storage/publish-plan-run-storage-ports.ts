/**
 * Storage ports for the publish *run* (`PublishPlanRunService.runPipeline`).
 *
 * The run orchestration — phase order, batching, connector dispatch, error
 * classification, the failed-batch retry pass — is storage-agnostic. What is
 * not is where the plan lives and where published results are persisted. These
 * two ports name that IO so it can be swapped per run:
 *
 *   - {@link PlanStore}: everything the run reads from / writes to the plan
 *     (plan status, pending operations per phase/folder, per-operation status).
 *   - {@link RecordWriteback}: everything that persists a dispatched batch's
 *     result back into Scratch storage (and the before/after bookkeeping around
 *     a run).
 *
 * The classic implementations (`classic-publish-plan-run-storage.ts`) are the
 * PublishPlan/PublishPlanOperation tables plus git `main`/`dirty` commits,
 * FileIndex and FileReference — today's code moved behind the ports. A second
 * implementation over a per-run file store (Live Export) is planned; the port
 * types are therefore plain domain types with no Prisma rows and no git
 * concepts (branches, commits, repos) in them. See
 * `docs/plans/2026-09-25-live-export-git-free-run-store/2026-09-25-live-export-git-free-run-store.md`
 * ("Where the code changes (the seams)").
 */
import type { PublishOrigin } from '@spinner/shared-types';
import type { ParsedContent } from 'src/utils/objects';
import type { TableSpecStore } from 'src/workbook/table-spec-store/table-spec-store';
import type { PublishPlanPhase, PublishPlanStatus } from '../types';

/** Lifecycle of a single plan operation. */
export type PublishPlanOperationStatus = 'pending' | 'success' | 'failed-batch';

/** The plan-level facts the run needs. */
export interface PublishPlanRunPlan {
  id: string;
  workbookId: string;
  /** The user the run acts as (feature-flag scope, connector resolution). */
  userId: string;
  /** The connection the plan publishes to. */
  connectorAccountId: string | null;
  /** A `PublishPlanStatus` value; drives which phase a (resumed) run starts at. */
  status: string;
  /** Legacy label echoed back on `PublishPlanInfo`; a store without branches may return an empty string. */
  branchName: string;
  createdAt: Date;
}

/** One unit of work the run dispatches to the connector. */
export interface PublishPlanRunOperation {
  id: string;
  /** Workspace-relative record path (`<folderPath>/<filename>`). */
  filePath: string;
  /** The record to push at this phase. May be empty for ops with nothing to send. */
  content: ParsedContent;
  /** The record's id in the external service (edits/deletes; absent for creates). */
  remoteRecordId?: string | null;
  /** The DataFolder the record belongs to — the run batches and resolves the table spec by it. */
  dataFolderId?: string | null;
  /** True when the op came from a revert patch (gates the recreate FK remap). */
  isRecreate?: boolean;
  /** Sparse partial to PATCH. Required for the edit/backfill phases (validated by the run). */
  changedFields?: Record<string, unknown> | null;
}

/** The failure-relevant facts of an operation left `failed-batch`. */
export interface PublishPlanRunFailedOperation {
  filePath: string;
  phase: string;
  error: string | null;
  errorCode: string | null;
}

/** The reason stamped on operations marked `failed-batch`. */
export interface PublishPlanRunOperationFailure {
  /** User-facing reason (the connector's own message when it gave one). */
  error: string;
  /** Stable `ConnectorErrorCode` classification, when the connector recognized the failure. */
  errorCode: string | null;
}

/** Everything the run reads from / writes to the plan it executes. Bound to one plan. */
export interface PlanStore {
  /** The plan, or null when it does not exist. */
  readPlan(): Promise<PublishPlanRunPlan | null>;
  /** The connection the plan publishes to (null when the plan or its connection is gone). */
  readPlanConnectorAccountId(): Promise<string | null>;
  /** Persist a new plan status (a `PublishPlanStatus` value, e.g. `edits-running`). */
  updatePlanStatus(status: string): Promise<void>;
  /** Persist the terminal status and the run's success/failure totals. */
  recordPlanFinalStatusAndResult(
    status: PublishPlanStatus,
    result: { successCount: number; failedCount: number },
  ): Promise<void>;

  /** Number of operations in the phase, in any status. */
  countOperationsInPhase(phase: PublishPlanPhase): Promise<number>;
  /** Number of operations in the phase with the given status. */
  countOperationsInPhaseWithStatus(phase: PublishPlanPhase, status: PublishPlanOperationStatus): Promise<number>;
  /** Number of `failed-batch` operations in the phase whose recorded error is exactly `error`. */
  countFailedOperationsInPhaseWithError(phase: PublishPlanPhase, error: string): Promise<number>;
  /** Operation counts for every (phase, status) pair present in the plan. */
  countOperationsGroupedByPhaseAndStatus(): Promise<{ phase: string; status: string; count: number }[]>;

  /** Every pending operation of the phase, fully materialized (used only for the small asset-upload phase). */
  listPendingOperationsInPhase(phase: PublishPlanPhase): Promise<PublishPlanRunOperation[]>;
  /** The distinct DataFolder ids that still have pending operations in the phase. */
  listDataFolderIdsWithPendingOperationsInPhase(phase: PublishPlanPhase): Promise<(string | null)[]>;
  /** Ids (ascending) of the pending operations of the phase in one DataFolder — a stable snapshot to page over. */
  listPendingOperationIdsInPhaseForDataFolder(phase: PublishPlanPhase, dataFolderId: string): Promise<string[]>;
  /** Ids of the phase's `failed-batch` operations (the individual-retry pass). */
  listFailedOperationIdsInPhase(phase: PublishPlanPhase): Promise<string[]>;
  /** Full operations for the given ids, ordered by id ascending. */
  readOperationsByIdsOrderedById(operationIds: string[]): Promise<PublishPlanRunOperation[]>;
  /** One full operation, or null when it no longer exists. */
  readOperationById(operationId: string): Promise<PublishPlanRunOperation | null>;

  /** Distinct record paths that have at least one `failed-batch` operation. */
  listDistinctFilePathsWithFailedOperations(): Promise<string[]>;
  /** Every `failed-batch` operation's failure facts, ordered by file path. */
  listFailedOperationsOrderedByFilePath(): Promise<PublishPlanRunFailedOperation[]>;
  /** Of `filePaths`, those that still have a `pending` operation in one of `phases`. */
  findFilePathsWithPendingOperationsInPhases(filePaths: string[], phases: PublishPlanPhase[]): Promise<Set<string>>;
  /** Every operation's file path and status, for scoping the post-run reconcile to what this plan touched. */
  listOperationFilePathsAndStatuses(): Promise<{ filePath: string; status: string }[]>;

  /** Mark operations `success` and clear any earlier failure. */
  markOperationsSucceeded(operationIds: string[]): Promise<void>;
  /** Mark operations `failed-batch` with one shared reason. */
  markOperationsFailed(operationIds: string[], failure: PublishPlanRunOperationFailure): Promise<void>;
  /** Mark a single operation `failed-batch` with its own reason. */
  markOperationFailed(operationId: string, failure: PublishPlanRunOperationFailure): Promise<void>;

  /** Drop plan-build inputs the completed run consumed (e.g. per-path upload metadata). Never throws. */
  releaseInputsConsumedByCompletedRun(plan: PublishPlanRunPlan): Promise<void>;
}

/** A record the connector updated, as it should now be stored. */
export interface UpdatedRecordToWriteBack {
  operationId: string;
  filePath: string;
  content: ParsedContent;
}

/** A record the connector created, as it should now be stored. */
export interface CreatedRecordToWriteBack {
  operationId: string;
  filePath: string;
  content: ParsedContent;
  /** The id the external service assigned, or null when the connector returned no usable id. */
  createdRemoteRecordId: string | null;
}

/** A record the connector deleted. */
export interface DeletedRecordToWriteBack {
  operationId: string;
  filePath: string;
  remoteRecordId: string;
}

/** The result of uploading a rehosted asset to the external service. */
export interface UploadedAssetToWriteBack {
  assetId: string;
  remoteAssetId: string;
  url?: string;
  filename: string;
  mimeType: string;
  size?: number;
  width?: number;
  height?: number;
}

/** A pending-named record file to move to its final name (rename-files phase). */
export interface PublishedRecordFileRename {
  oldName: string;
  newName: string;
  remoteRecordId: string;
}

/**
 * Persists what the connector did back into Scratch storage. Bound to one run of
 * one plan. The rename-files methods serve only that phase; a store whose plans
 * never contain rename-files operations may leave them unsupported (throw).
 */
export interface RecordWriteback {
  /** Record the storage state before a plan's first run (not on resume), for audit/rollback. Never throws. */
  captureStorageStateBeforeFirstRun(): Promise<void>;

  /** Persist a batch of records the connector updated (edit/backfill phases). */
  writeBackUpdatedRecords(args: {
    phase: PublishPlanPhase;
    records: UpdatedRecordToWriteBack[];
    dispatchedOperationCount: number;
  }): Promise<void>;
  /** Persist a batch of records the connector created (create phase). */
  writeBackCreatedRecords(args: {
    phase: PublishPlanPhase;
    records: CreatedRecordToWriteBack[];
    dispatchedOperationCount: number;
    connectorAccountId: string | null;
  }): Promise<void>;
  /** Persist a batch of records the connector deleted (delete phase). */
  writeBackDeletedRecords(args: { records: DeletedRecordToWriteBack[] }): Promise<void>;
  /** Persist the result of an asset upload (asset-upload phase). */
  recordUploadedAsset(asset: UploadedAssetToWriteBack): Promise<void>;
  /**
   * The external id stored for a record path — for a record created earlier in
   * this run (a backfill), the id its create wrote back. Null when unknown.
   */
  lookupRemoteRecordIdForFile(args: { filePath: string; connectorAccountId: string | null }): Promise<string | null>;

  /** rename-files: the external id stored for each of the given filenames in a folder (absent = unknown). */
  lookupRemoteRecordIdsByFilenameInFolder(folderPath: string, filenames: string[]): Promise<Map<string, string>>;
  /** rename-files: the stored (published) content of the given files in a folder; `content` null when missing. */
  readPublishedRecordFilesInFolder(
    folderPath: string,
    filenames: string[],
  ): Promise<{ path: string; content: string | null }[]>;
  /** rename-files: every filename currently taken in a folder. */
  listFilenamesInFolder(folderPath: string): Promise<string[]>;
  /** rename-files: move pending-named files to their final names. */
  renamePublishedFilesInFolder(args: {
    folderPath: string;
    renames: PublishedRecordFileRename[];
    connectorAccountId: string | null;
  }): Promise<void>;

  /**
   * After the phases ran: reconcile the user's working state with what was
   * published. `publishOrigin` decides whether failed records stay pending for
   * review (web) or are handed back to the client (desktop/CLI).
   */
  reconcileLocalEditsAfterRun(args: { publishOrigin?: PublishOrigin }): Promise<void>;
  /** Record the storage state after the run, for audit/rollback. Never throws. */
  captureStorageStateAfterRun(): Promise<void>;
}

/**
 * Resolves the `@/…` pseudo-refs in record content to remote record ids before a record is sent to
 * the connector (and reports the ones that can't be resolved). In a Live Export run every `@/…` ref
 * names a destination record created earlier in the same run, so a run store can answer from the
 * ids it recorded at create write-back. The classic implementation is `RefResolverService` (Postgres
 * FileIndex), which also resolves `@asset/…` refs through the Asset table.
 */
export interface PublishPseudoRefResolver {
  /** The `@/…` ref strings in `contents` that name no known record. */
  findUnresolvablePseudoRefs(workbookId: string, contents: ParsedContent[]): Promise<Set<string>>;
  /** `contents` with every `@/…` (and `@asset/…`) ref replaced by the remote id it names. */
  resolveBatchPseudoRefs(
    workbookId: string,
    unresolvedContents: ParsedContent[],
    assetResolver?: (asset: { remoteAssetId: string; rehostedUrl: string | null; url: string | null }) => unknown,
  ): Promise<Record<string, unknown>[]>;
}

/**
 * Opens the ports for one run. `PublishPlanRunService` uses the classic
 * implementation unless a run passes its own.
 */
export interface PublishPlanRunStorage {
  /** Where the run reads each folder's table spec. */
  readonly tableSpecStore: TableSpecStore;
  readonly pseudoRefResolver: PublishPseudoRefResolver;
  openPlanStore(planId: string): PlanStore;
  /** `planStore` is the store of the same plan: write-back asks it which records are final. */
  openRecordWriteback(plan: PublishPlanRunPlan, planStore: PlanStore): Promise<RecordWriteback>;
}
