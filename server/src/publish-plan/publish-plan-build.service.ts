import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { type DataFolderOptions, WorkbookId } from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { chunk } from 'lodash';
import { AssetIndexService } from 'src/asset/asset-index.service';
import { safeJsonParse } from 'src/utils/helpers';
import { ParsedContent, Schema } from 'src/utils/objects';
import { CredentialEncryptionService } from '../credential-encryption/credential-encryption.service';
import { DbService } from '../db/db.service';
import { WSLogger } from '../logger';
import { Connector } from '../remote-service/connectors/connector';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec } from '../remote-service/connectors/types';
import { ScratchGitNotFoundError } from '../scratch-git/scratch-git.client';
import { DIRTY_BRANCH, MAIN_BRANCH, ScratchGitService } from '../scratch-git/scratch-git.service';
import { EncryptedData } from '../utils/encryption';
import { fileIndexLookupKey, FileIndexService } from './file-index.service';
import { FileReferenceService } from './file-reference.service';
import {
  planCreateOperationsForRecord,
  planEditOperationsForRecord,
  PlanOperation,
} from './plan-operations-for-record';
import { type ForeignKeyPathInSchema, RefCleanerService } from './ref-cleaner.service';
import { listReferenceTargetTableIdsForTable } from './reference-target-table-ids';
import { SchemaHelperService } from './schema-helper.service';
import { PublishPlanInfo, PublishPlanStatus } from './types';
import { parsePath } from './utils';

/**
 * Thrown by {@link PublishPlanBuildService.buildPipeline} when the connection's
 * current `dirty` HEAD has drifted past the `expectedBaseDirtyHead` TOCTOU token
 * the client captured at upload time (DEV-10316). Carries the count of pending
 * changes vs live `main` so the desktop can render its count-only `dirty` redirect.
 * The publish job handler catches this, cancels the half-built pipeline, and
 * surfaces a structured `blockedDirtyDrift` discriminator on the job's progress.
 */
/**
 * Max rows per `filePath: { in: [...] }` lookup. A publish of a large workbook
 * can carry tens of thousands of changed paths in one plan (DEV-11228: 40,540),
 * which blows past the bind-parameter ceiling. Prisma normally splits an
 * oversized `IN` for you, but it cannot when the `relationJoins` preview
 * feature is on (see schema.prisma) — it fails the whole query with "Query
 * parameter limit exceeded error: Joined queries cannot be split into multiple
 * queries". So we chunk explicitly, matching FileIndexService.
 *
 * NOTE: the real ceiling is 32,767 parameters, not the 65,535 that several
 * older comments in this package claim. Postgres' extended protocol encodes
 * the parameter count as an int16, so 32,767 is the hard maximum. Measured
 * against this repo's Prisma 6.16 + Postgres: 32,767 total binds succeeds and
 * 32,768 fails. Sizing a chunk against 65,535 would reintroduce DEV-11228.
 */
const REVERT_PATH_LOOKUP_CHUNK_SIZE = 1000;

/**
 * Max rows per `publishPlanOperation.createMany`. Each row binds ~9 columns, so
 * 1,000 rows ≈ 9,000 parameters — comfortably under the same 32,767 ceiling
 * regardless of how large the caller's buffer grew.
 */
const PLAN_OPERATION_INSERT_CHUNK_SIZE = 1000;

/**
 * The four `PublishPlanStatus` values that mean a plan will never run again. Every OTHER
 * status is live — including the `*-Completed` ones, which mark a finished *phase* on a
 * plan that is still mid-flight (single-phase execution, e.g. the web's "Execute 1 Phase",
 * parks a plan there between phases). Treating those as terminal would abandon a plan
 * partway through its own pipeline.
 */
const TERMINAL_PUBLISH_PLAN_STATUSES = [
  PublishPlanStatus.Completed,
  PublishPlanStatus.CompletedWithErrors,
  PublishPlanStatus.Failed,
  PublishPlanStatus.Canceled,
];

/**
 * Outcome of {@link PublishPlanBuildService.clearOperationsForReplan}.
 *
 * - `cleared` — the plan was still `planning`; any partial operation set was dropped and the
 *   caller should go ahead and re-plan into it.
 * - `plan-advanced` — another delivery of the same job finished the build first. The caller
 *   must NOT re-plan; the plan is complete and should just be run.
 * - `plan-missing` — the plan disappeared between reads. The caller should fall through and
 *   let `buildPipeline` report it as the missing pipeline it is.
 */
export type ClearOperationsForReplanResult =
  | { outcome: 'cleared'; clearedOperationCount: number }
  | { outcome: 'plan-advanced'; status: string; clearedOperationCount: number }
  | { outcome: 'plan-missing' };

export class PublishDirtyDriftError extends Error {
  constructor(
    public readonly connectorAccountId: string,
    public readonly dirtyCount: number,
    public readonly expectedBaseDirtyHead: string,
    public readonly currentDirtyHead: string | null,
  ) {
    super(
      `Publish aborted: connection ${connectorAccountId} dirty HEAD drifted (expected ${expectedBaseDirtyHead}, found ${currentDirtyHead ?? '<none>'})`,
    );
    this.name = 'PublishDirtyDriftError';
  }
}

@Injectable()
export class PublishPlanBuildService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly refCleanerService: RefCleanerService,
    private readonly schemaService: SchemaHelperService,
    private readonly assetIndexService: AssetIndexService,
    private readonly connectorsService: ConnectorsService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
  ) {}

  /**
   * Look up which of `filePaths` are flagged `revert: true` in UploadPatchMeta
   * for the given (workbookId, connectorAccountId). Returns the subset as a
   * Set for O(1) `has` checks at insert time. Empty set when
   * `connectorAccountId` is undefined (the cross-connector plan-build path
   * doesn't carry an account scope; we conservatively skip the flag — those
   * plans can't be revert-originated anyway since revert-plan always targets
   * one connector).
   */
  private async lookupRevertPaths(
    workbookId: WorkbookId,
    connectorAccountId: string | undefined,
    filePaths: string[],
  ): Promise<Set<string>> {
    if (!connectorAccountId || filePaths.length === 0) return new Set();
    // Chunked to stay under the bind-parameter limit — see
    // REVERT_PATH_LOOKUP_CHUNK_SIZE.
    const revertFlaggedPaths = new Set<string>();
    for (const filePathChunk of chunk(filePaths, REVERT_PATH_LOOKUP_CHUNK_SIZE)) {
      const rows = await this.db.client.uploadPatchMeta.findMany({
        where: {
          workbookId,
          connectorAccountId,
          filePath: { in: filePathChunk },
          revert: true,
        },
        select: { filePath: true },
      });
      for (const row of rows) revertFlaggedPaths.add(row.filePath);
    }
    return revertFlaggedPaths;
  }

  /**
   * Every foreign-key annotation in the schemas of the workbook's folders — only the given connection's
   * folders when one is set. These are the records that can reference a file the plan deletes.
   */
  private async collectForeignKeyPathsInFolderSchemas(
    workbookId: WorkbookId,
    connectorAccountId: string | undefined,
    readDataFolderInfo: (folderPath: string) => Promise<{ spec: BaseJsonTableSpec } | null>,
  ): Promise<ForeignKeyPathInSchema[]> {
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId, ...(connectorAccountId ? { connectorAccountId } : {}) },
      select: { path: true },
    });
    const foreignKeyPathsInFolderSchemas: ForeignKeyPathInSchema[] = [];
    for (const { path: dataFolderPath } of dataFolders) {
      if (!dataFolderPath) continue;
      const dataFolderInfo = await readDataFolderInfo(dataFolderPath.replace(/^\//, ''));
      if (dataFolderInfo?.spec.schema) {
        foreignKeyPathsInFolderSchemas.push(
          ...this.refCleanerService.extractForeignKeyPaths(dataFolderInfo.spec.schema),
        );
      }
    }
    return foreignKeyPathsInFolderSchemas;
  }

  /**
   * Returns all relevant repo IDs for a workbook. When connectorAccountId is provided, returns just that one —
   * and only if it belongs to the workbook (DEV-12337): both plan-job endpoints call `hasDiffs` first, so this is
   * where a caller-supplied connection id from another workbook is rejected, before any plan row is created.
   */
  private async resolveAllRepoIds(workbookId: WorkbookId, connectorAccountId?: string): Promise<string[]> {
    if (connectorAccountId) {
      const repoId = await this.scratchGitService.resolveConnectionRepoPathScopedToWorkbook(
        workbookId,
        connectorAccountId,
      );
      return [repoId];
    }
    const connAccounts = await this.db.client.connectorAccount.findMany({
      where: { workbookId, repoPath: { not: null } },
      select: { repoPath: true },
    });
    return connAccounts.map((ca) => ca.repoPath as string);
  }

  /**
   * Creates a new pipeline record in the database.
   * Can be called independently (e.g. from controller before enqueuing a job).
   */
  async createPipeline(
    workbookId: string,
    userId: string,
    connectorAccountId?: string,
    // folderPath?: string,
    // filePath?: string,
  ): Promise<{ pipelineId: string; branchName: string }> {
    const pipelineId = randomUUID();
    const branchName = `publish/${userId}/${pipelineId}`;

    await this.db.client.publishPlan.create({
      data: {
        id: pipelineId,
        workbookId,
        userId,
        authorId: userId,
        status: PublishPlanStatus.Planning,
        branchName,
        connectorAccountId: connectorAccountId || null,
      },
    });

    return { pipelineId, branchName };
  }

  async setActiveJob(pipelineId: string, bullJobId: string): Promise<void> {
    await this.db.client.publishPlan.update({
      where: { id: pipelineId },
      data: { activeJobId: bullJobId },
    });
  }

  /**
   * Cancels a pipeline that was being planned.
   * Planning is treated as atomic — partial entries are kept for inspection but the status
   * is set to 'canceled' so the pipeline can be re-planned from scratch.
   * activeJobId is preserved so the canceled job can still be inspected.
   */
  async cancelPipeline(pipelineId: string): Promise<void> {
    await this.db.client.publishPlan.update({
      where: { id: pipelineId },
      data: { status: PublishPlanStatus.Canceled },
    });
  }

  /**
   * DEV-9698 (T4) — quiesce step: cancel every non-terminal publish plan for a
   * connection so a resumed plan can't commit result files to the OLD folder
   * paths after the folder move (finding #1). Sets the status to `Canceled` (the
   * plan can be re-planned from scratch afterward); terminal plans
   * (completed / completed-with-errors / failed / canceled) are left untouched, so
   * this is idempotent and safe to re-run. Returns the number of plans cancelled.
   *
   * Note this only flips plan *status*; an already-running publish *job* is stopped
   * separately by the job-drain step (a running batch commits even after the plan
   * is cancelled, since it does not re-check status mid-batch).
   */
  async cancelNonTerminalPlansForConnection(connectorAccountId: string): Promise<number> {
    const result = await this.db.client.publishPlan.updateMany({
      where: {
        connectorAccountId,
        status: { notIn: TERMINAL_PUBLISH_PLAN_STATUSES },
      },
      data: { status: PublishPlanStatus.Canceled },
    });
    return result.count;
  }

  /**
   * DEV-11254 — finds the still-live PublishPlan a self-planning publish job already
   * created for itself on an earlier delivery, so a redelivered job RESUMES it instead
   * of planning a second one.
   *
   * The lookup key is the BullMQ job id, which is the right notion of "same work" here:
   * BullMQ redelivers a stalled job under its ORIGINAL id, and `setActiveJob` has already
   * stamped that id onto the plan the first delivery created. A genuinely new enqueue gets
   * a new job id and so correctly gets a new plan.
   *
   * Ordered `createdAt asc` deliberately. In the fixed world there is at most one live plan
   * per job id, so ordering is moot; it matters only for rows created by the bug this fixes
   * (prod run `rrn_I7VfxGpZ38` left two plans sharing one job id), where the FIRST is the one
   * carrying the recorded progress and the later one is the empty artifact. Picking the
   * oldest converges on the canonical plan instead of orphaning 47k successful operations.
   * A first plan still stuck in `planning` is fine to return: the caller re-plans into that
   * row exactly as `buildPipeline` already does for a caller-supplied `planning` pipeline.
   */
  async findResumablePlanForJob(workbookId: string, bullJobId: string) {
    return this.db.client.publishPlan.findFirst({
      where: {
        workbookId,
        activeJobId: bullJobId,
        status: { notIn: TERMINAL_PUBLISH_PLAN_STATUSES },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Drops every operation on a plan that is about to be re-planned into (DEV-11254).
   *
   * `buildPipeline` only ever `createMany`s — it never clears what is already there — and it
   * writes operations incrementally in chunks. So a plan build that died partway leaves a
   * `planning` row holding a partial operation set, and replanning into it would DOUBLE those
   * rows: the same record queued twice in the same phase, published twice.
   *
   * Only a plan still in `planning` is safe to clear: past that it holds `success` rows, and
   * dropping those would re-publish records already shipped. That check rides ALONG WITH the
   * delete as a relation predicate rather than being a separate read, because the caller may
   * be racing the very delivery that is building this plan — BullMQ redelivers a stalled job
   * while the original processor can still be running (`maxStalledCount: 20` exists precisely
   * because Cloud Run causes false stall detections). A read-then-delete could straddle the
   * other delivery's final `status = planned` update; this cannot, so the destructive step is
   * never applied to a plan that has advanced.
   *
   * Returns what actually happened rather than throwing. Jobs are enqueued `attempts: 1`
   * (bull-enqueuer.service.ts:56), so throwing here would kill a redelivered job outright —
   * including in the benign case where the other delivery simply finished the plan first and
   * the right move is to run it.
   *
   * CAVEAT: this makes the *destructive* step safe, not the whole build. If another delivery
   * is mid-`buildPipeline`, its remaining chunks still land after this delete and the plan
   * ends up a partial mix of both builds. Closing that needs real mutual exclusion between
   * deliveries — see DEV-11254's out-of-scope section.
   */
  async clearOperationsForReplan(pipelineId: string): Promise<ClearOperationsForReplanResult> {
    // Single statement: the plan-status predicate is part of the DELETE, so no window exists
    // between checking the status and acting on it.
    const deleted = await this.db.client.publishPlanOperation.deleteMany({
      where: { planId: pipelineId, plan: { status: PublishPlanStatus.Planning } },
    });

    const plan = await this.db.client.publishPlan.findUnique({
      where: { id: pipelineId },
      select: { status: true },
    });
    if (!plan) return { outcome: 'plan-missing' };
    // `status` is a plain string column; cast to compare against the enum, matching
    // `PublishRunService.runPipeline`'s `switch (plan.status as PublishPlanStatus)`.
    if ((plan.status as PublishPlanStatus) !== PublishPlanStatus.Planning) {
      return { outcome: 'plan-advanced', status: plan.status, clearedOperationCount: deleted.count };
    }
    return { outcome: 'cleared', clearedOperationCount: deleted.count };
  }

  /**
   * Like `getRepoStatus`, but treats a not-yet-created repo (scratch-git 404)
   * as "no changes" instead of throwing. A connection whose repo has never been
   * pulled has nothing to publish — the status controller already handles this
   * the same way; the publish path must too, or planning crashes with a 404.
   */
  private async getRepoStatusToleratingMissingRepo(
    repoId: string,
  ): Promise<Awaited<ReturnType<ScratchGitService['getRepoStatus']>>> {
    return this.scratchGitService.getRepoStatus(repoId).catch((err) => {
      if (err instanceof ScratchGitNotFoundError) return [];
      throw err;
    });
  }

  async hasDiffs(
    workbookId: string,
    connectorAccountId?: string,
    folderPath?: string,
    filePath?: string,
  ): Promise<boolean> {
    const wkbId = workbookId as WorkbookId;
    const repoIds = await this.resolveAllRepoIds(wkbId, connectorAccountId);
    const allStatuses = await Promise.all(repoIds.map((id) => this.getRepoStatusToleratingMissingRepo(id)));
    let changes = allStatuses.flat();
    if (changes.length === 0) return false;

    if (filePath) {
      changes = changes.filter((c) => c.path === filePath);
    } else if (folderPath) {
      const normalizedFolder = folderPath.startsWith('/') ? folderPath.substring(1) : folderPath;
      const prefix = normalizedFolder.endsWith('/') ? normalizedFolder : normalizedFolder + '/';
      changes = changes.filter((c) => c.path.startsWith(prefix));
    }

    return changes.length > 0;
  }

  /**
   * Builds the publish pipeline for a given workbook.
   * If pipelineId is provided, uses the existing pipeline record (job flow).
   * Otherwise creates a new one (direct API flow).
   */
  async buildPipeline(
    workbookId: string,
    userId: string,
    connectorAccountId?: string,
    existingPipelineId?: string,
    folderPath?: string,
    filePath?: string,
    expectedBaseDirtyHead?: string,
    onProgress?: (counts: {
      assetUploadsPlanned: number;
      editsPlanned: number;
      createsPlanned: number;
      deletesPlanned: number;
      backfillsPlanned: number;
      renameFilesPlanned: number;
      step?: string;
    }) => Promise<void>,
  ): Promise<PublishPlanInfo> {
    const wkbId = workbookId as WorkbookId;
    // Resolved first, and scoped to the workbook (DEV-12337): a connection from another workbook is
    // rejected before this plan touches its repo, builds a connector on its credentials, or creates a
    // plan row for it.
    const repoId = await this.scratchGitService.resolveConnectionRepoPathScopedToWorkbook(wkbId, connectorAccountId);

    let pipelineId: string;
    let branchName: string;

    if (existingPipelineId) {
      // Job flow: pipeline already created by controller
      const existing = await this.db.client.publishPlan.findUnique({ where: { id: existingPipelineId } });
      if (!existing) throw new Error(`Pipeline not found: ${existingPipelineId}`);
      pipelineId = existing.id;
      branchName = existing.branchName;
    } else {
      // Direct flow: create pipeline inline
      const created = await this.createPipeline(workbookId, userId, connectorAccountId);
      pipelineId = created.pipelineId;
      branchName = created.branchName;
    }

    // DEV-10316 publish-time TOCTOU re-check. The desktop captured the dirty HEAD
    // right after its upload landed (`expectedBaseDirtyHead`). If the connection's
    // current dirty HEAD has drifted past it — e.g. the automated web sync staged
    // new changes while the user was reviewing "Ready to publish" — abort rather
    // than build a plan that ships those un-approved changes. This MUST run before
    // `rebaseDirty` below, which force-moves the dirty HEAD and would defeat the
    // comparison. Only per-connection desktop publishes send the token; absent ⇒
    // no re-check (the CLI is protected by the upload-time gate instead).
    if (expectedBaseDirtyHead && connectorAccountId) {
      const currentDirtyHead = await this.scratchGitService.getBranchHead(repoId, DIRTY_BRANCH);
      if (currentDirtyHead !== expectedBaseDirtyHead) {
        const dirtyCount = await this.scratchGitService.getPendingChangeCountVsMain(repoId);
        WSLogger.warn({
          source: 'PublishPlanBuildService.buildPipeline',
          message: 'Aborting publish — dirty HEAD drifted since upload (DEV-10316 TOCTOU)',
          workbookId,
          userId,
          data: { connectorAccountId, expectedBaseDirtyHead, currentDirtyHead, dirtyCount },
        });
        throw new PublishDirtyDriftError(connectorAccountId, dirtyCount, expectedBaseDirtyHead, currentDirtyHead);
      }
    }

    // Ensure merge_base === main before diffing. This is a no-op in steady state (dirty==merge_base)
    // and brings merge_base up to date if a pull job just finished without rebasing.
    await this.scratchGitService.rebaseDirty(repoId);

    // Refresh schemas from the remote connector so the planner uses up-to-date field definitions.
    // This mirrors what the pull job does at the start of each pull.
    if (connectorAccountId) {
      await onProgress?.({
        assetUploadsPlanned: 0,
        editsPlanned: 0,
        createsPlanned: 0,
        deletesPlanned: 0,
        backfillsPlanned: 0,
        renameFilesPlanned: 0,
        step: 'Refreshing schemas from remote',
      });
      await this.schemaService.refreshSchemasForConnection(workbookId, connectorAccountId, repoId);
    }

    // Running counts — updated as each entry is planned and passed to onProgress
    const liveCounts = {
      assetUploadsPlanned: 0,
      editsPlanned: 0,
      createsPlanned: 0,
      deletesPlanned: 0,
      backfillsPlanned: 0,
      renameFilesPlanned: 0,
    };
    const reportProgress = async (step?: string) => {
      await onProgress?.({ ...liveCounts, step });
    };

    let changes = await this.getRepoStatusToleratingMissingRepo(repoId);

    await reportProgress(`Diffing branches (${changes.length} changes found)`);

    if (filePath) {
      changes = changes.filter((c) => c.path === filePath);
    } else if (folderPath) {
      const normalizedFolder = folderPath.startsWith('/') ? folderPath.substring(1) : folderPath;
      const prefix = normalizedFolder.endsWith('/') ? normalizedFolder : normalizedFolder + '/';
      changes = changes.filter((c) => c.path.startsWith(prefix));
    }

    if (connectorAccountId) {
      // Find all data folders for this connector in this workbook
      const dataFolders = await this.db.client.dataFolder.findMany({
        where: { workbookId: wkbId, connectorAccountId },
      });

      // Read-only folders are excluded from publish plans entirely (DEV-9928).
      const writableFolders = dataFolders.filter((df) => !(df.options as DataFolderOptions | null)?.readOnly);

      const prefixes = writableFolders
        .map((df) => df.path)
        .filter((p): p is string => !!p)
        .map((p) => (p.startsWith('/') ? p.substring(1) : p)) // Normalize: remove leading slash
        .map((p) => (p.endsWith('/') ? p : p + '/'));

      if (prefixes.length > 0) {
        changes = changes.filter((c) => prefixes.some((prefix) => c.path.startsWith(prefix)));
      } else {
        // No writable folders? Then no changes for this connector.
        changes = [];
      }
    }

    const modifiedFiles = changes.filter((c) => c.status === 'modified');
    const addedFiles = changes.filter((c) => c.status === 'added');
    const deletedFiles = changes.filter((c) => c.status === 'deleted');

    // Bulk-load the set of paths flagged `revert: true` on the upload-patch
    // DTO (persisted to UploadPatchMeta by ApplyPatchesService). Used both
    // by the strip pipeline (pass4 nullifies FK fields on revert ops so the
    // CREATE/EDIT payload doesn't carry stale FK literals; the backfill op
    // gets them and resolves them via RecreatedIdMap after the create phase
    // lands) and by the emit step (sets PublishPlanOperation.isRecreate so
    // dispatch knows to consult RecreatedIdMap).
    const allChangedPaths = [
      ...modifiedFiles.map((c) => c.path),
      ...addedFiles.map((c) => c.path),
      ...deletedFiles.map((c) => c.path),
    ];
    const revertPaths = await this.lookupRevertPaths(wkbId, connectorAccountId, allChangedPaths);

    // Cache table specs to avoid repeated reads
    // Cache table specs to avoid repeated reads
    const dataFolderCache = new Map<string, { id: string; tableId: string[]; spec: BaseJsonTableSpec } | null>();

    const getDataFolderInfo = async (folderPath: string) => {
      // Pass connectorAccountId so a folder path shared across two connections
      // (e.g. both expose "/Contacts") resolves to THIS connection's folder.
      return this.schemaService.getDataFolderInfo(workbookId, folderPath, dataFolderCache, connectorAccountId);
    };

    // --- Prepare for "Delete Ref Clearing" ---
    // 1. Identify Deleted Record IDs (bulk lookup)

    await reportProgress(`Resolving deleted record IDs (${deletedFiles.length} files)`);

    const deletedLookups = deletedFiles.map((del) => {
      const { folderPath, filename: fileName } = parsePath(del.path);
      // Scope to the plan's connection so a folder name shared with another
      // connection resolves the right connection's record (DEV-10880).
      return { folderPath, filename: fileName, connectorAccountId };
    });
    let recordIdMap: Map<string, string> = new Map();
    try {
      recordIdMap = await this.fileIndexService.getRecordIds(workbookId, deletedLookups);
    } catch (e: unknown) {
      console.log(e);
      throw e;
    }

    const deletedRecordIds = new Set<string>();
    const deletedFileRecordIds = new Map<string, string | null>();
    const targetsForRefCheck: Array<{ remoteTableId?: string; recordId?: string }> = [];
    // Inbound refs are stored under the FK annotation's `linkedTableId`, so the annotations in this
    // connection's schemas say which string(s) name each deleted file's table (see
    // `listReferenceTargetTableIdsForTable`).
    const foreignKeyPathsInConnectionSchemas =
      deletedFiles.length > 0
        ? await this.collectForeignKeyPathsInFolderSchemas(wkbId, connectorAccountId, getDataFolderInfo)
        : [];

    for (const del of deletedFiles) {
      const { folderPath, filename: fileName } = parsePath(del.path);
      const recordId =
        recordIdMap.get(fileIndexLookupKey({ folderPath, filename: fileName, connectorAccountId })) ?? null;
      const folderInfo = await getDataFolderInfo(folderPath);
      const referenceTargetTableIds = listReferenceTargetTableIdsForTable(
        folderInfo?.tableId ?? [],
        foreignKeyPathsInConnectionSchemas,
      );

      if (recordId) deletedRecordIds.add(recordId);
      deletedFileRecordIds.set(del.path, recordId);
      for (const referenceTargetTableId of referenceTargetTableIds) {
        targetsForRefCheck.push({ remoteTableId: referenceTargetTableId, recordId: recordId ?? undefined });
      }
    }

    // 2. Identify Inbound Refs to Deleted Files
    // TODO: do we need to search in both branches?
    const searchBranches = [MAIN_BRANCH, DIRTY_BRANCH];
    const inboundRefs = await this.fileReferenceService.findRefsToFiles(
      workbookId,
      targetsForRefCheck,
      searchBranches,
      (step) => reportProgress(step),
    );

    // Identify files that need editing because they reference a deleted file
    const filesReferringToDeletedFiles = new Set<string>();
    for (const ref of inboundRefs) {
      filesReferringToDeletedFiles.add(ref.sourceFilePath);
    }

    // --- Shared operation buffer ---
    const planOperations: PlanOperation[] = [];

    const savePlanOperations = async () => {
      if (planOperations.length === 0) return;
      // The edit/create phases flush this buffer every 100 files, but the
      // asset-upload and delete phases fill it in one go — so chunk here rather
      // than at each call site (see PLAN_OPERATION_INSERT_CHUNK_SIZE).
      for (const planOperationChunk of chunk(planOperations, PLAN_OPERATION_INSERT_CHUNK_SIZE)) {
        await this.db.client.publishPlanOperation.createMany({
          data: planOperationChunk.map((e) => ({
            planId: pipelineId,
            filePath: e.filePath,
            phase: e.phase,
            content: e.content,
            changedFields:
              e.phase === 'edit' || e.phase === 'backfill' ? (e.changedFields as Prisma.InputJsonValue) : undefined,
            remoteRecordId: e.remoteRecordId ?? null,
            dataFolderId: e.dataFolderId ?? null,
            status: e.status,
            isRecreate: e.isRecreate ?? false,
          })),
        });
      }
      planOperations.length = 0;
    };

    // --- Phase 0: [asset-upload] ---
    // Create asset-upload operations for destination assets that need uploading
    if (connectorAccountId) {
      await reportProgress('Checking for assets to upload');
      const connector = await this.resolveConnector(wkbId, connectorAccountId);
      if (connector.supportsFileUpload) {
        const destFolders = await this.db.client.dataFolder.findMany({
          where: { workbookId: wkbId, connectorAccountId },
          select: { id: true, tableId: true, options: true },
        });
        // Asset uploads write to the remote, so skip them for read-only folders (DEV-9928).
        const destFolderIds = destFolders
          .filter((df) => !(df.options as DataFolderOptions | null)?.readOnly)
          .map((df) => df.id);
        if (destFolderIds.length > 0) {
          const unuploadedAssets = await this.assetIndexService.findUnuploadedDestinationAssets(
            workbookId,
            destFolderIds,
          );
          for (const asset of unuploadedAssets) {
            planOperations.push({
              filePath: asset.filename ?? asset.remoteAssetId,
              phase: 'asset-upload',
              content: {
                assetId: asset.id,
                rehostedUrl: asset.rehostedUrl,
                filename: asset.filename,
                mimeType: asset.mimeType,
              } as ParsedContent,
              dataFolderId: asset.dataFolderId,
              status: 'pending',
            });
            liveCounts.assetUploadsPlanned++;
          }
          if (unuploadedAssets.length > 0) {
            await reportProgress(`Found ${unuploadedAssets.length} assets to upload`);
            await savePlanOperations();
          }
        }
      }
    }

    // --- Phase 1: [edit] ---
    // Process Union of Modified Files and Ref-Clearing Candidate Files
    const modifiedFilePaths = new Set(modifiedFiles.map((f) => f.path));
    const filesToProcessInEditPhase = new Set(modifiedFilePaths);
    for (const p of filesReferringToDeletedFiles) filesToProcessInEditPhase.add(p);

    let editCount = 0;
    const editPhaseTotal = filesToProcessInEditPhase.size;
    let editPhaseProcessed = 0;

    for (const editBatch of chunk(Array.from(filesToProcessInEditPhase), 100)) {
      // Bulk fetch from dirty; fall back to main for any missing paths
      const dirtyResults = await this.scratchGitService.readRepoFilesByFolder(repoId, 'dirty', editBatch);
      const dirtyMap = new Map(dirtyResults.map((r) => [r.path, r.content]));

      // Always read main branch for the full batch so we can compute changedFields diffs
      const mainResults = await this.scratchGitService.readRepoFilesByFolder(repoId, 'main', editBatch);
      const mainMap = new Map(mainResults.map((r) => [r.path, r.content]));

      for (const filePath of editBatch) {
        editPhaseProcessed++;
        if (editPhaseProcessed === 1 || editPhaseProcessed % 50 === 0 || editPhaseProcessed === editPhaseTotal) {
          await reportProgress(`Processing edits (${editPhaseProcessed}/${editPhaseTotal})`);
        }

        const rawContent = dirtyMap.get(filePath) ?? mainMap.get(filePath);
        if (!dirtyMap.get(filePath) && mainMap.has(filePath)) {
          WSLogger.warn({
            source: 'PublishPlanService.buildPipeline',
            message: `File not found in dirty branch, falling back to main: ${filePath}`,
            workbookId,
          });
        } else {
          WSLogger.info({
            source: 'PublishPlanService.buildPipeline',
            message: `Processing file in edit phase: ${filePath}`,
            workbookId,
          });
        }

        if (rawContent) {
          let contentObj: ParsedContent;
          try {
            contentObj = JSON.parse(rawContent) as ParsedContent;
          } catch {
            // A record file that isn't valid JSON is corrupt or truncated (e.g. an
            // interrupted pull left partial content, DEV-9981). We can't build an
            // edit op from it — `content` must be a JSON object (ParsedContent) —
            // and re-parsing `rawContent` here would just re-throw the same error.
            // Warn and skip; a re-pull restores the file. Publishing a truncated
            // record would also violate data fidelity, so skipping is the safe path.
            WSLogger.warn({
              source: 'PublishPlanService.buildPipeline',
              message: `Skipping edit for file with invalid JSON: ${filePath}`,
              workbookId,
            });
            continue;
          }

          const { folderPath } = parsePath(filePath);
          const info = await getDataFolderInfo(folderPath);
          const schema = info?.spec?.schema as Schema;
          const dataFolderId = info?.id;

          const isRecreatePath = revertPaths.has(filePath);
          const editPhaseOperations = planEditOperationsForRecord({
            refCleanerService: this.refCleanerService,
            filePath,
            contentObj,
            // If the main-branch copy is truncated/corrupt (DEV-9981), don't crash
            // the whole plan build — warn and treat it as absent.
            readPublishedContentForDiff: () => {
              const mainRaw = mainMap.get(filePath);
              if (!mainRaw) return null;
              const parsedMain = safeJsonParse<Record<string, unknown>>(mainRaw);
              if (parsedMain.ok) return parsedMain.value;
              WSLogger.warn({
                source: 'PublishPlanService.buildPipeline',
                message: `Main-branch content for ${filePath} is not valid JSON; treating as new for diff`,
                workbookId,
              });
              return null;
            },
            schema,
            dataFolderId,
            deletedRecordIds,
            isRecreatePath,
            // Set membership, not a linear scan: this runs once per file in the
            // edit phase, so an O(n) scan here made plan-build O(n²) — ~1.6
            // billion string comparisons at the 40k records of DEV-11228.
            isUserModified: modifiedFilePaths.has(filePath),
          });
          for (const operation of editPhaseOperations) {
            planOperations.push(operation);
            if (operation.phase === 'edit') {
              editCount++;
              liveCounts.editsPlanned++;
            } else if (operation.phase === 'backfill') {
              liveCounts.backfillsPlanned++;
            }
          }
        }
      }
      await savePlanOperations();
    }

    if (editCount > 0) {
      // Edits processed
    }

    // --- Phase 2: [create] ---
    let createCount = 0;
    let createPhaseProcessed = 0;
    const createPhaseTotal = addedFiles.length;

    for (const createBatch of chunk(addedFiles, 100)) {
      const batchPaths = createBatch.map((f) => f.path);
      const dirtyResults = await this.scratchGitService.readRepoFilesByFolder(repoId, 'dirty', batchPaths);
      const dirtyMap = new Map(dirtyResults.map((r) => [r.path, r.content]));

      for (const add of createBatch) {
        createPhaseProcessed++;
        if (
          createPhaseProcessed === 1 ||
          createPhaseProcessed % 50 === 0 ||
          createPhaseProcessed === createPhaseTotal
        ) {
          await reportProgress(`Processing creates (${createPhaseProcessed}/${createPhaseTotal})`);
        }

        const rawContent = dirtyMap.get(add.path);
        if (!rawContent) {
          WSLogger.warn({
            source: 'PublishPlanService.buildPipeline',
            message: `File detected as added in diff but content is null, skipping: ${add.path}`,
            workbookId,
          });
        }
        if (rawContent) {
          const { folderPath, filename } = parsePath(add.path);
          const info = await getDataFolderInfo(folderPath);

          let contentObj: ParsedContent;
          try {
            contentObj = JSON.parse(rawContent) as ParsedContent;
          } catch {
            // Corrupt or truncated record file (e.g. an interrupted pull, DEV-9981).
            // A create op's `content` must be a JSON object (ParsedContent), and
            // re-parsing `rawContent` here would just re-throw. Warn and skip; a
            // re-pull restores the file, and we never publish a truncated record.
            WSLogger.warn({
              source: 'PublishPlanService.buildPipeline',
              message: `Skipping create for file with invalid JSON: ${add.path}`,
              workbookId,
            });
            continue;
          }

          const schema = info?.spec?.schema as Schema;
          const dataFolderId = info?.id;

          const createPhaseOperations = planCreateOperationsForRecord({
            refCleanerService: this.refCleanerService,
            filePath: add.path,
            filename,
            contentObj,
            schema,
            dataFolderId,
            deletedRecordIds,
            isRecreatePath: revertPaths.has(add.path),
            includeRenameFilesOperation: true,
          });
          for (const operation of createPhaseOperations) {
            planOperations.push(operation);
            if (operation.phase === 'create') {
              createCount++;
              liveCounts.createsPlanned++;
            } else if (operation.phase === 'rename-files') {
              liveCounts.renameFilesPlanned++;
            } else if (operation.phase === 'backfill') {
              liveCounts.backfillsPlanned++;
            }
          }
        }
      }
      await savePlanOperations();
    }

    if (createCount > 0) {
      // Creates processed
    }

    // --- Phase 3: [delete] ---
    const deletePhaseTotal = deletedFiles.length;
    let deletePhaseProcessed = 0;

    for (const del of deletedFiles) {
      deletePhaseProcessed++;
      if (deletePhaseProcessed === 1 || deletePhaseProcessed % 50 === 0 || deletePhaseProcessed === deletePhaseTotal) {
        await reportProgress(`Processing deletes (${deletePhaseProcessed}/${deletePhaseTotal})`);
      }
      // recordId was already looked up above when building deletedRecordIds
      const recordId = deletedFileRecordIds.get(del.path);
      const { folderPath } = parsePath(del.path);
      const info = await getDataFolderInfo(folderPath);

      planOperations.push({
        filePath: del.path,
        phase: 'delete',
        content: {},
        remoteRecordId: recordId || null,
        dataFolderId: info?.id || null,
        status: 'pending',
      });
      liveCounts.deletesPlanned++;
    }

    if (deletedFiles.length > 0) {
      // Deletes processed
    }

    await reportProgress('Saving plan entries');
    await savePlanOperations();

    // Mark as planned (ready to run)
    await this.db.client.publishPlan.update({
      where: { id: pipelineId },
      data: { status: PublishPlanStatus.Planned },
    });

    return {
      pipelineId,
      workbookId,
      userId,
      branchName,
      createdAt: new Date(),
      status: PublishPlanStatus.Planned,
    };
  }

  /**
   * Scoped to `{ id, workbookId }` (DEV-12337): building a connector can refresh the connection's
   * OAuth token or provision a Supabase role, so it must never run for another workbook's connection.
   */
  private async resolveConnector(workbookId: WorkbookId, connectorAccountId: string): Promise<Connector> {
    const account = await this.db.client.connectorAccount.findUnique({
      where: { id: connectorAccountId, workbookId },
    });
    if (!account) {
      throw new Error(`ConnectorAccount not found: ${connectorAccountId}`);
    }

    const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
      account.encryptedCredentials as EncryptedData,
    );

    return this.connectorsService.getConnector({
      service: account.service,
      connectorAccount: account,
      decryptedCredentials,
    });
  }
}
