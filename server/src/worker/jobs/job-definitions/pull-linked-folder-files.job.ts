import { Prisma, type PrismaClient } from '@prisma/client';
import {
  DataFolderId,
  type DataFolderOptions,
  isGenericApiConnectorExtras,
  type JobTrigger,
  JobType,
  type PullFolderProgress,
  type PullLinkedFolderFilesPublicProgress,
  type WorkbookId,
} from '@spinner/shared-types';
import type { ExperimentsService } from '../../../experiments/experiments.service';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import {
  type BaseJsonTableSpec,
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
  },
  PullLinkedFolderFilesPublicProgress,
  PullLinkedFolderFilesJobProgress,
  void
>;

/** Maximum number of file paths to track per category in progress (for UI display). */
const MAX_PROGRESS_PATHS = 100;

const LOG_SOURCE = 'PullLinkedFolderFilesJob';

/** Default max parallel folder fetches when no rate limiter spec is defined. */
const DEFAULT_CONCURRENCY = 3;

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

/** Result from Phase 1 fetch for a single folder. */
type FolderFetchResult = {
  folderId: DataFolderId;
  fileCount: number;
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
        results.set(folderId, { folderId, fileCount: 0, isResuming: true });
        // `publicProgress` is rebuilt from scratch on a resumed attempt, so this folder's entry is back
        // to 'pending' even though a previous attempt already worked on it. Restore what it really is:
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

      try {
        const resumeProgress = jobProgress.folderCursors?.[folderId] ?? {};
        const result = await this.fetchFolder({
          folderCtx,
          jobId,
          pullSink,
          resumeProgress,
          onBatchCheckpoint: async (update) => {
            publicProgress.totalFiles += update.fileCount;
            if (update.cursor) {
              jobProgress.folderCursors = jobProgress.folderCursors ?? {};
              jobProgress.folderCursors[folderId] = update.cursor;
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

        const phase1ErrorDetails = folderCtx.connector.extractConnectorErrorDetails(error);

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
          folderEntry.totalFiles = fetchResult.fileCount;
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
    onBatchCheckpoint: (update: { fileCount: number; cursor?: JsonSafeObject }) => Promise<void>;
    abortSignal: AbortSignal;
  }): Promise<FolderFetchResult> {
    const { folderCtx, jobId, pullSink, onBatchCheckpoint, abortSignal } = params;
    const { dataFolder, connector, tableSpec, pullOptions } = folderCtx;
    const folderId = dataFolder.id;

    const resumeProgress = params.resumeProgress;
    const isResuming = Object.keys(resumeProgress).length > 0;

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

    let fetchedFolderRecords: Awaited<ReturnType<typeof fetchFolderRecords>>;
    try {
      fetchedFolderRecords = await fetchFolderRecords({
        connector,
        tableSpec,
        callOptions,
        resumeProgress,
        writeRecordPage: (connectorRecordsInPage) =>
          pullSink.writeConnectorRecordPage(folderCtx, connectorRecordsInPage),
        onBatchCheckpoint,
        abortSignal,
        jobId: folderCtx.jobId,
      });
    } finally {
      pullSink.releaseRecordPageWritingStateForFolder(folderCtx);
    }
    const { fileCount, pullResult } = fetchedFolderRecords;

    // For incremental: prefer the connector's reported watermark (e.g. server
    // time on the change-feed response) over the job-captured pullStartedAt,
    // but fall back to pullStartedAt if the connector didn't return one.
    const newWatermark =
      folderCtx.effectiveMode === 'incremental' ? (pullResult.newWatermark ?? folderCtx.pullStartedAt) : undefined;
    const newCursor = folderCtx.effectiveMode === 'incremental' ? (pullResult.newCursor ?? null) : undefined;

    return { folderId, fileCount, isResuming, newWatermark, newCursor };
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

    const folderChangeSummary = await pullSink.finishFolderAfterAllRecordPagesWritten(folderCtx, {
      isResumingFromEarlierAttempt: fetchResult.isResuming,
      // Incremental pulls don't delete: the connector only returned records changed since the
      // watermark, so records absent from this pull may be unchanged rather than deleted.
      mayRemoveRecordsAbsentFromThisPull: folderCtx.effectiveMode === 'full',
      reportDurableProgress: () => checkpoint({ publicProgress, jobProgress, connectorProgress: {} }),
    });

    // --- Finalize (clear lock, persist watermark/cursor, send events) ---
    await this.finalizeFolder({ folderCtx, fetchResult, jobId, pullSink });

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
  }): Promise<void> {
    const { folderCtx, fetchResult, jobId, pullSink } = params;
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
      if (effectiveMode === 'full') {
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
  onBatchCheckpoint: (update: { fileCount: number; cursor?: JsonSafeObject }) => Promise<void>;
  abortSignal: AbortSignal;
  jobId: string;
}): Promise<{ fileCount: number; pullResult: PullRecordFilesResult }> {
  const { connector, tableSpec, callOptions, resumeProgress, writeRecordPage, onBatchCheckpoint, abortSignal, jobId } =
    params;
  let fileCount = 0;

  const onBatch = async (callbackParams: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => {
    if (abortSignal.aborted) throw new JobCanceledError(jobId);

    const { files, connectorProgress } = callbackParams;

    await writeRecordPage(files);

    fileCount += files.length;

    await onBatchCheckpoint({ fileCount: files.length, cursor: connectorProgress });
  };

  const pullResult = await connector.pullRecordFiles(tableSpec, onBatch, resumeProgress, callOptions);

  return { fileCount, pullResult };
}

/** Finds the seeded per-folder progress entry for a folder id (always present — seeded in `run()`). */
function findFolderProgress(
  publicProgress: PullLinkedFolderFilesPublicProgress,
  folderId: string,
): PullFolderProgress | undefined {
  return publicProgress.folders.find((folder) => folder.id === folderId);
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
