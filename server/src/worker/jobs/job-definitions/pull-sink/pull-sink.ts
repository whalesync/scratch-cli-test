/**
 * The storage port of the `pull-linked-folder-files` job.
 *
 * Why this exists: the pull job does two separable things — it asks a connector for pages of records
 * (orchestration: concurrency, cursors, BullMQ checkpoint/resume, watermarks, progress, error
 * handling), and it persists those records (today: stage on scratch-git, index into FileIndex /
 * FileReference / Asset, commit to git, delete stale files, rebase, GC). Only the second half is
 * storage. `PullSink` is that second half behind an interface, so the job's orchestration stays
 * shared while a Live Export run can write its pages to a disposable per-run store instead of the
 * git pipeline. See docs/plans/2026-09-25-live-export-git-free-run-store/2026-09-25-live-export-git-free-run-store.md
 * ("Where the code changes (the seams)").
 *
 * The classic implementation is `ClassicGitPullSink` (`classic-git-pull-sink.ts`), which is the job's
 * former Phase-2 code moved verbatim. Keep git and Prisma concepts out of this file: a sink that
 * writes plain files to a run directory must be able to implement it.
 *
 * Call order, per job attempt:
 *   0. `prepareStorageBeforeLoadingFolders` once, then `storeFolderTableSpec` (and
 *      `storeFolderDefaultView`, when the connector builds one) once per folder that loads and has a path.
 *      If NO folder loads, the job fails right here and calls none of the steps below — so
 *      `prepareStorageBeforeLoadingFolders` must not create anything that only step 3 or 4 would release.
 *   1. Phase 1 (folders fetched in parallel): for each folder that is fetched in this attempt,
 *      `prepareFolderForIncomingRecordPages` once, then `writeConnectorRecordPage` once per
 *      connector page, then `releaseRecordPageWritingStateForFolder` once (even if the fetch failed).
 *      A folder that was fully fetched by an earlier attempt skips all three.
 *   2. Phase 2 (folders sequentially): `finishFolderAfterAllRecordPagesWritten` once per folder that
 *      fetched successfully (in this attempt or an earlier one) and has not been finished before.
 *   3. `cleanUpTemporaryStorageAfterPullAttempt` once, in the job's `finally`, even on failure.
 *   4. `finalizeStorageAfterAllFoldersFinished` once, after the job's terminal checkpoint, even on
 *      failure (successful folders still get finalized).
 */
import type { TableView } from '@spinner/shared-types';
import type { Connector } from '../../../../remote-service/connectors/connector';
import type { BaseJsonTableSpec, ConnectorFile } from '../../../../remote-service/connectors/types';
import type { TableSpecLocation } from '../../../../workbook/table-spec-store/table-spec-store';
import type { PullLinkedFolderFilesJobDefinition } from '../pull-linked-folder-files.job';

/** The folder a sink call is about: what the sink needs to know to name and place its records. */
export type PullSinkFolder = {
  dataFolder: {
    id: string;
    workbookId: string;
    name: string;
    path: string | null;
    connectorService: string;
    connectorAccountId: string;
  };
  connector: Connector;
  tableSpec: BaseJsonTableSpec;
};

/** What finishing a folder changed in the sink's storage, reported into the job's progress and stats. */
export type PullSinkFolderChangeSummary = {
  created: number;
  updated: number;
  deleted: number;
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
};

export type FinishFolderOptions = {
  /**
   * True when this folder's fetch resumed from a checkpoint (mid-fetch cursor, or fully fetched by an
   * earlier attempt), so the sink has NOT seen every record the connector holds in this attempt.
   */
  isResumingFromEarlierAttempt: boolean;
  /**
   * True for a full pull: a record absent from this pull was deleted upstream and may be removed from
   * storage. False for an incremental pull, whose connector only returned records changed since the
   * watermark — absent records are unchanged, not deleted.
   */
  mayRemoveRecordsAbsentFromThisPull: boolean;
  /** Called after each durable batch so the job can checkpoint its progress (BullMQ + Postgres). */
  reportDurableProgress: () => Promise<void>;
};

export interface PullSink {
  /**
   * True when this sink's storage is the baseline an incremental pull extends — the classic git store,
   * which the folder's watermarks (`lastFullPullAt` / `lastIncrementalPullAt` / `incrementalCursor`)
   * describe. A sink whose storage starts empty every run (the Live Export run store) is false: the job
   * then always pulls fully and leaves the watermarks untouched, so they keep describing the classic
   * store should the workbook ever go back to it.
   */
  readonly persistsIncrementalPullBaseline: boolean;

  /** Called once per job attempt, before any folder is loaded (classic: resolve and init the repo). */
  prepareStorageBeforeLoadingFolders(): Promise<void>;

  /**
   * Store the table spec the job just fetched from the connector (with user overrides applied), for a
   * folder that has a path. Called while loading folders, before any page is fetched. The location is
   * the same key `TableSpecStore.readTableSpec` is later asked for (sync and publish read it back).
   */
  storeFolderTableSpec(location: TableSpecLocation, tableSpec: BaseJsonTableSpec): Promise<void>;

  /** Store the default view the connector built from that spec (only when it built one). */
  storeFolderDefaultView(location: TableSpecLocation, defaultView: TableView): Promise<void>;

  /** Called once per folder, before the connector is asked for the folder's first page. */
  prepareFolderForIncomingRecordPages(folder: PullSinkFolder): Promise<void>;

  /**
   * Persist one connector page. `connectorRecordsInPage` are the records exactly as the connector
   * returned them (Connector Prime Directive: never reshape them). A sink that writes them to files
   * must serialize each record with `formatRecordJson` from `@spinner/shared-types` — the serializer
   * the classic pull writes with — so the bytes on disk are identical across sinks.
   */
  writeConnectorRecordPage(folder: PullSinkFolder, connectorRecordsInPage: ConnectorFile[]): Promise<void>;

  /**
   * Called once per prepared folder when its fetch ends — after the last page, or when the fetch failed —
   * so a sink can drop state it needs only while pages arrive before Phase 2 starts.
   */
  releaseRecordPageWritingStateForFolder(folder: PullSinkFolder): void;

  /** Called once per successfully fetched folder, after all of its pages were written. */
  finishFolderAfterAllRecordPagesWritten(
    folder: PullSinkFolder,
    options: FinishFolderOptions,
  ): Promise<PullSinkFolderChangeSummary>;

  /** Release per-attempt scratch space. Runs in the job's `finally`; must not throw. */
  cleanUpTemporaryStorageAfterPullAttempt(): Promise<void>;

  /** Storage-wide finalization after every folder was handled. Runs even when the pull failed; must not throw. */
  finalizeStorageAfterAllFoldersFinished(): Promise<void>;
}

/** What a `PullSink` factory knows about the job attempt it is creating a sink for. */
export type PullSinkCreationContext = {
  jobId: string;
  /** The one connection every folder of the job belongs to. */
  connectorAccountId: string;
  jobData: PullLinkedFolderFilesJobDefinition['data'];
  abortSignal: AbortSignal;
};

/**
 * Optional override seam for the job handler: when provided, the job writes through the returned sink
 * instead of the default `ClassicGitPullSink`.
 */
export type PullSinkFactory = (creationContext: PullSinkCreationContext) => PullSink;
