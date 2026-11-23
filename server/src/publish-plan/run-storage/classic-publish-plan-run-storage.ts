/**
 * Classic storage for the publish run: the plan lives in the PublishPlan /
 * PublishPlanOperation tables, and published results are written back to the
 * connection's git repo (`main` + `dirty`), FileIndex, FileReference and Asset.
 *
 * This is the code `PublishPlanRunService` used to run inline, moved verbatim
 * behind the ports in `publish-plan-run-storage-ports.ts` — same queries, same
 * git calls, same order, same logs.
 */
import { formatRecordJson, type PublishOrigin } from '@spinner/shared-types';
import { WSLogger } from 'src/logger';
import { ParsedContent } from 'src/utils/objects';
import type { TableSpecStore } from 'src/workbook/table-spec-store/table-spec-store';
import { DbService } from '../../db/db.service';
import { ScratchGitService } from '../../scratch-git/scratch-git.service';
import { FileIndexEntry, FileIndexService } from '../file-index.service';
import { FileReferenceService } from '../file-reference.service';
import { PublishPlanPhase, PublishPlanStatus } from '../types';
import { parsePath } from '../utils';
import {
  CreatedRecordToWriteBack,
  DeletedRecordToWriteBack,
  PlanStore,
  PublishedRecordFileRename,
  PublishPlanOperationStatus,
  PublishPlanRunFailedOperation,
  PublishPlanRunOperation,
  PublishPlanRunOperationFailure,
  PublishPlanRunPlan,
  PublishPlanRunStorage,
  PublishPseudoRefResolver,
  RecordWriteback,
  UpdatedRecordToWriteBack,
  UploadedAssetToWriteBack,
} from './publish-plan-run-storage-ports';

export class ClassicPublishPlanRunStorage implements PublishPlanRunStorage {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    /** `@/…` refs resolved through the Postgres FileIndex (and `@asset/…` through Asset). */
    readonly pseudoRefResolver: PublishPseudoRefResolver,
    /** Each folder's stored table spec (`DataFolderTableSpecStoreService`, DEV-12616). */
    readonly tableSpecStore: TableSpecStore,
  ) {}

  openPlanStore(planId: string): PlanStore {
    return new PostgresPublishPlanStore(this.db, planId);
  }

  async openRecordWriteback(plan: PublishPlanRunPlan, planStore: PlanStore): Promise<RecordWriteback> {
    // Resolve the correct git repo ID for this plan (V2 uses per-connection repos)
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(plan.connectorAccountId);
    return new GitRecordWriteback(
      this.db,
      this.scratchGitService,
      this.fileIndexService,
      this.fileReferenceService,
      plan,
      planStore,
      repoId,
    );
  }
}

/** The plan as PublishPlan + PublishPlanOperation rows. */
export class PostgresPublishPlanStore implements PlanStore {
  constructor(
    private readonly db: DbService,
    private readonly pipelineId: string,
  ) {}

  async readPlan(): Promise<PublishPlanRunPlan | null> {
    return this.db.client.publishPlan.findUnique({ where: { id: this.pipelineId } });
  }

  /**
   * Look up the connectorAccountId for a publish plan. Cached effectively by
   * the calling dispatch loop (each batch resolves once). Returns null if the
   * plan doesn't exist or has no connector — caller treats null as "skip the
   * recreate-FK rewrite + remap write" for safety.
   */
  async readPlanConnectorAccountId(): Promise<string | null> {
    const plan = await this.db.client.publishPlan.findUnique({
      where: { id: this.pipelineId },
      select: { connectorAccountId: true },
    });
    return plan?.connectorAccountId ?? null;
  }

  async updatePlanStatus(status: string): Promise<void> {
    await this.db.client.publishPlan.update({
      where: { id: this.pipelineId },
      data: { status },
    });
  }

  async recordPlanFinalStatusAndResult(
    status: PublishPlanStatus,
    result: { successCount: number; failedCount: number },
  ): Promise<void> {
    // Store status + result in DB — keep activeJobId as a trace of which job completed this
    await this.db.client.publishPlan.update({
      where: { id: this.pipelineId },
      data: {
        status,
        result: { successCount: result.successCount, failedCount: result.failedCount },
      },
    });
  }

  async countOperationsInPhase(phase: PublishPlanPhase): Promise<number> {
    return this.db.client.publishPlanOperation.count({
      where: { planId: this.pipelineId, phase },
    });
  }

  async countOperationsInPhaseWithStatus(phase: PublishPlanPhase, status: PublishPlanOperationStatus): Promise<number> {
    return this.db.client.publishPlanOperation.count({
      where: { planId: this.pipelineId, phase, status },
    });
  }

  async countFailedOperationsInPhaseWithError(phase: PublishPlanPhase, error: string): Promise<number> {
    return this.db.client.publishPlanOperation.count({
      where: {
        planId: this.pipelineId,
        phase,
        status: 'failed-batch',
        error,
      },
    });
  }

  async countOperationsGroupedByPhaseAndStatus(): Promise<{ phase: string; status: string; count: number }[]> {
    const countRows = await this.db.client.publishPlanOperation.groupBy({
      by: ['status', 'phase'],
      where: { planId: this.pipelineId },
      _count: true,
    });
    return countRows.map((row) => ({ phase: row.phase, status: row.status, count: row._count }));
  }

  async listPendingOperationsInPhase(phase: PublishPlanPhase): Promise<PublishPlanRunOperation[]> {
    const pendingEntryFilter = { planId: this.pipelineId, phase, status: 'pending' };
    const pendingEntries = await this.db.client.publishPlanOperation.findMany({ where: pendingEntryFilter });
    return pendingEntries as PublishPlanRunOperation[];
  }

  async listDataFolderIdsWithPendingOperationsInPhase(phase: PublishPlanPhase): Promise<(string | null)[]> {
    const distinctFolders = await this.db.client.publishPlanOperation.findMany({
      where: { planId: this.pipelineId, phase, status: 'pending' },
      select: { dataFolderId: true },
      distinct: ['dataFolderId'],
    });
    return distinctFolders.map((folder) => folder.dataFolderId);
  }

  async listPendingOperationIdsInPhaseForDataFolder(phase: PublishPlanPhase, dataFolderId: string): Promise<string[]> {
    const folderEntryIds = await this.db.client.publishPlanOperation.findMany({
      where: {
        planId: this.pipelineId,
        phase,
        status: 'pending',
        dataFolderId,
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return folderEntryIds.map((entry) => entry.id);
  }

  async listFailedOperationIdsInPhase(phase: PublishPlanPhase): Promise<string[]> {
    const failedEntryIds = await this.db.client.publishPlanOperation.findMany({
      where: { planId: this.pipelineId, phase, status: 'failed-batch' },
      select: { id: true },
    });
    return failedEntryIds.map((entry) => entry.id);
  }

  async readOperationsByIdsOrderedById(operationIds: string[]): Promise<PublishPlanRunOperation[]> {
    // `in` does not preserve the id list's order, so ordering is re-applied.
    const batch = await this.db.client.publishPlanOperation.findMany({
      where: { id: { in: operationIds } },
      orderBy: { id: 'asc' },
    });
    return batch as PublishPlanRunOperation[];
  }

  async readOperationById(operationId: string): Promise<PublishPlanRunOperation | null> {
    return (await this.db.client.publishPlanOperation.findUnique({
      where: { id: operationId },
    })) as PublishPlanRunOperation | null;
  }

  async listDistinctFilePathsWithFailedOperations(): Promise<string[]> {
    const failedDistinctPaths = await this.db.client.publishPlanOperation.findMany({
      where: { planId: this.pipelineId, status: 'failed-batch' },
      select: { filePath: true },
      distinct: ['filePath'],
    });
    return failedDistinctPaths.map((row) => row.filePath);
  }

  async listFailedOperationsOrderedByFilePath(): Promise<PublishPlanRunFailedOperation[]> {
    return this.db.client.publishPlanOperation.findMany({
      where: { planId: this.pipelineId, status: 'failed-batch' },
      select: { filePath: true, phase: true, error: true, errorCode: true },
      orderBy: { filePath: 'asc' },
    });
  }

  async findFilePathsWithPendingOperationsInPhases(
    filePaths: string[],
    phases: PublishPlanPhase[],
  ): Promise<Set<string>> {
    const laterEntries = await this.db.client.publishPlanOperation.groupBy({
      by: ['filePath'],
      where: {
        planId: this.pipelineId,
        filePath: { in: filePaths },
        phase: { in: phases },
        status: 'pending',
      },
      _count: true,
    });
    return new Set(laterEntries.map((g) => g.filePath));
  }

  async listOperationFilePathsAndStatuses(): Promise<{ filePath: string; status: string }[]> {
    return this.db.client.publishPlanOperation.findMany({
      where: { planId: this.pipelineId },
      select: { filePath: true, status: true },
    });
  }

  async markOperationsSucceeded(operationIds: string[]): Promise<void> {
    await this.db.client.publishPlanOperation.updateMany({
      where: { id: { in: operationIds } },
      data: { status: 'success', error: null, errorCode: null },
    });
  }

  async markOperationsFailed(operationIds: string[], failure: PublishPlanRunOperationFailure): Promise<void> {
    await this.db.client.publishPlanOperation.updateMany({
      where: { id: { in: operationIds } },
      data: { status: 'failed-batch', error: failure.error, errorCode: failure.errorCode },
    });
  }

  async markOperationFailed(operationId: string, failure: PublishPlanRunOperationFailure): Promise<void> {
    await this.db.client.publishPlanOperation.updateMany({
      where: { id: operationId },
      data: { status: 'failed-batch', error: failure.error, errorCode: failure.errorCode },
    });
  }

  async releaseInputsConsumedByCompletedRun(plan: PublishPlanRunPlan): Promise<void> {
    const pipelineId = this.pipelineId;
    // Consume the upload-patch metadata: rows that were flagged
    // `revert: true` have done their job (PublishPlanOperation.isRecreate
    // is set, pass4 ran, backfill remapped FKs). Leaving them around would
    // cause the next publish to inherit a stale revert flag even after a
    // non-revert edit landed for the same path. Scoped to this plan's
    // connector account; cross-account meta is untouched.
    if (plan.connectorAccountId) {
      try {
        const deleted = await this.db.client.uploadPatchMeta.deleteMany({
          where: { workbookId: plan.workbookId, connectorAccountId: plan.connectorAccountId },
        });
        if (deleted.count > 0) {
          WSLogger.info({
            source: 'PublishRunService.runPipeline',
            message: `Cleared ${deleted.count} UploadPatchMeta row(s) consumed by completed publish`,
            workbookId: plan.workbookId,
            data: { pipelineId, connectorAccountId: plan.connectorAccountId, deleted: deleted.count },
          });
        }
      } catch (err) {
        WSLogger.warn({
          source: 'PublishRunService.runPipeline',
          message: 'Failed to clear UploadPatchMeta after publish — next plan-build may inherit stale revert flags',
          error: err,
          workbookId: plan.workbookId,
          data: { pipelineId, connectorAccountId: plan.connectorAccountId },
        });
      }
    }
  }
}

/**
 * Published results written to the connection's git repo (`main`, and `dirty`
 * for records with no later phase pending), FileIndex, FileReference and Asset.
 */
export class GitRecordWriteback implements RecordWriteback {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly plan: PublishPlanRunPlan,
    private readonly planStore: PlanStore,
    private readonly repoId: string,
  ) {}

  async captureStorageStateBeforeFirstRun(): Promise<void> {
    const { plan, repoId } = this;
    const pipelineId = plan.id;
    // Tag and persist the starting dirty + main commits on the first run (not on resume).
    // The primary diff shown in the publish history UI is
    // (preMainCommitSha → preDirtyCommitSha) — what was about to be published. The
    // post-publish main SHA is captured below after rebaseDirty.
    try {
      const [dirtySha, mainSha] = await Promise.all([
        this.scratchGitService.getBranchHead(repoId, 'dirty'),
        this.scratchGitService.getBranchHead(repoId, 'main'),
      ]);
      await this.scratchGitService.writeTag(repoId, `dirty_plan_${plan.id}`, 'dirty');
      await this.scratchGitService.writeTag(repoId, `main_pre_plan_${plan.id}`, 'main');
      if (dirtySha || mainSha) {
        await this.db.client.publishPlan.update({
          where: { id: pipelineId },
          data: {
            ...(dirtySha ? { preDirtyCommitSha: dirtySha } : {}),
            ...(mainSha ? { preMainCommitSha: mainSha } : {}),
          },
        });
      }
    } catch (err) {
      WSLogger.warn({
        source: 'PublishRunService.runPipeline',
        message: 'Failed to tag starting commits',
        error: err,
        workbookId: plan.workbookId,
        data: { pipelineId },
      });
    }
  }

  async writeBackUpdatedRecords(args: {
    phase: PublishPlanPhase;
    records: UpdatedRecordToWriteBack[];
    dispatchedOperationCount: number;
  }): Promise<void> {
    const { phase, records, dispatchedOperationCount } = args;
    const { workbookId } = this.plan;
    const repoId = this.repoId;

    // Update Refs & Git
    // We can do this in parallel or sequentially. Sequential for safety.
    const refUpdates = records.map((record) => ({
      path: record.filePath,
      content: record.content,
    }));

    await this.fileReferenceService.updateRefsForFiles(workbookId, 'main', refUpdates);

    // Git Commit (Main) — always commit full content
    const gitFiles = refUpdates.map((u) => ({
      path: u.path,
      content: formatRecordJson(u.content as Record<string, unknown>),
    }));
    await this.scratchGitService.commitFilesToBranch(
      repoId,
      'main',
      gitFiles,
      `Publish V2 ${phase} batch (${dispatchedOperationCount})`,
    );

    // Git Commit (Dirty) — uses full content, not changedFields
    const dirtySyncBatch = records.map((record) => ({
      filePath: record.filePath,
      content: formatRecordJson(record.content as Record<string, unknown>),
    }));
    await this.syncBatchToDirtyIfFinal(workbookId, phase, dirtySyncBatch, repoId);
  }

  async writeBackCreatedRecords(args: {
    phase: PublishPlanPhase;
    records: CreatedRecordToWriteBack[];
    dispatchedOperationCount: number;
    connectorAccountId: string | null;
  }): Promise<void> {
    const { phase, records, dispatchedOperationCount, connectorAccountId } = args;
    const { workbookId } = this.plan;
    const repoId = this.repoId;

    const fileIndexUpdates: {
      workbookId: string;
      folderPath: string;
      filename: string;
      recordId: string;
      connectorAccountId: string | null;
    }[] = [];
    const refUpdates: { path: string; content: ParsedContent }[] = [];
    const gitFiles: { path: string; content: string }[] = [];

    for (const record of records) {
      // Update File Index
      if (record.createdRemoteRecordId !== null) {
        const { folderPath, filename } = parsePath(record.filePath);
        fileIndexUpdates.push({
          workbookId,
          folderPath,
          filename,
          recordId: record.createdRemoteRecordId,
          // Scope the freshly-created record to this plan's connection so a
          // co-pending pseudo-ref backfill resolves to it unambiguously even when
          // another connection exposes the same folderPath (DEV-10880).
          connectorAccountId,
        });
      }

      // Update Refs
      refUpdates.push({ path: record.filePath, content: record.content });

      // Git
      gitFiles.push({ path: record.filePath, content: formatRecordJson(record.content as Record<string, unknown>) });
    }

    if (fileIndexUpdates.length > 0) {
      await this.fileIndexService.upsertBatch(fileIndexUpdates);
    }

    await this.fileReferenceService.updateRefsForFiles(workbookId, 'main', refUpdates);

    await this.scratchGitService.commitFilesToBranch(
      repoId,
      'main',
      gitFiles,
      `Publish V2 create batch (${dispatchedOperationCount})`,
    );

    // Dirty sync
    const dirtySyncBatch = records.map((record) => ({
      filePath: record.filePath,
      content: formatRecordJson(record.content as Record<string, unknown>),
    }));
    await this.syncBatchToDirtyIfFinal(workbookId, phase, dirtySyncBatch, repoId);
  }

  async writeBackDeletedRecords(args: { records: DeletedRecordToWriteBack[] }): Promise<void> {
    const { records } = args;
    const { workbookId } = this.plan;
    const repoId = this.repoId;

    // Cleanup local state
    const filesToDelete = records.map((e) => e.filePath);

    // 1. Refs
    await this.db.client.fileReference.deleteMany({
      where: { workbookId, sourceFilePath: { in: filesToDelete } },
    });

    // 2. Index — delete by the unique (folderPath, recordId) rather than
    // (folderPath, filename). Two connections in one workbook can expose the same
    // connection-relative folderPath with a same-named file (different recordIds);
    // deleting by filename would also remove the SIBLING connection's index row
    // (DEV-10880). Every record has a remoteRecordId (the dispatcher only hands
    // over deletes it executed), and recordId is part of the FileIndex unique key,
    // so this targets exactly the row being deleted.
    const fileIndexDeletes = records
      .filter((e) => e.remoteRecordId)
      .map((e) => {
        const { folderPath } = parsePath(e.filePath);
        return { folderPath, recordId: e.remoteRecordId };
      });

    if (fileIndexDeletes.length > 0) {
      await this.db.client.fileIndex.deleteMany({
        where: { workbookId, OR: fileIndexDeletes },
      });
    }

    // 3. Git
    await this.scratchGitService.deleteFilesFromBranch(
      repoId,
      'main',
      filesToDelete,
      `Publish V2 delete batch (${filesToDelete.length})`,
    );

    // Dirty sync
    const dirtySyncBatch = records.map((entry) => ({
      filePath: entry.filePath,
      content: null,
    }));
    await this.syncBatchToDirtyIfFinal(workbookId, 'delete', dirtySyncBatch, repoId);
  }

  async recordUploadedAsset(asset: UploadedAssetToWriteBack): Promise<void> {
    // Update the Asset record with the real remote ID and upload timestamp
    await this.db.client.asset.update({
      where: { id: asset.assetId },
      data: {
        remoteAssetId: asset.remoteAssetId,
        url: asset.url,
        filename: asset.filename,
        mimeType: asset.mimeType,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        uploadedAt: new Date(),
      },
    });
  }

  async lookupRemoteRecordIdForFile(args: {
    filePath: string;
    connectorAccountId: string | null;
  }): Promise<string | null> {
    const { folderPath, filename } = parsePath(args.filePath);
    return this.fileIndexService.getRecordId(this.plan.workbookId, folderPath, filename, args.connectorAccountId);
  }

  async lookupRemoteRecordIdsByFilenameInFolder(folderPath: string, filenames: string[]): Promise<Map<string, string>> {
    return this.fileIndexService.getRecordIdsByFilenamesInFolder(this.plan.workbookId, folderPath, filenames);
  }

  async readPublishedRecordFilesInFolder(
    folderPath: string,
    filenames: string[],
  ): Promise<{ path: string; content: string | null }[]> {
    return this.scratchGitService.readRepoFilesFromFolder(this.repoId, 'main', folderPath, filenames);
  }

  async listFilenamesInFolder(folderPath: string): Promise<string[]> {
    return this.fileIndexService.listFilenamesForFolder(this.plan.workbookId, folderPath);
  }

  async renamePublishedFilesInFolder(args: {
    folderPath: string;
    renames: PublishedRecordFileRename[];
    connectorAccountId: string | null;
  }): Promise<void> {
    const { folderPath, connectorAccountId } = args;
    const workbookId = this.plan.workbookId;

    const renames: { oldName: string; newName: string }[] = [];
    const fileIndexUpdates: FileIndexEntry[] = [];
    const refUpdates: { oldPath: string; newPath: string }[] = [];
    for (const { oldName, newName, remoteRecordId: recordId } of args.renames) {
      renames.push({ oldName, newName });
      fileIndexUpdates.push({ workbookId, folderPath, recordId, filename: newName, connectorAccountId });

      const oldPathFull = folderPath ? `${folderPath}/${oldName}` : oldName;
      const newPathFull = folderPath ? `${folderPath}/${newName}` : newName;
      refUpdates.push({ oldPath: oldPathFull, newPath: newPathFull });
    }

    // Apply batch rename directly via Git
    await this.scratchGitService.renameFiles(
      this.repoId,
      folderPath,
      renames,
      `Publish V2 rename batch (${renames.length})`,
    );

    // Update FileIndex
    // The file-index.service upsertBatch correctly handles updating based on compound unique key
    // BUT upsert is on (workbookId, folderPath, recordId), so changing the filename is just an update.
    await this.fileIndexService.upsertBatch(fileIndexUpdates);

    // Update outbound references in FileReference table
    for (const ref of refUpdates) {
      await this.db.client.fileReference.updateMany({
        where: { workbookId, sourceFilePath: ref.oldPath },
        data: { sourceFilePath: ref.newPath },
      });
    }
  }

  async reconcileLocalEditsAfterRun(args: { publishOrigin?: PublishOrigin }): Promise<void> {
    const { publishOrigin } = args;
    const { plan, repoId } = this;
    const pipelineId = plan.id;

    // Reconcile `dirty` against the post-publish `main` (publish redesign,
    // DEV-10048). `rebaseDirty` force-resets `dirty` to `main` and re-applies the
    // user's edits; we hand it a set of paths to *converge to main* (skip
    // re-applying) so the reconcile is scoped to what this plan touched:
    //
    //   - every plan path that did NOT fail (success + no-op edits) converges to
    //     `main` — this is what stops a no-op/removed-key edit from re-accumulating
    //     on `dirty` as a phantom (the old bug);
    //   - failed paths converge too IFF the publish came from the desktop/CLI
    //     (the failed edit travels back to the client via `failedOperations` and
    //     lives in its working tree / `failed-patches.json`); for a `web` publish
    //     they are left on `dirty` (the web has no working tree) and re-surface as
    //     needs-approval there;
    //   - a path with ANY still-`pending` op is left on `dirty`. Single-phase
    //     execution (web "Execute 1 Phase") runs one phase and leaves later
    //     phases' ops `pending` — those records were NOT published yet, so
    //     converging them would wrongly drop a not-yet-run create/delete/backfill
    //     edit from `dirty`. (Also covers a record split across an executed phase
    //     and a pending one, e.g. a landed `edit` + a pending `backfill`.)
    //   - paths NOT in this plan (concurrent or partial-scope edits) are never
    //     excluded, so they are preserved on `dirty`.
    const planOperationPaths = await this.planStore.listOperationFilePathsAndStatuses();
    const pendingPlanPaths = new Set(
      planOperationPaths.filter((op) => op.status === 'pending').map((op) => op.filePath),
    );
    const failedPlanPaths = new Set(
      planOperationPaths.filter((op) => op.status === 'failed-batch').map((op) => op.filePath),
    );
    // Only paths whose every op has run (none still `pending`) are eligible to
    // converge. After a full pipeline run nothing is pending, so this is every
    // plan path — unchanged behavior; it only narrows for single-phase runs.
    const terminalPlanPaths = [
      ...new Set(planOperationPaths.map((op) => op.filePath).filter((path) => !pendingPlanPaths.has(path))),
    ];
    const isDesktopPublish = publishOrigin === 'desktop';
    const pathsToConvergeToMain = terminalPlanPaths.filter((path) => isDesktopPublish || !failedPlanPaths.has(path));
    WSLogger.info({
      source: 'PublishRunService.runPipeline',
      message: 'Reconciling dirty against main',
      workbookId: plan.workbookId,
      data: {
        pipelineId,
        publishOrigin: publishOrigin ?? 'web',
        terminalPathCount: terminalPlanPaths.length,
        pendingPathCount: pendingPlanPaths.size,
        failedPathCount: failedPlanPaths.size,
        convergePathCount: pathsToConvergeToMain.length,
      },
    });
    await this.scratchGitService.rebaseDirty(repoId, pathsToConvergeToMain);
  }

  async captureStorageStateAfterRun(): Promise<void> {
    const { plan, repoId } = this;
    const pipelineId = plan.id;
    // Tag and persist the resulting main commit so rollback can reference what was
    // shipped. Include partial publishes — those commits landed and may still need undo.
    try {
      const mainSha = await this.scratchGitService.getBranchHead(repoId, 'main');
      await this.scratchGitService.writeTag(repoId, `main_plan_${plan.id}`, 'main');
      if (mainSha) {
        await this.db.client.publishPlan.update({
          where: { id: pipelineId },
          data: { postMainCommitSha: mainSha },
        });
      }
    } catch (err) {
      WSLogger.warn({
        source: 'PublishRunService.runPipeline',
        message: 'Failed to tag completed main commit',
        error: err,
        workbookId: plan.workbookId,
        data: { pipelineId },
      });
    }
  }

  /**
   * Identifies which files in the batch are going through their final operation
   * (no later phases pending), and syncs them to the dirty branch.
   * If content is null, it means the file was deleted.
   */
  private async syncBatchToDirtyIfFinal(
    workbookId: string,
    currentPhase: string,
    items: { filePath: string; content: string | null }[],
    repoId: string,
  ): Promise<void> {
    if (items.length === 0) return;

    const finalDeletes: string[] = [];
    const finalCommits: { path: string; content: string }[] = [];

    // Backfill and delete are always the last phase for a record — always sync to dirty
    if (currentPhase === 'backfill' || currentPhase === 'delete') {
      for (const item of items) {
        if (item.content === null) {
          finalDeletes.push(item.filePath);
        } else {
          finalCommits.push({ path: item.filePath, content: item.content });
        }
      }
    } else {
      // For edit/create: we must check if a backfill or delete entry exists for these files
      const filePaths = items.map((i) => i.filePath);

      // Find all later pending phases for any of these files
      const filePathsWithLaterPendingOperations = await this.planStore.findFilePathsWithPendingOperationsInPhases(
        filePaths,
        ['backfill', 'delete'],
      );

      for (const item of items) {
        if (!filePathsWithLaterPendingOperations.has(item.filePath)) {
          // No backfill or delete coming — this is the final content, sync to dirty
          if (item.content === null) {
            finalDeletes.push(item.filePath);
          } else {
            finalCommits.push({ path: item.filePath, content: item.content });
          }
        }
      }
    }

    // Execute batch writes
    if (finalDeletes.length > 0) {
      await this.scratchGitService.deleteFilesFromBranch(
        repoId,
        'dirty',
        finalDeletes,
        `Sync published deletes to dirty (${finalDeletes.length})`,
      );
    }

    if (finalCommits.length > 0) {
      await this.scratchGitService.commitFilesToBranch(
        repoId,
        'dirty',
        finalCommits,
        `Sync published content to dirty (${finalCommits.length})`,
      );
    }
  }
}
