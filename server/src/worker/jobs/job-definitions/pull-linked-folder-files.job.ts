import { Prisma, type PrismaClient } from '@prisma/client';
import {
  DataFolderId,
  type DataFolderOptions,
  isGenericApiConnectorExtras,
  type JobTrigger,
  JobType,
  type PulledRecordWarning,
  type PullFolderProgress,
  type PullLinkedFolderFilesPublicProgress,
  type WorkbookId,
} from '@spinner/shared-types';
import type { ExperimentsService } from '../../../experiments/experiments.service';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import {
  type BaseJsonTableSpec,
  type ConnectorErrorDetails,
  type ConnectorFile,
  dotPath,
  type PullRecordFilesOptions,
  type PullRecordFilesResult,
} from '../../../remote-service/connectors/types';
import type { JsonSafeObject } from '../../../utils/objects';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
// Non type imports
import { AssetExtractorService } from 'src/asset/asset-extractor.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
import type { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import type { Connector } from 'src/remote-service/connectors/connector';
import { connectorRegistry } from 'src/remote-service/connectors/connector-registry';
import { Service as ServiceConst } from 'src/remote-service/connectors/service-constants';
import { isTransientRemoteServiceFailure } from 'src/remote-service/connectors/transient-remote-service-failure';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { extractApiDomain } from 'src/utils/urls';
import { JobCanceledError } from 'src/worker/job-errors';
import { WSLogger } from '../../../logger';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { ClassicGitPullSink } from './pull-sink/classic-git-pull-sink';
import type {
  PullSink,
  PullSinkCreationContext,
  PullSinkFactory,
  PullSinkFolderChangeSummary,
} from './pull-sink/pull-sink';

// `PullLinkedFolderFilesPublicProgress` (and its per-folder `PullFolderProgress`) now live in
// `@spinner/shared-types` so the web client, desktop app, and CLI render it without a shadow copy.
// Re-exported here so the many existing `from '...pull-linked-folder-files.job'` importers are unchanged.
export type { PullFolderProgress, PullLinkedFolderFilesPublicProgress };

export type PullLinkedFolderFilesJobDefinition = JobDefinitionBuilder<
  typeof JobType.PullLinkedFolderFiles,
  {
    workbookId: WorkbookId;
    dataFolderIds: DataFolderId[];
    userId: string;
    organizationId: string;
    trigger?: JobTrigger;
    /**
     * Requested pull mode for the job. Omitted → `'full'` (the safe default
     * matching pre-incremental behavior). Only `'incremental'` is opt-in via
     * the `INCREMENTAL_PULL` schedule action, the HTTP `mode=incremental`
     * parameter, or the CLI `--mode incremental` flag. Per-folder demotion to
     * `'full'` still happens at execution time (capability, bootstrap) — see
     * `loadFolderAndConnector`.
     */
    pullMode?: 'full' | 'incremental';
    progress?: JsonSafeObject;
    initialPublicProgress?: PullLinkedFolderFilesPublicProgress;
    /**
     * Set when this job is a step of a Live Export routine run that uses the run-store engine: the key
     * (`le-<routineRunId>`) of the run's disposable run store on scratch-git. Absent → the classic
     * engine (git + Postgres). See docs/plans/2026-09-25-live-export-git-free-run-store.
     */
    liveExportRunStoreKey?: string;
  },
  PullLinkedFolderFilesPublicProgress,
  PullLinkedFolderFilesJobProgress,
  void
>;

/** Maximum number of file paths to track per category in progress (for UI display). */
const MAX_PROGRESS_PATHS = 100;

/**
 * Most records one folder's pull may keep in a degraded form. Every one is listed on the folder's progress (a
 * routine's sync leaves each listed record out), so past this many the folder fails instead: the list stays small
 * enough to checkpoint after every page, and that many degraded records points at a broken connection (e.g. an
 * access change on the service), not a few odd records.
 */
const MAX_DEGRADED_RECORDS_PER_FOLDER = 100;

/** A folder's pull kept more than {@link MAX_DEGRADED_RECORDS_PER_FOLDER} records in a degraded form. */
class TooManyDegradedRecordsInFolderError extends Error {}

const LOG_SOURCE = 'PullLinkedFolderFilesJob';

/** Default max parallel folder fetches when no rate limiter spec is defined. */
const DEFAULT_CONCURRENCY = 3;

/**
 * How long a folder fetch that failed transiently (see `isTransientRemoteServiceFailure`) waits before each retry,
 * indexed by how many retries in a row have failed without the fetch getting any further. Its length is how many
 * such retries a fetch gets before the folder fails. Long enough for a service's brief outage or a deploy to pass;
 * short next to the pull itself.
 */
const TRANSIENT_FOLDER_FETCH_FAILURE_RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

/**
 * The most retries one folder fetch gets in total. The retry budget above starts over whenever a retry gets further
 * than the one before, so a long fetch survives several separate blips; this stops a connection that fails every few
 * pages from retrying forever.
 */
const MAX_TRANSIENT_FOLDER_FETCH_FAILURE_RETRIES_PER_FOLDER = 10;

type PullLinkedFolderFilesJobProgress = {
  completedFolderIds?: string[];
  phase?: 'fetch' | 'process';
  folderFetchStatus?: Record<string, 'pending' | 'fetching' | 'fetched' | 'failed'>;
  folderCursors?: Record<string, JsonSafeObject>;
};

type CheckpointFn = (
  progress: Omit<
    Progress<PullLinkedFolderFilesJobDefinition['publicProgress'], PullLinkedFolderFilesJobProgress>,
    'timestamp'
  >,
) => Promise<void>;

/**
 * Copy of a pull's `publicProgress` with every path list emptied — the run-wide aggregate and each
 * per-folder entry. Intermediate checkpoints (per fetched page, per committed batch) send this slim
 * form: the path lists exist only for the web job-detail file list, they can reach
 * folderCount × 3 × MAX_PROGRESS_PATHS entries, and re-serializing them into the Redis job hash and
 * the Postgres row on every page is what bloated checkpoint payloads in the 2026-07-10 Redis OOM
 * incident. Counts, statuses, folder errors, and resume state (`jobProgress`) are untouched, so
 * live UI counters and job resume behave exactly as before. Only the terminal checkpoint in
 * `postProcess()` sends the full object, so finished jobs still render their file lists.
 */
function withEmptyPathListsForIntermediateCheckpoint(
  fullPublicProgress: PullLinkedFolderFilesPublicProgress,
): PullLinkedFolderFilesPublicProgress {
  return {
    ...fullPublicProgress,
    createdPaths: [],
    updatedPaths: [],
    deletedPaths: [],
    folders: fullPublicProgress.folders.map((folderProgressEntry) => ({
      ...folderProgressEntry,
      createdPaths: [],
      updatedPaths: [],
      deletedPaths: [],
    })),
  };
}

/** Context shared across all phases of pulling a single folder. */
type FolderContext = {
  jobId: string;
  dataFolder: {
    id: DataFolderId;
    workbookId: string;
    name: string;
    path: string | null;
    connectorService: string;
    connectorAccountId: string;
  };
  connector: Connector;
  tableSpec: BaseJsonTableSpec;
  pullOptions: DataFolderOptions;
  /**
   * Pull mode after per-folder resolution: starts from `data.pullMode`, then
   * demoted to `'full'` if the connector reports no incremental support, or the
   * folder has no completed full-pull baseline yet — i.e. `lastFullPullAt` or
   * `lastIncrementalPullAt` is null (bootstrap).
   */
  effectiveMode: 'full' | 'incremental';
  /** Captured before the connector call so we can persist it as the watermark on success. */
  pullStartedAt: Date;
  /** Last-incremental watermark from the previous successful run. Non-null only when `effectiveMode === 'incremental'`. */
  since: Date | null;
  /** Connector-opaque cross-run cursor from the previous run. Distinct from mid-run pagination progress. */
  resumeCursor: JsonSafeObject | null;
};

/**
 * Result from Phase 1 fetch for a single folder. The folder's fetched-record count isn't carried here: it
 * lives on the folder's `publicProgress.folders[]` entry, counted page by page across every attempt.
 */
type FolderFetchResult = {
  folderId: DataFolderId;
  isResuming: boolean;
  /** New watermark returned by the connector (or `pullStartedAt` as fallback) for incremental runs. */
  newWatermark?: Date;
  /** New cross-run cursor returned by the connector for incremental runs that use opaque tokens. */
  newCursor?: JsonSafeObject | null;
};

/**
 * Pull job handler with two-phase architecture:
 *
 * Phase 1 (FETCH): All folders fetch from their connector API in parallel.
 *   Each page is handed to the run's `PullSink` (classic: staged on scratch-git-2's disk,
 *   no git commits or DB index updates during this phase).
 *
 * Phase 2 (PROCESS): For each folder sequentially, the `PullSink` finishes the folder
 *   (classic: read staged files back, run DB index updates, commit to git, delete stale
 *   files), then the job finalizes it (lock, watermark/cursor, events).
 *
 * Storage lives behind `PullSink` (see `./pull-sink/pull-sink.ts`); everything in this class is
 * orchestration shared by every sink.
 */
export class PullLinkedFolderFilesJobHandler implements JobHandlerBuilder<PullLinkedFolderFilesJobDefinition> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly connectorService: ConnectorsService,
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly workbookEventService: WorkbookEventService,
    private readonly scratchGitService: ScratchGitService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly assetExtractorService: AssetExtractorService,
    private readonly assetIndexService: AssetIndexService,
    private readonly postHogService: PostHogService,
    private readonly experimentsService: ExperimentsService,
    /** Optional override of where pulled records are written. Omitted → `ClassicGitPullSink`. */
    private readonly createPullSinkOverride?: PullSinkFactory,
  ) {}

  /** The sink this job attempt writes through: the override when one was injected, else the classic git pipeline. */
  private createPullSinkForJobAttempt(creationContext: PullSinkCreationContext): PullSink {
    if (this.createPullSinkOverride) {
      return this.createPullSinkOverride(creationContext);
    }
    return new ClassicGitPullSink(
      {
        prisma: this.prisma,
        scratchGitService: this.scratchGitService,
        fileIndexService: this.fileIndexService,
        fileReferenceService: this.fileReferenceService,
        assetExtractorService: this.assetExtractorService,
        assetIndexService: this.assetIndexService,
        workbookEventService: this.workbookEventService,
      },
      {
        jobId: creationContext.jobId,
        workbookId: creationContext.jobData.workbookId,
        connectorAccountId: creationContext.connectorAccountId,
        abortSignal: creationContext.abortSignal,
      },
    );
  }

  async run(params: {
    jobId: string;
    data: PullLinkedFolderFilesJobDefinition['data'];
    progress: Progress<PullLinkedFolderFilesJobDefinition['publicProgress'], PullLinkedFolderFilesJobProgress>;
    abortSignal: AbortSignal;
    checkpoint: CheckpointFn;
  }) {
    const { jobId, data, checkpoint, progress, abortSignal } = params;
    if (!data?.dataFolderIds?.length) {
      throw new Error(`Invalid job data: dataFolderIds is ${JSON.stringify(data?.dataFolderIds)}`);
    }
    const folderCount = data.dataFolderIds.length;

    // The job's requested pull mode. Per-folder demotions (capability check,
    // bootstrap) apply on top of this during folder resolution.
    const requestedMode: 'full' | 'incremental' = data.pullMode ?? 'full';

    // Fetch all folders upfront to validate they share the same connection
    const folders = await this.prisma.dataFolder.findMany({
      where: { id: { in: data.dataFolderIds } },
      include: { connectorAccount: true },
    });

    const connectorAccountIds = new Set(folders.map((f) => f.connectorAccountId));
    if (connectorAccountIds.size > 1) {
      throw new Error(
        `All folders in a pull job must belong to the same connection, got: ${[...connectorAccountIds].join(', ')}`,
      );
    }

    // The single-connection invariant above means every folder shares this account.
    const connectorAccount = folders[0]?.connectorAccount;
    const connectorAccountId = folders[0]?.connectorAccountId ?? null;
    const connectionName = connectorAccount?.displayName ?? 'Unknown connection';

    if (!connectorAccountId || !connectorAccount) {
      throw new Error(`All folders in pull job must belong to a connection`);
    }

    // Capture the GENERIC_API base domain (if applicable) so the trackPullCompleted
    // event at the end of postProcess can break analytics down by third-party API.
    let apiDomain: string | undefined;
    if (connectorAccount.service === ServiceConst.GENERIC_API && isGenericApiConnectorExtras(connectorAccount.extras)) {
      const firstEndpointUrl = connectorAccount.extras.endpoints[0]?.url;
      if (firstEndpointUrl) apiDomain = extractApiDomain(firstEndpointUrl);
    }

    // Per-user gate for the GENERIC_API connector. The pull job is the single
    // chokepoint for web-, CLI-, and scheduler-triggered pulls, so this is
    // where the kill switch has to live to catch all of them. Fail-closed: if
    // ENABLE_GENERIC_CONNECTOR is not explicitly true for the triggering user,
    // the job aborts before any IO.
    if (connectorAccount.service === ServiceConst.GENERIC_API) {
      const enabled = await this.experimentsService.isGenericConnectorEnabledForUser(data.userId);
      if (!enabled) {
        throw new Error('The Generic API connector is not enabled — pull aborted.');
      }
    }

    const pullSink = this.createPullSinkForJobAttempt({ jobId, jobData: data, abortSignal, connectorAccountId });
    await pullSink.prepareStorageBeforeLoadingFolders();

    // Load all folder contexts upfront — per-folder failures are non-fatal
    const folderContexts: FolderContext[] = [];
    const failedFolderIds: DataFolderId[] = [];
    for (const dataFolderId of data.dataFolderIds) {
      try {
        const folderCtx = await this.loadFolderAndConnector({
          dataFolderId,
          pullSink,
          data,
          jobId,
          requestedMode,
        });
        folderContexts.push(folderCtx);
      } catch (error) {
        failedFolderIds.push(dataFolderId);

        WSLogger.error({
          source: LOG_SOURCE,
          message: 'Failed to load folder context',
          workbookId: data.workbookId,
          dataFolderId,
          error,
        });

        // Clear any lock so the folder can be re-pulled
        await this.prisma.dataFolder.update({ where: { id: dataFolderId }, data: { lock: null } }).catch(() => {});

        this.workbookEventService.sendWorkbookEvent(data.workbookId, {
          type: 'job-failed',
          data: {
            entityId: dataFolderId,
            source: 'job',
            message: 'Pull failed for data folder',
            jobId,
          },
        });
      }
    }

    if (folderContexts.length === 0) {
      throw new Error('All folders failed to load — nothing to pull');
    }

    // Determine max concurrency from connector's rate limiter spec
    const connectorService = folderContexts[0].dataFolder.connectorService;
    const maxConcurrency = getMaxConcurrency(connectorService, folderCount);

    WSLogger.info({
      source: LOG_SOURCE,
      message: `Starting pull: ${folderCount} folders, concurrency ${maxConcurrency}`,
      workbookId: data.workbookId,
      folderCount,
      maxConcurrency,
    });

    const jobProgress: PullLinkedFolderFilesJobProgress = {
      completedFolderIds: [...(progress.jobProgress?.completedFolderIds ?? [])],
      phase: 'fetch',
      folderFetchStatus: progress.jobProgress?.folderFetchStatus ?? {},
      folderCursors: progress.jobProgress?.folderCursors ?? {},
    };

    // Mark folders that failed during context loading
    const folderFetchStatus = jobProgress.folderFetchStatus;
    if (folderFetchStatus) {
      for (const folderId of failedFolderIds) {
        folderFetchStatus[folderId] = 'failed';
      }
    }
    const pullFailed = failedFolderIds.length > 0;

    const publicProgress: PullLinkedFolderFilesPublicProgress = {
      totalFiles: 0,
      folderCount,
      connectionName,
      folderId: folderContexts[0].dataFolder.id,
      folderName: folderContexts[0].dataFolder.name,
      connector: connectorService,
      filter: null,
      status: 'active',
      dataFolderIds: folderContexts.map((fc) => fc.dataFolder.id),
      createdPaths: [],
      updatedPaths: [],
      deletedPaths: [],
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
      folders: [],
      ...(pullSink.reportsRecordChangeCounts ? {} : { reportsOnlyFetchedRecordCount: true }),
    };

    // Per-folder breakdown — one entry per target folder, parallel to the sync job's `tables`. Seeded
    // for EVERY folder (including any that failed to load) so the UI shows a row per folder; each
    // entry's counts/status are filled in as the folder is fetched (Phase 1) and processed (Phase 2).
    publicProgress.folders = data.dataFolderIds.map((dataFolderId): PullFolderProgress => {
      const folderRow = folders.find((folder) => folder.id === dataFolderId);
      return {
        id: dataFolderId,
        name: folderRow?.name ?? dataFolderId,
        connector: folderRow?.connectorService ?? connectorService,
        creates: 0,
        updates: 0,
        deletes: 0,
        totalFiles: 0,
        createdPaths: [],
        updatedPaths: [],
        deletedPaths: [],
        status: 'pending',
      };
    });
    for (const failedFolderId of failedFolderIds) {
      const entry = publicProgress.folders.find((folder) => folder.id === failedFolderId);
      if (entry) entry.status = 'failed';
    }

    const pullStats = { created: 0, updated: 0, deleted: 0, failed: pullFailed };

    // A stalled job handed to a new worker resumes from its last checkpoint's cursors and completed
    // folders, so its counts must resume from that same checkpoint too — not drop back to zero.
    restoreCountersFromPreviousAttemptCheckpoint({
      progressHandedToThisAttempt: progress,
      publicProgress,
      pullStats,
      jobProgress,
      folderIdsThatFailedToLoadThisAttempt: failedFolderIds,
    });

    // Both phases checkpoint through this wrapper, which strips the accumulated path lists from
    // every intermediate write. The full `publicProgress` (with paths) is checkpointed exactly
    // once, by `postProcess()` in the finally below — the job's terminal checkpoint.
    const checkpointOmittingPathLists: CheckpointFn = async (progressToCheckpoint) =>
      checkpoint({
        ...progressToCheckpoint,
        publicProgress: withEmptyPathListsForIntermediateCheckpoint(progressToCheckpoint.publicProgress),
      });

    try {
      // =====================================================================
      // PHASE 1 — FETCH (parallel)
      // =====================================================================
      jobProgress.phase = 'fetch';
      await checkpointOmittingPathLists({ publicProgress, jobProgress, connectorProgress: {} });

      const fetchResults = await this.runPhase1Fetch({
        folderContexts,
        maxConcurrency,
        jobId,
        publicProgress,
        jobProgress,
        pullStats,
        checkpoint: checkpointOmittingPathLists,
        abortSignal,
        pullSink,
      });

      // =====================================================================
      // PHASE 2 — PROCESS (sequential)
      // =====================================================================
      jobProgress.phase = 'process';
      await checkpointOmittingPathLists({ publicProgress, jobProgress, connectorProgress: {} });

      await this.runPhase2Process({
        folderContexts,
        fetchResults,
        jobId,
        publicProgress,
        jobProgress,
        pullStats,
        checkpoint: checkpointOmittingPathLists,
        abortSignal,
        pullSink,
      });
    } finally {
      // Defensive backstop: clear locks on any folder that still has lock='pull'.
      // The per-error-path cleanup should have handled this, but this catches any
      // future code path that forgets to clear a lock.
      for (const folderCtx of folderContexts) {
        const folderId = folderCtx.dataFolder.id;
        const wasCompleted = jobProgress.completedFolderIds?.includes(folderId);
        const wasFailed = jobProgress.folderFetchStatus?.[folderId] === 'failed';
        if (!wasCompleted && !wasFailed) {
          try {
            await this.prisma.dataFolder.update({
              where: { id: folderId },
              data: { lock: null },
            });
          } catch (err) {
            WSLogger.warn({
              source: LOG_SOURCE,
              message: 'Failed to clear lock in finally backstop',
              dataFolderId: folderId,
              error: err,
            });
          }
        }
      }

      // Always clean up the sink's temporary storage (classic: staging), even on failure
      await pullSink.cleanUpTemporaryStorageAfterPullAttempt();

      // Post-processing: storage finalization (classic: rebase, GC, index rebuild, record counts), tracking.
      // Runs even if some folders failed so successful folders get finalized.
      await this.postProcess({
        pullSink,
        data,
        publicProgress,
        jobProgress,
        pullStats,
        folderCount,
        checkpoint,
        connectorService: connectorAccount.service,
        connectorAccountId,
        apiDomain,
      });
    }
  }

  private async postProcess(params: {
    pullSink: PullSink;
    data: PullLinkedFolderFilesJobDefinition['data'];
    publicProgress: PullLinkedFolderFilesPublicProgress;
    jobProgress: PullLinkedFolderFilesJobProgress;
    pullStats: { created: number; updated: number; deleted: number; failed: boolean };
    folderCount: number;
    checkpoint: CheckpointFn;
    /** Connector type of the (single) connection this job pulled — required for per-service breakdowns. */
    connectorService: string;
    /** Connection id — matches dataSourceId on connector_created for join-able analytics. */
    connectorAccountId: string;
    /** Set when the pulled connection is GENERIC_API; passed through to trackPullCompleted. */
    apiDomain?: string;
  }) {
    const {
      pullSink,
      data,
      publicProgress,
      jobProgress,
      pullStats,
      folderCount,
      checkpoint,
      connectorService,
      connectorAccountId,
      apiDomain,
    } = params;

    // Terminal checkpoint — the ONE write that carries the full path lists (created/updated/
    // deleted, aggregate + per-folder). Every earlier checkpoint went through
    // checkpointOmittingPathLists; this runs in run()'s finally, so finished AND failed pulls
    // get their file lists attached for the job-detail view.
    await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });

    // Storage-wide finalization (classic: rebase dirty, GC, rebuild the repo index, refresh record
    // counts). Non-fatal by contract — the sink logs and swallows its own failures.
    await pullSink.finalizeStorageAfterAllFoldersFinished();

    try {
      this.postHogService.trackPullCompleted(data.userId, {
        workbookId: data.workbookId,
        connectorService,
        connectorAccountId,
        trigger: data.trigger,
        mode: data.pullMode ?? 'full',
        result: pullStats.failed ? 'failure' : 'success',
        totalFilesPulled: publicProgress.totalFiles,
        filesCreated: pullStats.created,
        filesUpdated: pullStats.updated,
        filesDeleted: pullStats.deleted,
        foldersProcessed: folderCount,
        apiDomain,
      });
    } catch (err) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to track pull completed event',
        error: err,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Load folder from DB, set up connector and fetch fresh schema
  // ---------------------------------------------------------------------------

  private async loadFolderAndConnector(params: {
    dataFolderId: DataFolderId;
    pullSink: PullSink;
    data: PullLinkedFolderFilesJobDefinition['data'];
    jobId: string;
    /**
     * Pull mode requested for this job. Per-folder demotions (capability,
     * bootstrap) apply on top of this.
     */
    requestedMode: 'full' | 'incremental';
  }): Promise<FolderContext> {
    const { dataFolderId, pullSink, data, jobId, requestedMode } = params;

    const dataFolder = await this.prisma.dataFolder.findUnique({
      where: { id: dataFolderId },
      include: { connectorAccount: true },
    });

    if (!dataFolder) {
      throw new Error(`DataFolder with id ${dataFolderId} not found`);
    }
    if (!dataFolder.connectorAccountId) {
      throw new Error(`DataFolder ${dataFolderId} does not have an associated connector account`);
    }
    if (!dataFolder.connectorService) {
      throw new Error(`DataFolder ${dataFolderId} does not have a connector service`);
    }

    const pullOptions: DataFolderOptions = (dataFolder.options as DataFolderOptions) ?? {};

    const decryptedConnectorAccount = await this.connectorAccountService.findOneByIdUnscoped(
      dataFolder.connectorAccountId,
      {
        userId: data.userId,
        organizationId: data.organizationId,
      },
    );
    if (!decryptedConnectorAccount) {
      throw new Error(`Connector account ${dataFolder.connectorAccountId} not found`);
    }

    const connector = await this.connectorService.getConnector({
      service: dataFolder.connectorService,
      connectorAccount: decryptedConnectorAccount,
      decryptedCredentials: decryptedConnectorAccount,
      userId: data.userId,
    });

    const tableSpec = await connector.fetchJsonTableSpec({
      wsId: dataFolder.tableId[0],
      remoteId: dataFolder.tableId,
    });

    // Re-apply user field overrides from options
    const options =
      dataFolder.options && typeof dataFolder.options === 'object' && !Array.isArray(dataFolder.options)
        ? dataFolder.options
        : {};
    const idOverride = 'idFieldOverride' in options ? (options as Record<string, unknown>).idFieldOverride : undefined;
    const nameOverride =
      'nameFieldOverride' in options ? (options as Record<string, unknown>).nameFieldOverride : undefined;
    if (typeof idOverride === 'string') {
      tableSpec.idPath = dotPath(idOverride);
    }
    if (typeof nameOverride === 'string') {
      tableSpec.titlePath = dotPath(nameOverride);
    }

    // The user's idFieldOverride resolves a spec whose own idPath is
    // untrustworthy (see BaseJsonTableSpec.idPathRequiresUserSelection). Marker
    // with NO override — e.g. the source view was redefined and lost its unique
    // column after the folder was created — fails the pull loudly rather than
    // addressing records by the legacy fallback.
    if (tableSpec.idPathRequiresUserSelection) {
      if (typeof idOverride !== 'string') {
        throw new Error(
          `The table backing folder "${dataFolder.path}" has no automatically-detectable unique ID column and no ID field override is configured. Re-add the folder choosing an ID field, or restore a unique column on the source.`,
        );
      }
      delete tableSpec.idPathRequiresUserSelection;
    }

    // Store the refreshed schema, then the default view the connector builds from it
    if (dataFolder.path) {
      const tableSpecLocation = { connectorAccountId: dataFolder.connectorAccountId, folderPath: dataFolder.path };
      await pullSink.storeFolderTableSpec(tableSpecLocation, tableSpec);
      const defaultView = connector.buildDefaultView(tableSpec);
      if (defaultView) {
        await pullSink.storeFolderDefaultView(tableSpecLocation, defaultView);
      }
    }

    // ---- Resolve effective pull mode per folder ----
    // The kill-switch gate has already been applied in `run()` — `requestedMode`
    // is the post-gate mode. Per-folder demotions stack on top:
    //   1. Connector capability check (passed both options + tableSpec so it
    //      can consult per-folder config and schema annotations).
    //   2. Bootstrap: an incremental pull is only valid once a full pull has
    //      established a complete baseline (`lastFullPullAt`) AND left a
    //      watermark to filter from (`lastIncrementalPullAt`). If either is
    //      null we run full once so future runs can actually go incremental.
    let effectiveMode: 'full' | 'incremental' = requestedMode;
    // A sink whose storage starts empty every run has no baseline to extend: always pull fully.
    if (effectiveMode === 'incremental' && !pullSink.persistsIncrementalPullBaseline) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'Demoting incremental pull to full: this pull writes to storage that starts empty every run',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
      });
      effectiveMode = 'full';
    }
    const lastFullPullAt = dataFolder.lastFullPullAt ?? null;
    const lastIncrementalPullAt = dataFolder.lastIncrementalPullAt ?? null;
    const incrementalCursor = (dataFolder.incrementalCursor as JsonSafeObject | null | undefined) ?? null;

    if (effectiveMode === 'incremental' && !connector.supportsIncrementalPull(pullOptions, tableSpec)) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'Demoting incremental pull to full: connector reports no incremental support for this folder',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
        connectorService: dataFolder.connectorService,
      });
      effectiveMode = 'full';
    }
    // A folder can carry an incremental watermark without ever having completed
    // a full pull (e.g. migrated/backfilled state, or a future path that
    // advances the watermark independently). Running incremental there would
    // silently miss every record older than the watermark, so demote to full
    // whenever there is no completed full-pull baseline — or no watermark to
    // filter from, which keeps `since` (below) non-null when we do go incremental.
    if (effectiveMode === 'incremental' && (lastFullPullAt === null || lastIncrementalPullAt === null)) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'Demoting incremental pull to full: no completed full pull to use as a baseline',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
      });
      effectiveMode = 'full';
    }

    return {
      jobId,
      dataFolder: {
        id: dataFolder.id as DataFolderId,
        workbookId: dataFolder.workbookId,
        name: dataFolder.name,
        path: dataFolder.path,
        connectorService: dataFolder.connectorService,
        connectorAccountId: dataFolder.connectorAccountId,
      },
      connector,
      tableSpec,
      pullOptions,
      effectiveMode,
      pullStartedAt: new Date(),
      since: effectiveMode === 'incremental' ? lastIncrementalPullAt : null,
      resumeCursor: effectiveMode === 'incremental' ? incrementalCursor : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Parallel fetch — stage files to scratch-git-2 disk
  // ---------------------------------------------------------------------------

  private async runPhase1Fetch(params: {
    folderContexts: FolderContext[];
    maxConcurrency: number;
    jobId: string;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    jobProgress: PullLinkedFolderFilesJobProgress;
    pullStats: { created: number; updated: number; deleted: number; failed: boolean };
    checkpoint: CheckpointFn;
    abortSignal: AbortSignal;
    pullSink: PullSink;
  }): Promise<Map<DataFolderId, FolderFetchResult>> {
    const {
      folderContexts,
      maxConcurrency,
      jobId,
      publicProgress,
      jobProgress,
      pullStats,
      checkpoint,
      abortSignal,
      pullSink,
    } = params;

    const results = new Map<DataFolderId, FolderFetchResult>();

    await runWithConcurrency(folderContexts, maxConcurrency, async (folderCtx) => {
      if (abortSignal.aborted) return;

      const folderId = folderCtx.dataFolder.id;
      const fetchStatus = jobProgress.folderFetchStatus?.[folderId];

      // Skip already-fetched folders on resume
      if (fetchStatus === 'fetched') {
        WSLogger.info({
          source: LOG_SOURCE,
          message: 'Skipping already-fetched folder on resume',
          dataFolderId: folderId,
        });
        // We don't have pulledPaths from the previous run — mark as resuming
        results.set(folderId, { folderId, isResuming: true });
        // `publicProgress` is rebuilt on a resumed attempt (only its counts are carried over, by
        // restoreCountersFromPreviousAttemptCheckpoint), so this folder's entry is back to 'pending'
        // even though a previous attempt already worked on it. Restore what it really is:
        // done if Phase 2 already processed it (Phase 2 will skip it below), otherwise still in flight.
        const resumedFolderEntry = findFolderProgress(publicProgress, folderId);
        if (resumedFolderEntry) {
          resumedFolderEntry.status = jobProgress.completedFolderIds?.includes(folderId) ? 'completed' : 'active';
        }
        return;
      }

      jobProgress.folderFetchStatus = jobProgress.folderFetchStatus ?? {};
      jobProgress.folderFetchStatus[folderId] = 'fetching';

      // Flip the folder's public status to 'active' for the rest of the pull — it stays active through
      // Phase 2, which is what finally marks it 'completed'. Without this a folder reads 'pending' for
      // the whole run and a live view can't tell which folders are actually being worked on.
      const fetchingFolderEntry = findFolderProgress(publicProgress, folderId);
      if (fetchingFolderEntry) {
        fetchingFolderEntry.status = 'active';
      }

      // The folder's fetched count and warnings as they stood when its cursor was last checkpointed. A retry after
      // a transient failure resumes from that cursor, so it rewinds the folder's progress to these (see
      // readFolderFetchResumePoint). At the start of the fetch they pair with the cursor it starts from:
      // restoreCountersFromPreviousAttemptCheckpoint restored them for exactly that cursor.
      let folderProgressAtLastCheckpointedCursor = snapshotFolderFetchProgress(fetchingFolderEntry);

      try {
        const resumeProgress = jobProgress.folderCursors?.[folderId] ?? {};
        const result = await this.fetchFolder({
          folderCtx,
          jobId,
          pullSink,
          resumeProgress,
          readResumePointForRetry: () =>
            readFolderFetchResumePoint({
              lastCheckpointedConnectorCursor: jobProgress.folderCursors?.[folderId],
              folderProgressAtLastCheckpointedCursor,
              fetchingFolderEntry,
              publicProgress,
            }),
          onBatchCheckpoint: async (update) => {
            // The run-wide count, this folder's count, its warnings, and its cursor all advance in one
            // synchronous step, so every checkpoint pairs a cursor with exactly the records (and warnings)
            // fetched up to it. That pairing is what lets a resumed attempt restore them
            // (see restoreCountersFromPreviousAttemptCheckpoint).
            publicProgress.totalFiles += update.fileCount;
            if (fetchingFolderEntry) {
              fetchingFolderEntry.totalFiles += update.fileCount;
            }
            if (update.recordWarnings.length > 0) {
              WSLogger.warn({
                source: LOG_SOURCE,
                message: 'Connector pulled records in a degraded form',
                workbookId: folderCtx.dataFolder.workbookId,
                dataFolderId: folderId,
                recordWarnings: update.recordWarnings,
              });
              if (fetchingFolderEntry) {
                addPulledRecordWarningsToFolderProgress(fetchingFolderEntry, update.recordWarnings);
              }
            }
            if (update.cursor) {
              jobProgress.folderCursors = jobProgress.folderCursors ?? {};
              jobProgress.folderCursors[folderId] = update.cursor;
              folderProgressAtLastCheckpointedCursor = snapshotFolderFetchProgress(fetchingFolderEntry);
            }
            await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });
          },
          abortSignal,
        });
        results.set(folderId, result);
        jobProgress.folderFetchStatus[folderId] = 'fetched';
      } catch (error) {
        // Let cancellation errors propagate — they're not folder failures
        if (error instanceof JobCanceledError) throw error;

        jobProgress.folderFetchStatus[folderId] = 'failed';
        pullStats.failed = true;

        // Too many degraded records is the job's own verdict, already worded for the user — not a connector error.
        const phase1ErrorDetails =
          error instanceof TooManyDegradedRecordsInFolderError
            ? { userFriendlyMessage: error.message, description: error.message }
            : folderCtx.connector.extractConnectorErrorDetails(error);

        WSLogger.error({
          source: LOG_SOURCE,
          message: 'Phase 1 fetch failed for folder',
          workbookId: folderCtx.dataFolder.workbookId,
          dataFolderId: folderId,
          errorDetails: phase1ErrorDetails,
        });

        publicProgress.folderErrors = publicProgress.folderErrors ?? {};
        publicProgress.folderErrors[folderId] = {
          folderName: folderCtx.dataFolder.name,
          message: phase1ErrorDetails.userFriendlyMessage,
          details: phase1ErrorDetails.description,
        };

        const failedFolderEntry = findFolderProgress(publicProgress, folderId);
        if (failedFolderEntry) {
          failedFolderEntry.status = 'failed';
          failedFolderEntry.error = publicProgress.folderErrors[folderId];
        }

        // Clear the lock so the folder can be re-pulled
        await this.prisma.dataFolder.update({
          where: { id: folderId },
          data: { lock: null },
        });

        // Notify workbook clients about the per-folder failure
        this.workbookEventService.sendWorkbookEvent(folderCtx.dataFolder.workbookId as WorkbookId, {
          type: 'job-failed',
          data: {
            entityId: folderId,
            source: 'job',
            message: phase1ErrorDetails.userFriendlyMessage,
            jobId,
          },
        });
      }

      await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });
    });

    return results;
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Sequential process — index, commit, delete stale, finalize
  // ---------------------------------------------------------------------------

  private async runPhase2Process(params: {
    folderContexts: FolderContext[];
    fetchResults: Map<DataFolderId, FolderFetchResult>;
    jobId: string;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    jobProgress: PullLinkedFolderFilesJobProgress;
    pullStats: { created: number; updated: number; deleted: number; failed: boolean };
    checkpoint: CheckpointFn;
    abortSignal: AbortSignal;
    pullSink: PullSink;
  }): Promise<void> {
    const {
      folderContexts,
      fetchResults,
      jobId,
      publicProgress,
      jobProgress,
      pullStats,
      checkpoint,
      abortSignal,
      pullSink,
    } = params;

    for (const folderCtx of folderContexts) {
      if (abortSignal.aborted) break;

      const fetchResult = fetchResults.get(folderCtx.dataFolder.id);
      if (!fetchResult || jobProgress.folderFetchStatus?.[folderCtx.dataFolder.id] === 'failed') {
        continue;
      }

      if (jobProgress.completedFolderIds?.includes(folderCtx.dataFolder.id)) {
        continue;
      }

      try {
        // Update publicProgress to show current folder
        publicProgress.folderId = folderCtx.dataFolder.id;
        publicProgress.folderName = folderCtx.dataFolder.name;
        publicProgress.mode = folderCtx.effectiveMode;

        const result = await this.processFolder({
          folderCtx,
          fetchResult,
          jobId,
          pullSink,
          checkpoint,
          publicProgress,
          jobProgress,
        });

        // Merge results into shared progress state
        pullStats.created += result.created;
        pullStats.updated += result.updated;
        pullStats.deleted += result.deleted;

        publicProgress.createdCount += result.created;
        publicProgress.updatedCount += result.updated;
        publicProgress.deletedCount += result.deleted;
        for (const path of result.createdPaths) {
          if (publicProgress.createdPaths.length < MAX_PROGRESS_PATHS) {
            publicProgress.createdPaths.push(path);
          }
        }
        for (const path of result.updatedPaths) {
          if (publicProgress.updatedPaths.length < MAX_PROGRESS_PATHS) {
            publicProgress.updatedPaths.push(path);
          }
        }
        for (const path of result.deletedPaths) {
          if (publicProgress.deletedPaths.length < MAX_PROGRESS_PATHS) {
            publicProgress.deletedPaths.push(path);
          }
        }

        publicProgress.status = 'completed';

        // Record this folder's own counts/paths in its per-folder breakdown entry (parallel to the
        // run-wide aggregate updated just above), so the UI can break results down by folder.
        const folderEntry = findFolderProgress(publicProgress, folderCtx.dataFolder.id);
        if (folderEntry) {
          folderEntry.creates = result.created;
          folderEntry.updates = result.updated;
          folderEntry.deletes = result.deleted;
          folderEntry.createdPaths = result.createdPaths.slice(0, MAX_PROGRESS_PATHS);
          folderEntry.updatedPaths = result.updatedPaths.slice(0, MAX_PROGRESS_PATHS);
          folderEntry.deletedPaths = result.deletedPaths.slice(0, MAX_PROGRESS_PATHS);
          folderEntry.mode = folderCtx.effectiveMode;
          folderEntry.status = 'completed';
        }

        jobProgress.completedFolderIds = jobProgress.completedFolderIds ?? [];
        jobProgress.completedFolderIds.push(folderCtx.dataFolder.id);
        await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });
      } catch (error) {
        // Let cancellation errors propagate — they're not folder failures
        if (error instanceof JobCanceledError) throw error;

        pullStats.failed = true;

        const phase2ErrorDetails = folderCtx.connector.extractConnectorErrorDetails(error);

        WSLogger.error({
          source: LOG_SOURCE,
          message: 'Failed to process folder in Phase 2',
          workbookId: folderCtx.dataFolder.workbookId,
          dataFolderId: folderCtx.dataFolder.id,
          errorDetails: phase2ErrorDetails,
        });

        publicProgress.folderErrors = publicProgress.folderErrors ?? {};
        publicProgress.folderErrors[folderCtx.dataFolder.id] = {
          folderName: folderCtx.dataFolder.name,
          message: phase2ErrorDetails.userFriendlyMessage,
          details: phase2ErrorDetails.description,
        };

        const failedFolderEntry = findFolderProgress(publicProgress, folderCtx.dataFolder.id);
        if (failedFolderEntry) {
          failedFolderEntry.status = 'failed';
          failedFolderEntry.error = publicProgress.folderErrors[folderCtx.dataFolder.id];
        }

        await this.prisma.dataFolder.update({
          where: { id: folderCtx.dataFolder.id },
          data: { lock: null },
        });

        this.workbookEventService.sendWorkbookEvent(folderCtx.dataFolder.workbookId as WorkbookId, {
          type: 'job-failed',
          data: {
            entityId: folderCtx.dataFolder.id,
            source: 'job',
            message: phase2ErrorDetails.userFriendlyMessage,
            jobId,
          },
        });
      }
    }

    // If the loop exited due to abort, surface it as a cancellation
    if (abortSignal.aborted) {
      throw new JobCanceledError(jobId);
    }
  }

  private async fetchFolder(params: {
    folderCtx: FolderContext;
    jobId: string;
    pullSink: PullSink;
    resumeProgress: JsonSafeObject;
    /** Where a retry after a transient failure resumes the fetch from (see {@link FolderFetchResumePoint}). */
    readResumePointForRetry: () => FolderFetchResumePoint;
    onBatchCheckpoint: (update: {
      fileCount: number;
      cursor?: JsonSafeObject;
      recordWarnings: PulledRecordWarning[];
    }) => Promise<void>;
    abortSignal: AbortSignal;
  }): Promise<FolderFetchResult> {
    const { folderCtx, jobId, pullSink, readResumePointForRetry, onBatchCheckpoint, abortSignal } = params;
    const { dataFolder, connector, tableSpec, pullOptions } = folderCtx;
    const folderId = dataFolder.id;

    const resumeProgress = params.resumeProgress;
    const isResuming = isResumableConnectorCursor(resumeProgress);

    // Let the sink set up per-folder state before the first page arrives (classic: the FileIndex
    // filename snapshot that seeds collision-free file naming).
    await pullSink.prepareFolderForIncomingRecordPages(folderCtx);

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'job-started',
      data: {
        source: 'job',
        entityId: dataFolder.id,
        message: 'Pulling files for data folder',
        jobId,
      },
    });

    // Build the call-time options bag: persisted folder options + runtime
    // fields the connector needs to choose its branch.
    const callOptions: PullRecordFilesOptions = {
      ...pullOptions,
      pullMode: folderCtx.effectiveMode,
      since: folderCtx.effectiveMode === 'incremental' ? folderCtx.since : null,
      cursor: folderCtx.effectiveMode === 'incremental' ? folderCtx.resumeCursor : null,
    };

    // Retries happen here, between the sink's prepare and release, so the sink keeps everything it learned from the
    // pages already written (classic: every pulled path, for stale-file deletion, and every file name it minted). A
    // retry is therefore one continuous fetch to the sink, and `isResuming` stays what it was when the fetch started.
    let pullResult: PullRecordFilesResult;
    let fetchResumedFromCheckpointedCursorAfterTransientFailure: boolean;
    try {
      ({ pullResult, fetchResumedFromCheckpointedCursorAfterTransientFailure } =
        await fetchFolderRecordsRetryingTransientFailures({
          fetchFolderRecordsFromConnectorCursor: (connectorCursorToFetchFrom) =>
            fetchFolderRecords({
              connector,
              tableSpec,
              callOptions,
              resumeProgress: connectorCursorToFetchFrom,
              writeRecordPage: (connectorRecordsInPage) =>
                pullSink.writeConnectorRecordPage(folderCtx, connectorRecordsInPage),
              onBatchCheckpoint,
              abortSignal,
              jobId: folderCtx.jobId,
            }),
          connectorCursorTheFetchStartsFrom: resumeProgress,
          readResumePointForRetry,
          describeConnectorError: (error) => connector.extractConnectorErrorDetails(error),
          folderCtx,
          abortSignal,
        }));
    } finally {
      pullSink.releaseRecordPageWritingStateForFolder(folderCtx);
    }

    // For incremental: prefer the connector's reported watermark (e.g. server
    // time on the change-feed response) over the job-captured pullStartedAt,
    // but fall back to pullStartedAt if the connector didn't return one.
    //
    // A fetch that resumed from a checkpointed cursor after a transient failure read the pages before that cursor in
    // an earlier connector call, but most connectors stamp their watermark when the call STARTS — so the last call's
    // watermark is later than those pages were read, and a record changed in between would be skipped by every later
    // incremental pull. Such a fetch never stores a watermark later than the job's own start, captured before the
    // first page.
    let newWatermark: Date | undefined;
    if (folderCtx.effectiveMode === 'incremental') {
      const connectorOrJobWatermark = pullResult.newWatermark ?? folderCtx.pullStartedAt;
      newWatermark =
        fetchResumedFromCheckpointedCursorAfterTransientFailure && folderCtx.pullStartedAt < connectorOrJobWatermark
          ? folderCtx.pullStartedAt
          : connectorOrJobWatermark;
    }
    const newCursor = folderCtx.effectiveMode === 'incremental' ? (pullResult.newCursor ?? null) : undefined;

    return { folderId, isResuming, newWatermark, newCursor };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Finish a fetched folder — sink persists (classic: index, commit,
  // delete stale), then the job finalizes (lock, watermark/cursor, events)
  // ---------------------------------------------------------------------------

  private async processFolder(params: {
    folderCtx: FolderContext;
    fetchResult: FolderFetchResult;
    jobId: string;
    pullSink: PullSink;
    checkpoint: CheckpointFn;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    jobProgress: PullLinkedFolderFilesJobProgress;
  }): Promise<PullSinkFolderChangeSummary> {
    const { folderCtx, fetchResult, jobId, pullSink, checkpoint, publicProgress, jobProgress } = params;
    const { dataFolder } = folderCtx;

    // Clear the incremental watermark BEFORE the degraded copies are committed (see finalizeFolder for why):
    // were it only cleared at finalize, a failure or cancel mid-commit would leave them on disk with the old
    // watermark, and no later incremental pull would fetch them again. Clearing early costs at most one extra
    // full pull.
    const folderKeptRecordsInDegradedForm = (findFolderProgress(publicProgress, dataFolder.id)?.warningCount ?? 0) > 0;
    if (folderKeptRecordsInDegradedForm && pullSink.persistsIncrementalPullBaseline) {
      await this.prisma.dataFolder.update({
        where: { id: dataFolder.id },
        data: { lastIncrementalPullAt: null, incrementalCursor: Prisma.DbNull },
      });
    }

    const folderChangeSummary = await pullSink.finishFolderAfterAllRecordPagesWritten(folderCtx, {
      isResumingFromEarlierAttempt: fetchResult.isResuming,
      // Incremental pulls don't delete: the connector only returned records changed since the
      // watermark, so records absent from this pull may be unchanged rather than deleted.
      mayRemoveRecordsAbsentFromThisPull: folderCtx.effectiveMode === 'full',
      reportDurableProgress: () => checkpoint({ publicProgress, jobProgress, connectorProgress: {} }),
    });

    // --- Finalize (clear lock, persist watermark/cursor, send events) ---
    await this.finalizeFolder({ folderCtx, fetchResult, jobId, pullSink, folderKeptRecordsInDegradedForm });

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'folder-contents-changed',
      data: {
        entityId: dataFolder.id,
        source: 'job',
        message: 'Updated data folder progress',
        jobId,
      },
    });

    return folderChangeSummary;
  }

  // ---------------------------------------------------------------------------
  // Shared operations
  // ---------------------------------------------------------------------------

  private async finalizeFolder(params: {
    folderCtx: FolderContext;
    fetchResult: FolderFetchResult;
    jobId: string;
    pullSink: PullSink;
    /** This pull kept some of the folder's records in a degraded form (`PullFolderProgress.warnings`). */
    folderKeptRecordsInDegradedForm: boolean;
  }): Promise<void> {
    const { folderCtx, fetchResult, jobId, pullSink, folderKeptRecordsInDegradedForm } = params;
    const { dataFolder, effectiveMode, pullStartedAt, tableSpec } = folderCtx;

    // Compose the watermark update atomically with clearing the lock so a
    // crash between commit and finalize re-runs the same window next time
    // (idempotent commits absorb the dupes).
    //
    // Full pull: a full scan is a superset of incremental — advancing
    // `lastIncrementalPullAt` to `pullStartedAt` lets a follow-up incremental
    // start from the right point. Clear `incrementalCursor` since any
    // connector-opaque token from a prior incremental run is no longer
    // anchored to that watermark.
    //
    // Incremental pull: advance `lastIncrementalPullAt` to the connector's
    // reported watermark (already resolved in `fetchFolder`, falling back to
    // `pullStartedAt`). Persist `incrementalCursor` if the connector returned
    // one — otherwise leave it unchanged.
    //
    // A pull that kept records in a degraded form instead clears the incremental watermark (and
    // cursor), so the folder's next pull is full: the degraded copies stay on disk, and only the
    // pull that wrote them names them — so a routine's sync leaves them out of that run only. An
    // incremental pull would not fetch them again (unchanged since the watermark, or older than it),
    // and a later run would sync the partial copies. A full pull fetches them again: they are either
    // read in full this time or named again.
    //
    // A sink that isn't the incremental baseline (see `PullSink.persistsIncrementalPullBaseline`)
    // leaves every watermark field as it was.
    const finalizeData: Prisma.DataFolderUpdateInput = {
      lock: null,
      // Keep the deep link to the service's web UI fresh — the connector rebuilds
      // it from the just-fetched table spec, so a changed/added link lands here.
      remoteWebUrl: tableSpec.remoteWebUrl ?? null,
      // Same for the container: rebuilt from the just-fetched spec, so a base or
      // spreadsheet RENAMED on the service follows here on the next pull rather
      // than leaving a stale label in the UI.
      remoteContainerId: tableSpec.remoteContainer?.id ?? null,
      remoteContainerName: tableSpec.remoteContainer?.name ?? null,
      remoteContainerWebUrl: tableSpec.remoteContainer?.remoteWebUrl ?? null,
    };
    if (pullSink.persistsIncrementalPullBaseline) {
      if (folderKeptRecordsInDegradedForm) {
        if (effectiveMode === 'full') {
          finalizeData.lastFullPullAt = pullStartedAt;
        }
        finalizeData.lastIncrementalPullAt = null;
        finalizeData.incrementalCursor = Prisma.DbNull;
      } else if (effectiveMode === 'full') {
        finalizeData.lastFullPullAt = pullStartedAt;
        finalizeData.lastIncrementalPullAt = pullStartedAt;
        finalizeData.incrementalCursor = Prisma.DbNull;
      } else if (fetchResult.newWatermark) {
        finalizeData.lastIncrementalPullAt = fetchResult.newWatermark;
        if (fetchResult.newCursor !== undefined) {
          finalizeData.incrementalCursor =
            fetchResult.newCursor === null ? Prisma.DbNull : (fetchResult.newCursor as Prisma.InputJsonValue);
        }
      }
    }

    await this.prisma.dataFolder.update({
      where: { id: dataFolder.id },
      data: finalizeData,
    });

    WSLogger.debug({
      source: LOG_SOURCE,
      message: 'Pull completed for data folder',
      workbookId: dataFolder.workbookId,
      dataFolderId: dataFolder.id,
    });

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'folder-updated',
      data: {
        entityId: dataFolder.id,
        source: 'job',
        message: 'Updated status of folder',
        jobId,
      },
    });

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'job-completed',
      data: {
        entityId: dataFolder.id,
        source: 'job',
        message: 'Pull completed for data folder',
        jobId,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The connector-fetch half of pulling one folder: ask the connector for every page and hand each page,
 * verbatim, to `writeRecordPage` (the run's `PullSink`), checkpointing the connector cursor after each
 * page. Deliberately free of any storage concern — it knows nothing about git, staging, or indexes — so
 * every `PullSink` gets exactly the same pages in the same order.
 */
async function fetchFolderRecords(params: {
  connector: Connector;
  tableSpec: BaseJsonTableSpec;
  callOptions: PullRecordFilesOptions;
  /** Mid-run pagination progress from a previous attempt of this job; `{}` on a fresh fetch. */
  resumeProgress: JsonSafeObject;
  writeRecordPage: (connectorRecordsInPage: ConnectorFile[]) => Promise<void>;
  onBatchCheckpoint: (update: {
    fileCount: number;
    cursor?: JsonSafeObject;
    recordWarnings: PulledRecordWarning[];
  }) => Promise<void>;
  abortSignal: AbortSignal;
  jobId: string;
}): Promise<PullRecordFilesResult> {
  const { connector, tableSpec, callOptions, resumeProgress, writeRecordPage, onBatchCheckpoint, abortSignal, jobId } =
    params;

  const onBatch = async (callbackParams: {
    files: ConnectorFile[];
    connectorProgress?: JsonSafeObject;
    recordWarnings?: PulledRecordWarning[];
  }) => {
    if (abortSignal.aborted) throw new JobCanceledError(jobId);

    const { files, connectorProgress, recordWarnings } = callbackParams;

    await writeRecordPage(files);

    await onBatchCheckpoint({
      fileCount: files.length,
      cursor: connectorProgress,
      recordWarnings: recordWarnings ?? [],
    });
  };

  return connector.pullRecordFiles(tableSpec, onBatch, resumeProgress, callOptions);
}

/** A folder's fetched-record count and degraded-record warnings at one moment of its fetch. */
type FolderFetchProgressSnapshot = {
  folderFetchedRecordCount: number;
  degradedRecordWarnings: PulledRecordWarning[] | undefined;
  degradedRecordWarningCount: number | undefined;
};

/** Before a folder's fetch has fetched anything: what a fetch that starts over from the first page rewinds to. */
const FOLDER_FETCH_PROGRESS_BEFORE_ANY_PAGE: FolderFetchProgressSnapshot = {
  folderFetchedRecordCount: 0,
  degradedRecordWarnings: undefined,
  degradedRecordWarningCount: undefined,
};

function snapshotFolderFetchProgress(folderProgressEntry: PullFolderProgress | undefined): FolderFetchProgressSnapshot {
  return {
    folderFetchedRecordCount: folderProgressEntry?.totalFiles ?? 0,
    // addPulledRecordWarningsToFolderProgress replaces the array rather than appending to it, so keeping the
    // reference keeps this moment's list.
    degradedRecordWarnings: folderProgressEntry?.warnings,
    degradedRecordWarningCount: folderProgressEntry?.warningCount,
  };
}

/**
 * Where a folder fetch that failed transiently resumes: exactly where a worker restart would resume it, from the
 * cursor last checkpointed for the folder. Resuming anywhere else would make the two recovery paths disagree about
 * what a connector's cursor means.
 */
type FolderFetchResumePoint = {
  /** The cursor to hand the connector: `{}` when the fetch has to start over from the first page. */
  connectorCursorToResumeFrom: JsonSafeObject;
  /**
   * Rewinds the folder's fetched count and warnings, and the run-wide fetched count, to that cursor, so the pages the
   * retry fetches again are not counted twice: to what they were when the cursor was checkpointed, or to nothing when
   * the fetch starts over.
   */
  rewindFolderProgressToResumePoint: () => void;
};

function readFolderFetchResumePoint(params: {
  lastCheckpointedConnectorCursor: JsonSafeObject | undefined;
  folderProgressAtLastCheckpointedCursor: FolderFetchProgressSnapshot;
  fetchingFolderEntry: PullFolderProgress | undefined;
  publicProgress: PullLinkedFolderFilesPublicProgress;
}): FolderFetchResumePoint {
  const {
    lastCheckpointedConnectorCursor,
    folderProgressAtLastCheckpointedCursor,
    fetchingFolderEntry,
    publicProgress,
  } = params;

  // Round-trip the cursor through JSON, as the checkpoint does, so it reads exactly as a worker restart would read it:
  // a key whose value is `undefined` (e.g. HubSpot's `afterCursor` on its last page) is gone, which can leave `{}`.
  const lastCheckpointedConnectorCursorAsStored = JSON.parse(
    JSON.stringify(lastCheckpointedConnectorCursor ?? {}),
  ) as JsonSafeObject;
  const fetchResumesFromTheCursor = isResumableConnectorCursor(lastCheckpointedConnectorCursorAsStored);
  const folderProgressToRewindTo = fetchResumesFromTheCursor
    ? folderProgressAtLastCheckpointedCursor
    : FOLDER_FETCH_PROGRESS_BEFORE_ANY_PAGE;

  return {
    connectorCursorToResumeFrom: fetchResumesFromTheCursor ? lastCheckpointedConnectorCursorAsStored : {},
    rewindFolderProgressToResumePoint: () => {
      if (!fetchingFolderEntry) {
        return;
      }
      const recordsCountedSinceTheResumePoint =
        fetchingFolderEntry.totalFiles - folderProgressToRewindTo.folderFetchedRecordCount;
      fetchingFolderEntry.totalFiles -= recordsCountedSinceTheResumePoint;
      publicProgress.totalFiles -= recordsCountedSinceTheResumePoint;

      if (folderProgressToRewindTo.degradedRecordWarnings === undefined) {
        delete fetchingFolderEntry.warnings;
      } else {
        fetchingFolderEntry.warnings = folderProgressToRewindTo.degradedRecordWarnings;
      }
      if (folderProgressToRewindTo.degradedRecordWarningCount === undefined) {
        delete fetchingFolderEntry.warningCount;
      } else {
        fetchingFolderEntry.warningCount = folderProgressToRewindTo.degradedRecordWarningCount;
      }
    },
  };
}

/**
 * Fetches a folder's records, retrying the fetch when it fails transiently (a dropped connection, a timeout, or a
 * 500/502/503/504 — see `isTransientRemoteServiceFailure`) instead of failing the folder, and with it a Live Export
 * run, over one bad response (DEV-12926). Most connectors retry only their rate limits, so without this one dropped
 * connection on page 800 of a pull threw the whole folder away.
 *
 * A pull only reads from the service, so a retry can't change anything there. Each retry resumes from the folder's
 * last checkpointed cursor (see {@link FolderFetchResumePoint}) after a backoff
 * ({@link TRANSIENT_FOLDER_FETCH_FAILURE_RETRY_DELAYS_MS}), which starts over each time a retry gets further than the
 * one before. Any other failure, and the last transient one, is rethrown unchanged, so the folder fails exactly as it
 * did before.
 *
 * Returns the last connector call's result, and whether any retry resumed from a checkpointed cursor — in which case
 * that last call did not read the pages before the cursor, so its watermark doesn't cover them (see `fetchFolder`).
 */
async function fetchFolderRecordsRetryingTransientFailures(params: {
  fetchFolderRecordsFromConnectorCursor: (connectorCursorToFetchFrom: JsonSafeObject) => Promise<PullRecordFilesResult>;
  connectorCursorTheFetchStartsFrom: JsonSafeObject;
  readResumePointForRetry: () => FolderFetchResumePoint;
  describeConnectorError: (error: unknown) => ConnectorErrorDetails;
  folderCtx: FolderContext;
  abortSignal: AbortSignal;
}): Promise<{ pullResult: PullRecordFilesResult; fetchResumedFromCheckpointedCursorAfterTransientFailure: boolean }> {
  const {
    fetchFolderRecordsFromConnectorCursor,
    connectorCursorTheFetchStartsFrom,
    readResumePointForRetry,
    describeConnectorError,
    folderCtx,
    abortSignal,
  } = params;

  let connectorCursorThisTryStartedFrom = connectorCursorTheFetchStartsFrom;
  let retriesInARowWithoutTheFetchGettingFurther = 0;
  let retriesOfThisFolderFetch = 0;
  let fetchResumedFromCheckpointedCursorAfterTransientFailure = false;

  for (;;) {
    try {
      const pullResult = await fetchFolderRecordsFromConnectorCursor(connectorCursorThisTryStartedFrom);
      return { pullResult, fetchResumedFromCheckpointedCursorAfterTransientFailure };
    } catch (error) {
      if (abortSignal.aborted || !isTransientRemoteServiceFailure(error)) {
        throw error;
      }

      const resumePoint = readResumePointForRetry();
      const fetchGotFurtherThanThisTryStarted =
        JSON.stringify(resumePoint.connectorCursorToResumeFrom) !== JSON.stringify(connectorCursorThisTryStartedFrom);
      if (fetchGotFurtherThanThisTryStarted) {
        retriesInARowWithoutTheFetchGettingFurther = 0;
      }
      const retryDelayMs = TRANSIENT_FOLDER_FETCH_FAILURE_RETRY_DELAYS_MS[retriesInARowWithoutTheFetchGettingFurther];
      if (
        retryDelayMs === undefined ||
        retriesOfThisFolderFetch >= MAX_TRANSIENT_FOLDER_FETCH_FAILURE_RETRIES_PER_FOLDER
      ) {
        throw error;
      }
      retriesInARowWithoutTheFetchGettingFurther++;
      retriesOfThisFolderFetch++;

      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Folder fetch failed transiently — retrying from its last checkpointed cursor',
        workbookId: folderCtx.dataFolder.workbookId,
        dataFolderId: folderCtx.dataFolder.id,
        folderName: folderCtx.dataFolder.name,
        connectorService: folderCtx.dataFolder.connectorService,
        errorDetails: describeConnectorError(error),
        retryNumberOfThisFolderFetch: retriesOfThisFolderFetch,
        retryDelayMs,
        resumesFromCheckpointedCursor: isResumableConnectorCursor(resumePoint.connectorCursorToResumeFrom),
      });

      resumePoint.rewindFolderProgressToResumePoint();
      await waitBeforeRetryUnlessJobIsCanceled({ retryDelayMs, abortSignal, jobId: folderCtx.jobId });
      connectorCursorThisTryStartedFrom = resumePoint.connectorCursorToResumeFrom;
      if (isResumableConnectorCursor(connectorCursorThisTryStartedFrom)) {
        fetchResumedFromCheckpointedCursorAfterTransientFailure = true;
      }
    }
  }
}

/** Sleeps `retryDelayMs`, or throws {@link JobCanceledError} as soon as the job is canceled. */
function waitBeforeRetryUnlessJobIsCanceled(params: {
  retryDelayMs: number;
  abortSignal: AbortSignal;
  jobId: string;
}): Promise<void> {
  const { retryDelayMs, abortSignal, jobId } = params;
  return new Promise((resolve, reject) => {
    if (abortSignal.aborted) {
      reject(new JobCanceledError(jobId));
      return;
    }
    let retryDelayTimer: NodeJS.Timeout | undefined = undefined;
    const stopWaitingBecauseTheJobWasCanceled = () => {
      clearTimeout(retryDelayTimer);
      reject(new JobCanceledError(jobId));
    };
    retryDelayTimer = setTimeout(() => {
      abortSignal.removeEventListener('abort', stopWaitingBecauseTheJobWasCanceled);
      resolve();
    }, retryDelayMs);
    abortSignal.addEventListener('abort', stopWaitingBecauseTheJobWasCanceled, { once: true });
  });
}

/**
 * Adds a page's degraded-record warnings to a folder's progress, which lists every one (see
 * {@link PullFolderProgress.warnings}). Throws {@link TooManyDegradedRecordsInFolderError} — failing the folder —
 * once the folder would hold more than {@link MAX_DEGRADED_RECORDS_PER_FOLDER}.
 */
function addPulledRecordWarningsToFolderProgress(
  folderProgressEntry: PullFolderProgress,
  recordWarningsFromOnePage: PulledRecordWarning[],
): void {
  const degradedRecordWarningsSoFar = [...(folderProgressEntry.warnings ?? []), ...recordWarningsFromOnePage];
  if (degradedRecordWarningsSoFar.length > MAX_DEGRADED_RECORDS_PER_FOLDER) {
    throw new TooManyDegradedRecordsInFolderError(
      `More than ${MAX_DEGRADED_RECORDS_PER_FOLDER} records in ${folderProgressEntry.name} could only be partly ` +
        `pulled — too many to leave out of a sync, so this folder's pull failed. The first: ` +
        `${degradedRecordWarningsSoFar[0].warning}`,
    );
  }
  folderProgressEntry.warnings = degradedRecordWarningsSoFar;
  folderProgressEntry.warningCount = degradedRecordWarningsSoFar.length;
}

/** Finds the seeded per-folder progress entry for a folder id (always present — seeded in `run()`). */
function findFolderProgress(
  publicProgress: PullLinkedFolderFilesPublicProgress,
  folderId: string,
): PullFolderProgress | undefined {
  return publicProgress.folders.find((folder) => folder.id === folderId);
}

/**
 * Whether a folder's saved connector cursor lets its fetch continue where an earlier attempt stopped. A
 * missing or empty cursor means the connector starts again from its first page.
 */
function isResumableConnectorCursor(connectorCursor: JsonSafeObject | undefined): boolean {
  return connectorCursor !== undefined && Object.keys(connectorCursor).length > 0;
}

/**
 * The `publicProgress` the previous attempt of this job last checkpointed, when this attempt is a resume.
 * BullMQ hands a first attempt `0` rather than a progress object, so the value is checked before it is trusted.
 */
function readPublicProgressCheckpointedByPreviousAttempt(
  progressHandedToThisAttempt: unknown,
): PullLinkedFolderFilesPublicProgress | undefined {
  if (typeof progressHandedToThisAttempt !== 'object' || progressHandedToThisAttempt === null) {
    return undefined;
  }
  const previousPublicProgress = (progressHandedToThisAttempt as { publicProgress?: unknown }).publicProgress;
  if (typeof previousPublicProgress !== 'object' || previousPublicProgress === null) {
    return undefined;
  }
  if (!Array.isArray((previousPublicProgress as { folders?: unknown }).folders)) {
    return undefined;
  }
  return previousPublicProgress as PullLinkedFolderFilesPublicProgress;
}

/**
 * Carries the counts of a stalled attempt over into the freshly built `publicProgress` and `pullStats` of the
 * attempt that resumes it, so a worker restart doesn't reset the pull's counters to zero.
 *
 * The previous attempt's last `publicProgress` was written by the same checkpoint call as the `jobProgress`
 * (cursors, fetch statuses, completed folders) this attempt resumes from, so its counts match that resume
 * point exactly. A folder's counts are restored only for work this attempt will NOT redo:
 *  - completed in Phase 2 → its fetched count, change counts and mode (Phase 2 skips it);
 *  - fully fetched but not yet processed → its fetched count (Phase 1 skips it; Phase 2 recounts its changes);
 *  - mid-fetch with a resumable cursor → its fetched count (the fetch continues from that cursor);
 *  - otherwise (no usable cursor, or it failed to load this attempt) → nothing. Its fetch starts again from the
 *    first page, so carrying the old count over would count those records twice.
 * A folder's degraded-record warnings follow its fetched count: they were raised by the pages already fetched, so
 * they are kept exactly when those pages are not fetched again.
 *
 * The run-wide totals are then summed from the restored folder entries rather than copied from the previous
 * totals, so they always equal the sum of the folders even when one folder's count was deliberately dropped.
 * Path lists can't be restored: intermediate checkpoints strip them (see
 * `withEmptyPathListsForIntermediateCheckpoint`).
 */
function restoreCountersFromPreviousAttemptCheckpoint(params: {
  /** The raw `progress` BullMQ handed to `run()`: `0` on a first attempt, the last checkpoint on a resume. */
  progressHandedToThisAttempt: unknown;
  publicProgress: PullLinkedFolderFilesPublicProgress;
  pullStats: { created: number; updated: number; deleted: number };
  jobProgress: PullLinkedFolderFilesJobProgress;
  folderIdsThatFailedToLoadThisAttempt: DataFolderId[];
}): void {
  const { progressHandedToThisAttempt, publicProgress, pullStats, jobProgress, folderIdsThatFailedToLoadThisAttempt } =
    params;
  const publicProgressCheckpointedByPreviousAttempt =
    readPublicProgressCheckpointedByPreviousAttempt(progressHandedToThisAttempt);
  if (!publicProgressCheckpointedByPreviousAttempt) {
    return;
  }

  const folderIdsCompletedByPreviousAttempts = new Set<string>(jobProgress.completedFolderIds ?? []);
  const folderIdsThatFailedToLoad = new Set<string>(folderIdsThatFailedToLoadThisAttempt);

  for (const folderEntry of publicProgress.folders) {
    const previousAttemptFolderEntry = findFolderProgress(publicProgressCheckpointedByPreviousAttempt, folderEntry.id);
    if (!previousAttemptFolderEntry) {
      continue;
    }

    if (folderIdsCompletedByPreviousAttempts.has(folderEntry.id)) {
      folderEntry.totalFiles = previousAttemptFolderEntry.totalFiles;
      restorePulledRecordWarnings(folderEntry, previousAttemptFolderEntry);
      folderEntry.creates = previousAttemptFolderEntry.creates;
      folderEntry.updates = previousAttemptFolderEntry.updates;
      folderEntry.deletes = previousAttemptFolderEntry.deletes;
      if (previousAttemptFolderEntry.mode) {
        folderEntry.mode = previousAttemptFolderEntry.mode;
      }
      publicProgress.createdCount += previousAttemptFolderEntry.creates;
      publicProgress.updatedCount += previousAttemptFolderEntry.updates;
      publicProgress.deletedCount += previousAttemptFolderEntry.deletes;
      pullStats.created += previousAttemptFolderEntry.creates;
      pullStats.updated += previousAttemptFolderEntry.updates;
      pullStats.deleted += previousAttemptFolderEntry.deletes;
      continue;
    }

    if (folderIdsThatFailedToLoad.has(folderEntry.id)) {
      continue;
    }

    const fetchContinuesWherePreviousAttemptStopped =
      jobProgress.folderFetchStatus?.[folderEntry.id] === 'fetched' ||
      isResumableConnectorCursor(jobProgress.folderCursors?.[folderEntry.id]);
    if (fetchContinuesWherePreviousAttemptStopped) {
      folderEntry.totalFiles = previousAttemptFolderEntry.totalFiles;
      restorePulledRecordWarnings(folderEntry, previousAttemptFolderEntry);
    }
  }

  publicProgress.totalFiles = publicProgress.folders.reduce(
    (fetchedRecordCountSoFar, folderEntry) => fetchedRecordCountSoFar + folderEntry.totalFiles,
    0,
  );
}

/** Carries a folder's degraded-record warnings over from the previous attempt's checkpoint, when it raised any. */
function restorePulledRecordWarnings(
  folderEntry: PullFolderProgress,
  previousAttemptFolderEntry: PullFolderProgress,
): void {
  if (previousAttemptFolderEntry.warningCount === undefined && previousAttemptFolderEntry.warnings === undefined) {
    return;
  }
  folderEntry.warningCount = previousAttemptFolderEntry.warningCount ?? previousAttemptFolderEntry.warnings?.length;
  folderEntry.warnings = previousAttemptFolderEntry.warnings ?? [];
}

/**
 * Derive max parallel folder fetches from the connector's rate limiter spec.
 *
 * Two independent ceilings apply, and we take the lower:
 *  - **Rate.** Each parallel folder has roughly 1 in-flight API call at a time,
 *    so the rate limit's requests-per-second is a reasonable proxy for how many
 *    folders can make progress without simply queueing on the limiter.
 *  - **Concurrency.** When the service documents a cap on *simultaneous*
 *    requests (`spec.maxConcurrency`), exceeding it is throttled on its own —
 *    independently of the per-window quota — so it binds regardless of rate.
 *
 * The rate proxy alone is only a heuristic: it happens to land near the right
 * number for some connectors and is unrelated to the real limit for others,
 * which is why a service with a published concurrency cap should state it.
 */
export function getMaxConcurrency(service: string, folderCount: number): number {
  const registration = connectorRegistry.get(service);
  const spec = registration?.rateLimiterSpec;
  if (!spec) return Math.min(folderCount, DEFAULT_CONCURRENCY);
  const maxFromRate = Math.ceil(spec.points / spec.duration);
  const maxFromDocumentedConcurrency = spec.maxConcurrency ?? Number.POSITIVE_INFINITY;
  return Math.min(folderCount, maxFromRate, maxFromDocumentedConcurrency);
}

/**
 * Run async functions over items with a concurrency limit.
 */
export async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const executing = new Set<Promise<void>>();
  let canceled = false;

  for (const item of items) {
    if (canceled) break;

    const p = fn(item).then(
      () => {
        executing.delete(p);
      },
      (err) => {
        executing.delete(p);
        if (err instanceof JobCanceledError) {
          canceled = true;
        } else {
          WSLogger.error({
            source: LOG_SOURCE,
            message: 'Unhandled error in runWithConcurrency task',
            error: err,
          });
        }
      },
    );
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  // Wait for in-flight work to settle before propagating cancellation
  await Promise.all(executing);

  if (canceled) throw new JobCanceledError('concurrent-task');
}
