import { Injectable } from '@nestjs/common';
import {
  formatRecordJson,
  isScratchPendingPublishId,
  isScratchPendingRecreateId,
  parseScratchPendingRecreateId,
  type PublishFailedOperation,
} from '@spinner/shared-types';
import axios from 'axios';
import { WSLogger } from 'src/logger';
import { ParsedContent } from 'src/utils/objects';
import { CredentialEncryptionService } from '../credential-encryption/credential-encryption.service';
import { DbService } from '../db/db.service';
import { ExperimentsService } from '../experiments/experiments.service';
import { UserFlag } from '../experiments/flags';
import { Connector } from '../remote-service/connectors/connector';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  readRecordId,
  readRecordIdAsString,
  readRecordIdForSentinelDetection,
  recordWithId,
  recordWithIdCleared,
  recordWithIdWritten,
} from '../remote-service/connectors/types';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { EncryptedData } from '../utils/encryption';
import { pickByShape } from './diff-utils';
import { FileIndexService } from './file-index.service';
import { FileReferenceService } from './file-reference.service';
import { RecreatedIdMapService } from './recreated-id-map.service';
import { RefCleanerService } from './ref-cleaner.service';
import { RefResolverService } from './ref-resolver.service';
import { SchemaHelperService } from './schema-helper.service';
import { PublishPlanInfo, PublishPlanStatus } from './types';
import { parsePath } from './utils';

// Upper bound on the number of per-record failures echoed back onto the
// run-job's terminal progress payload. The connector-rejected count
// (`failedCount`) stays the authoritative total even when there are more
// failures than this; this only caps the inline "why each record failed"
// detail so a pathological run (thousands of rejections) can't bloat the
// progress JSON the CLI/desktop poll.
const PUBLISH_FAILED_OPERATIONS_SUMMARY_CAP = 20;

// Common shape for any plan-operation row dispatched by the runner. Phases that
// require a sparse partial (edit/backfill) widen this to UpdatePublishOperation.
type PublishOperation = {
  id: string;
  filePath: string;
  content: ParsedContent;
  remoteRecordId?: string | null;
  dataFolderId?: string | null;
  // True when the row was built from a revert patch (CLI sent `revert: true`
  // on the upload-patch DTO; ApplyPatchesService persisted to
  // UploadPatchMeta; PublishPlanBuildService joined here). Dispatch reads
  // this to gate FK rewrite against RecreatedIdMap.
  isRecreate?: boolean;
};

// Operation for the edit/backfill phases — the sparse partial that gets PATCHed.
// `changedFields` is required at compile time; `narrowToUpdateOps` enforces it at runtime
// so a build-side bug that omits the field surfaces here instead of crashing in dispatch.
type UpdatePublishOperation = PublishOperation & {
  changedFields: Record<string, unknown>;
};

function narrowToUpdateOps(entries: PublishOperation[]): UpdatePublishOperation[] {
  return entries.map((entry) => {
    const cf = (entry as { changedFields?: unknown }).changedFields;
    if (cf === null || cf === undefined || typeof cf !== 'object' || Array.isArray(cf)) {
      throw new Error(
        `PublishOperation ${entry.id} (${entry.filePath}) is missing required changedFields for an edit/backfill phase`,
      );
    }
    return entry as UpdatePublishOperation;
  });
}

@Injectable()
export class PublishPlanRunService {
  constructor(
    private readonly db: DbService,
    private readonly connectorsService: ConnectorsService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly scratchGitService: ScratchGitService,
    private readonly schemaService: SchemaHelperService,
    private readonly refResolverService: RefResolverService,
    private readonly experimentsService: ExperimentsService,
    private readonly recreatedIdMapService: RecreatedIdMapService,
    private readonly refCleanerService: RefCleanerService,
  ) {}

  async runPipeline(
    pipelineId: string,
    executeSinglePhase?: boolean,
    abortSignal?: AbortSignal,
    onProgress?: (counts: {
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
      currentPhase: string;
    }) => Promise<void>,
    onError?: (errorInfo: { lastSyncError: string; errorCount: number }) => void,
  ): Promise<PublishPlanInfo> {
    const plan = await this.db.client.publishPlan.findUnique({ where: { id: pipelineId } });
    if (!plan) {
      throw new Error('Pipeline plan not found');
    }

    // Resolve the correct git repo ID for this plan (V2 uses per-connection repos)
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(plan.connectorAccountId);

    // Evaluate the `UPDATE_RECORDS_RETURNS_REMOTE_DATA` flag once per run
    // (against the plan's user) and thread the boolean down through
    // `processBatch` → `dispatchUpdateBatch`. When true, the persisted
    // rows returned by `connector.updateRecords` drive the git commit on
    // `main`; when false, the sent payload drives it (current behavior).
    // See `docs/plans/2026-05-29-publish-pk-stringification-bug.md`.
    const planUser = await this.db.client.user.findUnique({
      where: { id: plan.userId },
      select: { id: true, role: true },
    });
    const useRemoteReturnedRows = planUser
      ? await this.experimentsService.getBooleanFlag(UserFlag.UPDATE_RECORDS_RETURNS_REMOTE_DATA, false, planUser)
      : false;

    // Tag and persist the starting dirty + main commits on the first run (not on resume).
    // The primary diff shown in the publish history UI is
    // (preMainCommitSha → preDirtyCommitSha) — what was about to be published. The
    // post-publish main SHA is captured below after rebaseDirty.
    if ((plan.status as PublishPlanStatus) === PublishPlanStatus.Planned) {
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

    // Resolve connector
    const connector = await this.resolveConnector(plan.connectorAccountId);

    // Cache tableSpecs per folder to avoid repeated DB lookups
    const tableSpecCache = new Map<string, BaseJsonTableSpec>();
    // Cache tableSpecs per dataFolderId
    const dataFolderSpecCache = new Map<string, BaseJsonTableSpec | null>();

    try {
      const allPhases = ['asset-upload', 'edit', 'create', 'delete', 'backfill', 'rename-files'] as const;

      // Determine starting index based on status.
      // *-running means the phase was interrupted — restart it from the beginning (pending entries only).
      // *-completed means the phase finished — move to the next phase.
      const startIndex: number = (() => {
        switch (plan.status as PublishPlanStatus) {
          case PublishPlanStatus.Planned:
          case PublishPlanStatus.AssetUploadRunning:
            return 0;
          case PublishPlanStatus.AssetUploadCompleted:
          case PublishPlanStatus.EditsRunning:
            return 1;
          case PublishPlanStatus.EditsCompleted:
          case PublishPlanStatus.CreatesRunning:
            return 2;
          case PublishPlanStatus.CreatesCompleted:
          case PublishPlanStatus.DeletesRunning:
            return 3;
          case PublishPlanStatus.DeletesCompleted:
          case PublishPlanStatus.BackfillRunning:
            return 4;
          case PublishPlanStatus.BackfillCompleted:
          case PublishPlanStatus.RenameFilesRunning:
            return 5;
          case PublishPlanStatus.Completed:
          case PublishPlanStatus.CompletedWithErrors:
            return 6; // nothing left to run
          default:
            throw new Error(`Cannot run pipeline in status: ${plan.status}`);
        }
      })();

      let phasesToRun = allPhases.slice(startIndex);
      if (executeSinglePhase) {
        phasesToRun = phasesToRun.slice(0, 1);
      }

      // Track cumulative error count across all batches
      let cumulativeErrorCount = 0;

      // Pre-count total entries per phase across all statuses (for stable progress denominator)
      const totalByPhase = { 'asset-upload': 0, edit: 0, create: 0, delete: 0, backfill: 0, 'rename-files': 0 };
      for (const p of ['asset-upload', 'edit', 'create', 'delete', 'backfill', 'rename-files'] as const) {
        const count = await this.db.client.publishPlanOperation.count({
          where: { planId: pipelineId, phase: p },
        });
        totalByPhase[p] = count;
      }
      // Seed completed counts from DB so previously-executed phases don't drop to 0 on resume
      const completedByPhase = {
        'asset-upload': 0,
        edit: 0,
        create: 0,
        delete: 0,
        backfill: 0,
        'rename-files': 0,
      };
      for (const p of ['asset-upload', 'edit', 'create', 'delete', 'backfill', 'rename-files'] as const) {
        completedByPhase[p] = await this.db.client.publishPlanOperation.count({
          where: { planId: pipelineId, phase: p, status: 'success' },
        });
      }

      const reportRunProgress = async (currentPhase: string) => {
        await onProgress?.({
          assetUploadsExecuted: completedByPhase['asset-upload'],
          assetUploadsPlanned: totalByPhase['asset-upload'],
          editsExecuted: completedByPhase.edit,
          createsExecuted: completedByPhase.create,
          deletesExecuted: completedByPhase.delete,
          backfillsExecuted: completedByPhase.backfill,
          renameFilesExecuted: completedByPhase['rename-files'],
          editsPlanned: totalByPhase.edit,
          createsPlanned: totalByPhase.create,
          deletesPlanned: totalByPhase.delete,
          backfillsPlanned: totalByPhase.backfill,
          renameFilesPlanned: totalByPhase['rename-files'],
          currentPhase,
        });
      };

      for (const currentPhase of phasesToRun) {
        // Check for cancellation before starting each phase
        abortSignal?.throwIfAborted();

        // Set status to {phase}-running
        const phasePrefix =
          currentPhase === 'rename-files' || currentPhase === 'asset-upload' ? currentPhase : currentPhase + 's';
        await this.db.client.publishPlan.update({
          where: { id: pipelineId },
          data: { status: `${phasePrefix}-running` },
        });

        // Fetch pending entries for this phase
        const entries = await this.db.client.publishPlanOperation.findMany({
          where: { planId: pipelineId, phase: currentPhase, status: 'pending' },
        });

        WSLogger.info({
          source: 'PublishRunService.runPipeline',
          message: `Executing ${currentPhase} Phase: ${entries.length} entries`,
          workbookId: plan.workbookId,
          data: { pipelineId },
        });

        // Asset-upload phase: process entries sequentially (batch size 1), no tableSpec needed
        if (currentPhase === 'asset-upload') {
          for (const entry of entries) {
            abortSignal?.throwIfAborted();
            const batchHadError = await this.processBatch(
              currentPhase,
              [entry as PublishOperation],
              connector,
              null as unknown as BaseJsonTableSpec, // TODO: Make tableSpec optional instead
              plan.workbookId,
              plan.id,
              repoId,
              useRemoteReturnedRows,
            );
            if (batchHadError) {
              cumulativeErrorCount += 1;
              onError?.({
                lastSyncError: `Asset upload failed for ${entry.filePath}`,
                errorCount: cumulativeErrorCount,
              });
            }
            (completedByPhase as Record<string, number>)[currentPhase] =
              ((completedByPhase as Record<string, number>)[currentPhase] ?? 0) + 1;
            await reportRunProgress(currentPhase);
          }
        } else {
          // Standard phase processing: group by dataFolderId, resolve tableSpec
          const distinctFolders = await this.db.client.publishPlanOperation.findMany({
            where: { planId: pipelineId, phase: currentPhase, status: 'pending' },
            select: { dataFolderId: true },
            distinct: ['dataFolderId'],
          });

          WSLogger.info({
            source: 'PublishRunService.runPipeline',
            message: `Found ${distinctFolders.length} distinct folders/tables to process in ${currentPhase} phase`,
            workbookId: plan.workbookId,
            data: { pipelineId, folders: distinctFolders.map((t) => t.dataFolderId) },
          });

          for (const { dataFolderId } of distinctFolders) {
            if (!dataFolderId) continue;

            // Check for cancellation between folders
            abortSignal?.throwIfAborted();

            // Fetch all entries for this table
            const folderEntries = await this.db.client.publishPlanOperation.findMany({
              where: {
                planId: pipelineId,
                phase: currentPhase,
                status: 'pending',
                dataFolderId,
              },
              orderBy: { id: 'asc' },
            });

            if (folderEntries.length === 0) continue;

            // Resolve table spec
            const tableSpec = await this.schemaService.getTableSpecById(dataFolderId, dataFolderSpecCache);
            if (!tableSpec) {
              WSLogger.warn({
                source: 'PublishRunService.runPipeline',
                message: `Could not find spec for dataFolderId: ${dataFolderId}`,
                workbookId: plan.workbookId,
              });
              continue;
            }

            // Determine batch size
            const batchSize =
              currentPhase === 'rename-files'
                ? 1000
                : connector.getBatchSize(
                    currentPhase === 'delete' ? 'delete' : currentPhase === 'create' ? 'create' : 'update',
                  );

            WSLogger.info({
              source: 'PublishRunService.runPipeline',
              message: `Processing table for folder ${dataFolderId} (${folderEntries.length} entries)`,
              workbookId: plan.workbookId,
              data: { pipelineId, tableSpecName: tableSpec.name, batchSize },
            });

            // Chunk entries
            for (let i = 0; i < folderEntries.length; i += batchSize) {
              abortSignal?.throwIfAborted();

              const batch = folderEntries.slice(i, i + batchSize);
              const batchHadError = await this.processBatch(
                currentPhase,
                batch as PublishOperation[],
                connector,
                tableSpec,
                plan.workbookId,
                plan.id,
                repoId,
                useRemoteReturnedRows,
              );
              if (batchHadError) {
                cumulativeErrorCount += batch.length;
                onError?.({
                  lastSyncError: `Batch failed in ${currentPhase} phase (${batch.length} entries)`,
                  errorCount: cumulativeErrorCount,
                });
              }
              (completedByPhase as Record<string, number>)[currentPhase] =
                ((completedByPhase as Record<string, number>)[currentPhase] ?? 0) + batch.length;
              await reportRunProgress(currentPhase);
            }
          }
        }

        // --- RETRY LOGIC ---
        // Fetch failed-batch entries for this phase (across all tables)
        const failedEntries = (await this.db.client.publishPlanOperation.findMany({
          where: { planId: pipelineId, phase: currentPhase, status: 'failed-batch' },
        })) as PublishOperation[];

        if (failedEntries.length > 0) {
          WSLogger.warn({
            source: 'PublishRunService.runPipeline',
            message: `Retrying ${failedEntries.length} failed-batch entries individually`,
            workbookId: plan.workbookId,
            data: { pipelineId },
          });

          // Group failed entries by table again for spec resolution (or just resolve one by one)
          // Resolving one by one is safer but slower.
          // We can reuse the same table-based iteration logic or just cache specs.
          // Let's iterate individually but verify spec from cache.

          for (const entry of failedEntries) {
            // Check for cancellation during retry loop
            abortSignal?.throwIfAborted();

            let tableSpec: BaseJsonTableSpec | null = null;
            if (entry.dataFolderId) {
              tableSpec = await this.schemaService.getTableSpecById(entry.dataFolderId, dataFolderSpecCache);
            }
            if (!tableSpec) {
              // Fallback to path lookup if dataFolderId missing (old entries?)
              const { folderPath } = parsePath(entry.filePath);
              tableSpec = await this.getTableSpecForFolder(plan.workbookId, folderPath, tableSpecCache);
            }

            // Process individually (batch size 1)
            const retryHadError = await this.processBatch(
              currentPhase,
              [entry],
              connector,
              tableSpec,
              plan.workbookId,
              plan.id,
              repoId,
              useRemoteReturnedRows,
            );
            if (retryHadError) {
              // Individual retry failed — this entry stays as failed-batch
              // Error count was already counted during initial batch failure, don't double-count
              onError?.({
                lastSyncError: `Retry failed for ${entry.filePath} in ${currentPhase} phase`,
                errorCount: cumulativeErrorCount,
              });
            } else {
              // Retry succeeded — decrement error count
              cumulativeErrorCount = Math.max(0, cumulativeErrorCount - 1);
            }
          }
        }

        const completedStatus = currentPhase === 'rename-files' ? 'completed' : `${phasePrefix}-completed`;
        await this.db.client.publishPlan.update({
          where: { id: pipelineId },
          data: { status: completedStatus },
        });
      }

      // Query final entry counts per phase to determine accurate status
      const countRows = await this.db.client.publishPlanOperation.groupBy({
        by: ['status', 'phase'],
        where: { planId: pipelineId },
        _count: true,
      });

      const successByPhase: Record<string, number> = {};
      const finalTotalByPhase: Record<string, number> = {};
      let successCount = 0;
      let failedCount = 0;
      for (const row of countRows) {
        finalTotalByPhase[row.phase] = (finalTotalByPhase[row.phase] ?? 0) + row._count;
        if (row.status === 'success') {
          successByPhase[row.phase] = (successByPhase[row.phase] ?? 0) + row._count;
          successCount += row._count;
        } else if (row.status === 'failed-batch') {
          failedCount += row._count;
        }
      }

      // Collect a bounded sample of the per-record connector rejections so the
      // run-job can surface *why* records didn't publish (the connector's own
      // message, persisted on `error` by processBatch), not just a count.
      // Authoritative total stays `failedCount`; this caps the inline detail.
      let failedOperations: PublishFailedOperation[] | undefined;
      if (failedCount > 0) {
        const failedRows = await this.db.client.publishPlanOperation.findMany({
          where: { planId: pipelineId, status: 'failed-batch' },
          select: { filePath: true, phase: true, error: true },
          orderBy: { filePath: 'asc' },
          take: PUBLISH_FAILED_OPERATIONS_SUMMARY_CAP,
        });
        failedOperations = failedRows.map((row) => ({
          filePath: row.filePath,
          phase: row.phase,
          error: row.error,
        }));
      }

      // If we exit early intentionally because of single-phase execution, retain the completed suffix.
      // Otherwise, the entire pipeline is done.
      const lastPhaseRun = phasesToRun[phasesToRun.length - 1];
      const finalStatus =
        failedCount > 0
          ? PublishPlanStatus.CompletedWithErrors
          : executeSinglePhase && lastPhaseRun && lastPhaseRun !== 'backfill'
            ? (`${lastPhaseRun}s-completed` as PublishPlanStatus)
            : PublishPlanStatus.Completed;

      // Store status + result in DB — keep activeJobId as a trace of which job completed this
      await this.db.client.publishPlan.update({
        where: { id: pipelineId },
        data: {
          status: finalStatus,
          result: { successCount, failedCount },
        },
      });

      // Rebase dirty on top of main so published changes disappear from dirty
      WSLogger.info({
        source: 'PublishRunService.runPipeline',
        message: 'Rebasing dirty on main',
        workbookId: plan.workbookId,
      });
      await this.scratchGitService.rebaseDirty(repoId);

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

      return {
        pipelineId: plan.id,
        workbookId: plan.workbookId,
        userId: plan.userId,
        branchName: plan.branchName,
        createdAt: plan.createdAt,
        status: finalStatus,
        successCount,
        failedCount,
        successByPhase,
        totalByPhase: finalTotalByPhase,
        failedOperations,
      };
    } catch (err) {
      // Check if cancellation was requested — mark as canceled (resumable) rather than failed
      if (abortSignal?.aborted) {
        WSLogger.warn({
          source: 'PublishRunService.runPipeline',
          message: 'Pipeline canceled',
          data: { pipelineId },
        });
        // Keep activeJobId so the canceled job can still be inspected
        await this.db.client.publishPlan.update({
          where: { id: pipelineId },
          data: { status: PublishPlanStatus.Canceled },
        });
        throw err;
      }

      WSLogger.error({
        source: 'PublishRunService.runPipeline',
        message: 'Pipeline failed',
        error: err,
        data: { pipelineId },
      });
      // Keep activeJobId so the failed job can still be inspected
      await this.db.client.publishPlan.update({
        where: { id: pipelineId },
        data: { status: PublishPlanStatus.Failed },
      });
      throw err;
    }
  }

  /**
   * Resolve the connector instance for the given connector account.
   */
  /**
   * Look up the connectorAccountId for a publish plan. Cached effectively by
   * the calling dispatch loop (each batch resolves once). Returns null if the
   * plan doesn't exist or has no connector — caller treats null as "skip the
   * recreate-FK rewrite + remap write" for safety.
   */
  private async resolveConnectorAccountIdForPlan(planId: string): Promise<string | null> {
    const plan = await this.db.client.publishPlan.findUnique({
      where: { id: planId },
      select: { connectorAccountId: true },
    });
    return plan?.connectorAccountId ?? null;
  }

  /**
   * Rewrite FK fields on revert-originated entries against `RecreatedIdMap`.
   *
   * Called from `dispatchUpdateBatch` during the **backfill phase** for any
   * batch that contains revert-originated operations (isRecreate=true on the
   * PublishPlanOperation row). The plan-build pipeline strips literal FK
   * fields off CREATE/EDIT ops for recreates (pass4) and re-emits them as
   * BACKFILL ops; by the time backfill runs, every (priorRemoteId →
   * newRemoteId) row this publish will produce has been written to
   * RecreatedIdMap by the create dispatch. Walking each FK field per
   * recreate entry and looking up the scalar literal in the remap gives us
   * the new id; cyclic/sibling revert-FKs resolve correctly because the
   * lookup space is fully populated.
   *
   * `recreatePerOp` is parallel to `resolvedOps` (both are filtered
   * `rawContents`-aligned arrays — entries with no content were skipped
   * upstream). Mutates `resolvedOps` in place at indexes where
   * `recreatePerOp[i] === true`. Issues one DB pass per FK target folder
   * (not per entry, not per FK field), batching every literal value the
   * batch references into a single `resolveLatestBatch` call.
   */
  private async rewriteRecreateFkReferences(args: {
    resolvedOps: ConnectorFile[];
    recreatePerOp: boolean[];
    tableSpec: BaseJsonTableSpec;
    workbookId: string;
    connectorAccountId: string;
  }): Promise<void> {
    const { resolvedOps, recreatePerOp, tableSpec, workbookId, connectorAccountId } = args;

    // Short-circuit: nothing to rewrite if no recreates, no schema, or no FKs.
    const recreateEntryIndexes: number[] = [];
    for (let i = 0; i < recreatePerOp.length; i++) {
      if (recreatePerOp[i]) recreateEntryIndexes.push(i);
    }
    if (recreateEntryIndexes.length === 0 || !tableSpec.schema) return;

    const fkPaths = this.refCleanerService.extractForeignKeyPaths(tableSpec.schema);
    if (fkPaths.length === 0) return;

    // Map each FK schema target (`linkedTableId`, the connector's id for the
    // target table) → folder path where those records live. The remap is
    // keyed by folder, so this resolution is the bridge between the schema's
    // view and the storage layer's view. Empty when no DataFolder matches —
    // we fall through with no rewrites.
    const linkedTableIds = [...new Set(fkPaths.map((f) => f.targetRemoteTableId))];
    const targetFolderByLinkedTableId = await this.recreatedIdMapService.resolveFkTargetFolders({
      workbookId,
      connectorAccountId,
      linkedTableIds,
    });
    if (targetFolderByLinkedTableId.size === 0) return;

    // Collect every literal FK value across every recreate entry, grouped by
    // target folder. One bulk lookup per folder rewrites the whole batch.
    const valuesPerFolder = new Map<string, Set<string>>();
    for (const i of recreateEntryIndexes) {
      const content = resolvedOps[i] as ParsedContent;
      for (const fk of fkPaths) {
        const folder = targetFolderByLinkedTableId.get(fk.targetRemoteTableId);
        if (!folder) continue;
        const values = this.collectScalarValuesAtPath(content, fk.path);
        if (values.size === 0) continue;
        const bucket = valuesPerFolder.get(folder) ?? new Set<string>();
        for (const v of values) bucket.add(v);
        valuesPerFolder.set(folder, bucket);
      }
    }
    if (valuesPerFolder.size === 0) return;

    // One bulk resolve per folder. Each call returns only the prior ids that
    // actually had a (transitively-resolved) hit; folders with no hits are
    // omitted from `remapByFolder` and the rewrite below short-circuits.
    const remapByFolder = new Map<string, Map<string, string>>();
    for (const [folder, values] of valuesPerFolder) {
      const remap = await this.recreatedIdMapService.resolveLatestBatch({
        workbookId,
        connectorAccountId,
        folder,
        priorRemoteIds: [...values],
      });
      if (remap.size > 0) remapByFolder.set(folder, remap);
    }
    if (remapByFolder.size === 0) return;

    for (const i of recreateEntryIndexes) {
      resolvedOps[i] = this.refCleanerService.rewriteForeignKeyValues(
        resolvedOps[i] as ParsedContent,
        tableSpec.schema,
        (linkedTableId) => {
          const folder = targetFolderByLinkedTableId.get(linkedTableId);
          return folder ? remapByFolder.get(folder) : undefined;
        },
      ) as ConnectorFile;
    }
  }

  /**
   * Walk `content` along `path` (the same `[]`-aware path shape that
   * `RefCleanerService.extractForeignKeyPaths` produces) and collect each
   * terminal scalar value as a canonical string. Arrays at the terminal step
   * are flattened element-wise. Non-scalars are skipped.
   */
  private collectScalarValuesAtPath(content: ParsedContent, path: string[]): Set<string> {
    const out = new Set<string>();
    const visit = (node: unknown, remaining: string[]): void => {
      if (node === null || node === undefined) return;
      if (remaining.length === 0) {
        if (Array.isArray(node)) {
          for (const v of node) {
            if (typeof v === 'string' || typeof v === 'number') out.add(String(v));
          }
        } else if (typeof node === 'string' || typeof node === 'number') {
          out.add(String(node));
        }
        return;
      }
      const [head, ...tail] = remaining;
      if (head === '[]') {
        if (Array.isArray(node)) {
          for (const item of node) visit(item, tail);
        }
        return;
      }
      if (typeof node === 'object' && !Array.isArray(node)) {
        visit((node as Record<string, unknown>)[head], tail);
      }
    };
    visit(content, path);
    return out;
  }

  private async resolveConnector(connectorAccountId: string | null): Promise<Connector> {
    if (!connectorAccountId) {
      throw new Error('No connectorAccountId on plan — cannot resolve connector');
    }

    const account = await this.db.client.connectorAccount.findUnique({
      where: { id: connectorAccountId },
    });
    if (!account) {
      throw new Error(`ConnectorAccount not found: ${connectorAccountId}`);
    }

    const decryptedCredentials = await this.credentialEncryptionService.decryptCredentials(
      account.encryptedCredentials as unknown as EncryptedData,
    );

    return this.connectorsService.getConnector({
      service: account.service,
      connectorAccount: account,
      decryptedCredentials,
    });
  }

  /**
   * Get the BaseJsonTableSpec for a given folder.
   */
  private async getTableSpecForFolder(
    workbookId: string,
    folderPath: string,
    cache: Map<string, BaseJsonTableSpec>,
  ): Promise<BaseJsonTableSpec> {
    const spec = await this.schemaService.getTableSpec(workbookId, folderPath, cache);
    if (!spec) {
      return { name: 'unknown', schema: {} } as BaseJsonTableSpec;
    }
    return spec;
  }

  /**
   * Process a batch of entries for a single table.
   * If successful, upgrades status to 'success'.
   * If failed, marks all as 'failed-batch' for later individual retry.
   * Returns true if the batch failed.
   */
  private async processBatch(
    phase: string,
    entries: PublishOperation[], // Type explicitly if possible, but 'any' avoids circular dep issues for now
    connector: Connector,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    planId: string,
    repoId: string,
    useRemoteReturnedRows: boolean,
  ): Promise<boolean> {
    try {
      switch (phase) {
        case 'asset-upload':
          await this.dispatchAssetUploadBatch(entries, connector);
          break;
        case 'edit':
        case 'backfill':
          await this.dispatchUpdateBatch(
            phase,
            narrowToUpdateOps(entries),
            connector,
            tableSpec,
            workbookId,
            planId,
            repoId,
            useRemoteReturnedRows,
          );
          break;
        case 'create':
          await this.dispatchCreateBatch(phase, entries, connector, tableSpec, workbookId, planId, repoId);
          break;
        case 'delete':
          await this.dispatchDeleteBatch(entries, connector, tableSpec, workbookId, planId, repoId);
          break;
        case 'rename-files':
          await this.dispatchRenameBatch(entries, workbookId, repoId);
          break;
        default:
          throw new Error(`Unknown phase: ${phase}`);
      }

      // success
      await this.db.client.publishPlanOperation.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: { status: 'success', error: null },
      });
      return false;
    } catch (err) {
      // Resolve the failure into the service's own user-facing reason. For HTTP
      // connectors `extractConnectorErrorDetails` digs the validation message
      // out of the error response body (e.g. Pipedrive's "Validation failed:
      // Expected 'number' as value for organization custom field ..."), instead
      // of the opaque "Request failed with status code 400" that `err.message`
      // carries. This is the same machinery the pull path already uses.
      const connectorErrorDetails = this.extractPublishErrorDetailsForUser(connector, err);

      WSLogger.warn({
        source: 'PublishRunService.processBatch',
        message: `Batch failed (size=${entries.length})`,
        // Log the sanitized, connector-extracted details — NEVER the raw error.
        // A raw AxiosError serializes to a >100KB blob that GCP truncates, and
        // it leaks request headers (including the API token) into Cloud Logging.
        error: {
          message: connectorErrorDetails.userFriendlyMessage,
          description: connectorErrorDetails.description,
          context: connectorErrorDetails.additionalContext,
        },
        workbookId,
        data: { planId, phase, entryIds: entries.map((e) => e.id) },
      });

      // failed-batch — persist the user-facing reason so the review UI surfaces
      // it on the record instead of a bare HTTP status code.
      await this.db.client.publishPlanOperation.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: {
          status: 'failed-batch',
          error: connectorErrorDetails.userFriendlyMessage,
        },
      });
      return true;
    }
  }

  /**
   * Resolve a publish-dispatch failure into the connector's user-facing error
   * details. Delegates to {@link Connector.extractConnectorErrorDetails}, which
   * for HTTP connectors reads the service's own validation message out of the
   * error response body. Defensive: a failure *inside* extraction must never
   * mask the original publish failure, so it falls back to the raw message.
   */
  private extractPublishErrorDetailsForUser(connector: Connector, err: unknown): ConnectorErrorDetails {
    try {
      return connector.extractConnectorErrorDetails(err);
    } catch {
      const rawErrorMessage = err instanceof Error ? err.message : String(err);
      return { userFriendlyMessage: rawErrorMessage, description: rawErrorMessage };
    }
  }

  private async dispatchAssetUploadBatch(entries: PublishOperation[], connector: Connector): Promise<void> {
    for (const entry of entries) {
      const content = entry.content as Record<string, unknown> | null;
      if (!content) continue;

      const assetId = content.assetId as string;
      const rehostedUrl = content.rehostedUrl as string;
      const filename = (content.filename as string) || 'file';
      const mimeType = (content.mimeType as string) || 'application/octet-stream';

      // Download file from rehosted URL
      const response = await axios.get(rehostedUrl, {
        responseType: 'arraybuffer',
        timeout: 120_000,
      });
      const buffer = Buffer.from(response.data as ArrayBuffer);

      // Build connector-specific metadata
      let metadata: Record<string, unknown> | undefined;
      if (entry.dataFolderId) {
        const dataFolder = await this.db.client.dataFolder.findUnique({
          where: { id: entry.dataFolderId },
          select: { tableId: true },
        });
        if (dataFolder?.tableId) {
          metadata = { siteId: dataFolder.tableId[0] };
        }
      }

      // Upload to remote service
      const result = await connector.uploadFile(buffer, filename, mimeType, metadata);

      // Update the Asset record with the real remote ID and upload timestamp
      await this.db.client.asset.update({
        where: { id: assetId },
        data: {
          remoteAssetId: result.remoteAssetId,
          url: result.url,
          filename: result.filename || filename,
          mimeType: result.mimeType || mimeType,
          size: result.size,
          width: result.width,
          height: result.height,
          uploadedAt: new Date(),
        },
      });
    }
  }

  private async dispatchUpdateBatch(
    phase: string,
    entries: UpdatePublishOperation[],
    connector: Connector,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    planId: string,
    repoId: string,
    useRemoteReturnedRows: boolean,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId;

    // `rawContents` is filtered (entries with no `content` are dropped). The
    // filter applies in lockstep with the downstream iteration below.
    const rawContents: ParsedContent[] = [];
    for (const e of entries) {
      if (!e.content) continue;
      rawContents.push(e.content);
    }
    const resolvedContents = await this.refResolverService.resolveBatchPseudoRefs(workbookId, rawContents, (asset) =>
      connector.resolveAssetReference(asset),
    );

    // Backfill-phase FK rewrite via `RecreatedIdMap`. Walk EVERY entry's FK
    // fields (not just isRecreate=true ones): if a literal scalar value
    // matches a remap entry, the literal is stale BY CONSTRUCTION — the
    // parent record's prior id was deleted-and-recreated in some earlier
    // publish, so the only correct value is the new id from the remap.
    // Rewriting is safe and load-bearing even when an isRecreate flag
    // failed to propagate (e.g., the CLI patch flag was missing or the
    // pass4 strip didn't fire).
    //
    // Gated on `phase === 'backfill'`: backfill always runs after the
    // create phase in the same plan, so all (prior → new) rows this plan
    // will write are present. The edit phase runs BEFORE create and would
    // see a partial remap — leave it alone.
    //
    // Non-revert backfills with no FK literals matching the remap are
    // a no-op (the helper short-circuits on empty remap-by-folder).
    if (phase === 'backfill') {
      const connectorAccountId = await this.resolveConnectorAccountIdForPlan(planId);
      if (connectorAccountId) {
        await this.rewriteRecreateFkReferences({
          resolvedOps: resolvedContents as ConnectorFile[],
          // Every entry participates — see comment above for why.
          recreatePerOp: rawContents.map(() => true),
          tableSpec,
          workbookId,
          connectorAccountId,
        });
      }
    }

    const contents: ParsedContent[] = [];
    const changedFieldsArray: Record<string, unknown>[] = [];
    const entriesWithOps: { entry: UpdatePublishOperation; resolvedContent: ParsedContent }[] = [];

    let opIndex = 0;
    for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
      const entry = entries[entryIdx];
      if (!entry.content) continue;
      let resolvedContent = resolvedContents[opIndex++] as ParsedContent;

      // Use the entry's stored remoteRecordId if present (edits).
      // If absent (backfill for a newly-created record), look up the real ID from the file index.
      let remoteId = entry.remoteRecordId;
      if (!remoteId) {
        const { folderPath, filename } = parsePath(entry.filePath);
        remoteId = await this.fileIndexService.getRecordId(workbookId, folderPath, filename);
      }
      if (!remoteId) {
        throw new Error(`Could not resolve remote ID for entry: ${entry.filePath}`);
      }
      // Only overwrite the PK when the content's existing value is
      // either missing or a sentinel placeholder (backfill case for
      // newly-created records that haven't been re-pulled yet). Two
      // sentinels can show up here:
      //   - `scratch_pending_publish_<uuid>` for sync-created records
      //     awaiting their first publish
      //   - `scratch_pending_recreate_<old_id>` for revert-create payloads
      //     whose original record was deleted-and-recreated in this plan;
      //     the create-phase dispatch stripped the sentinel from the
      //     outgoing payload and wrote the (prior → new) row to
      //     RecreatedIdMap, but the backfill op's persisted `content`
      //     still carries the sentinel verbatim (it was snapshotted at
      //     plan-build time). Without recognizing the recreate sentinel
      //     here, the backfill UPDATE ships the sentinel string as the
      //     PK and the connector blows up trying to match an integer
      //     column against `"scratch_pending_recreate_2"`.
      // For real edits the on-disk record already has the PK in its
      // native type (e.g. integer for Postgres); `remoteId` is the
      // Prisma `String` column, so a blind overwrite stringifies integer
      // PKs and corrupts `main_plan_{planId}`. See
      // `docs/publish-pk-stringification-bug.md` for the full write-up.
      const recordObj = resolvedContent as Record<string, unknown>;
      // `idField` is a lodash-style dot path (nested for e.g. Attio's
      // `id.record_id`), so it must be read/written with path helpers — a
      // plain property access silently misses nested ids. The sentinel-aware
      // read also catches the CLI's revert-recreate shape, where a sentinel
      // string replaces the whole id-path root object.
      const existingId = readRecordIdForSentinelDetection(recordObj, idField);
      const needsIdFill =
        existingId === undefined ||
        existingId === null ||
        (typeof existingId === 'string' &&
          (isScratchPendingPublishId(existingId) || isScratchPendingRecreateId(existingId)));
      if (needsIdFill) {
        resolvedContent = recordWithIdWritten(recordObj, idField, remoteId) as ParsedContent;
      }

      // Skip no-op edits where changedFields is an empty object
      if (Object.keys(entry.changedFields).length === 0) {
        continue;
      }

      // Build deep changedFields from transformed content using the shape from diff.
      // pickByShape uses the structure of entry.changedFields as a mask to extract
      // the corresponding values from the fully-transformed resolvedContent.
      const resolvedChangedFields = pickByShape(resolvedContent as Record<string, unknown>, entry.changedFields);

      contents.push(resolvedContent);
      changedFieldsArray.push(resolvedChangedFields);
      entriesWithOps.push({ entry, resolvedContent: resolvedContent });
    }

    if (contents.length === 0) return;

    const persistedContents = await connector.updateRecords(tableSpec, contents, changedFieldsArray);

    // Flag-gated swap: when `UPDATE_RECORDS_RETURNS_REMOTE_DATA` is on,
    // use the row the connector actually persisted (DB triggers, server
    // normalizers, computed columns, native PK types) instead of our
    // sent payload. Falls back to sent payload when the connector returned
    // a mismatched-length array (defensive — shouldn't happen, but
    // protects us from misbehaving impls).
    let useReturned =
      useRemoteReturnedRows && Array.isArray(persistedContents) && persistedContents.length === entriesWithOps.length;

    // Per-entry identity assertion. A connector that returns rows in a
    // different order than the input (e.g. an ID-keyed lookup with a
    // missing item that silently misaligns the array) would otherwise
    // commit the wrong file's content under the wrong path. Compare each
    // returned row's PK against the input row's PK at the same index;
    // coerce both sides to string because the publish path mixes integer
    // DB PKs (postgres `RETURNING *`) with stringified Prisma columns,
    // and identity here is canonical-string identity. If any index
    // mismatches, fall back to the sent payload wholesale — better to
    // lose the connector-echoed values than to commit them under the
    // wrong path.
    if (useReturned && persistedContents) {
      for (let i = 0; i < persistedContents.length; i++) {
        const persistedRow = persistedContents[i] as Record<string, unknown> | undefined;
        const persistedId = persistedRow ? readRecordId(persistedRow, idField) : undefined;
        const inputId = readRecordId(entriesWithOps[i].resolvedContent as Record<string, unknown>, idField);
        // Only compare when both sides have a primitive PK. `null`/`undefined`
        // → skip (the connector didn't echo an id for this row, treat as
        // benign). Anything that isn't string|number is a misuse — narrowing
        // here also satisfies `no-base-to-string` for the String() calls below
        // by ruling out objects that would stringify to `[object Object]`.
        const persistedIdIsScalar = typeof persistedId === 'string' || typeof persistedId === 'number';
        const inputIdIsScalar = typeof inputId === 'string' || typeof inputId === 'number';
        if (!persistedIdIsScalar || !inputIdIsScalar) continue;
        const persistedIdStr = String(persistedId);
        const inputIdStr = String(inputId);
        if (persistedIdStr !== inputIdStr) {
          WSLogger.warn({
            source: 'PublishPlanRunService.dispatchUpdateBatch',
            message: 'Connector returned rows in a different order than input; falling back to sent payload for commit',
            workbookId,
            data: {
              connectorService: connector.service,
              index: i,
              persistedId: persistedIdStr,
              inputId: inputIdStr,
              filePath: entriesWithOps[i].entry.filePath,
              planId,
            },
          });
          useReturned = false;
          break;
        }
      }
    }

    const contentForCommit: ParsedContent[] = useReturned
      ? (persistedContents as ParsedContent[])
      : entriesWithOps.map((e) => e.resolvedContent);

    // Update Refs & Git
    // We can do this in parallel or sequentially. Sequential for safety.
    const refUpdates = entriesWithOps.map(({ entry }, i) => ({
      path: entry.filePath,
      content: contentForCommit[i],
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
      `Publish V2 ${phase} batch (${entries.length})`,
    );

    // Git Commit (Dirty) — uses full content, not changedFields
    const dirtySyncBatch = entriesWithOps.map(({ entry }, i) => ({
      filePath: entry.filePath,
      content: formatRecordJson(contentForCommit[i] as Record<string, unknown>),
    }));
    await this.syncBatchToDirtyIfFinal(workbookId, planId, phase, dirtySyncBatch, repoId);
  }

  private async dispatchCreateBatch(
    phase: string,
    entries: PublishOperation[],
    connector: Connector,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    planId: string,
    repoId: string,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId;
    const connectorAccountId = await this.resolveConnectorAccountIdForPlan(planId);

    // Per-entry context for revert-creates: the prior remote id encoded in the
    // `scratch_pending_recreate_<old_id>` sentinel that came in on the PK
    // field. We capture this BEFORE the sentinel is stripped so we can
    // (a) rewrite FK fields against `RecreatedIdMap` for this batch, and
    // (b) upsert (priorRemoteId → newRemoteId) after the connector confirms
    //     the new id. Parallel to `rawOps` / `resolvedOps` (NOT `entries`):
    // entries whose `content` is falsy are skipped from both arrays so the
    // indexes stay aligned with the connector-bound payload.
    const priorRemoteIdPerOp: (string | null)[] = [];

    const rawOps: ParsedContent[] = [];
    for (const e of entries) {
      if (!e.content) continue;
      // Sentinel-aware read: handles both the leaf shape (server sync writes
      // `scratch_pending_publish_<uuid>` at the full id path) and the CLI's
      // revert-recreate shape (`scratch_pending_recreate_<old_id>` as a
      // string replacing the whole id-path root object).
      const idValue = readRecordIdForSentinelDetection(e.content as Record<string, unknown>, idField);
      // Strip temporary IDs (sync-pending-publish + revert-recreate). For
      // recreate sentinels, capture the encoded prior id so we can later
      // upsert the (prior → new) remap row.
      const priorRecreateId = parseScratchPendingRecreateId(idValue);
      const hasSentinelId = priorRecreateId !== null || isScratchPendingPublishId(idValue);
      const entryContent = hasSentinelId
        ? recordWithIdCleared(e.content as Record<string, unknown>, idField)
        : { ...(e.content as Record<string, unknown>) };
      priorRemoteIdPerOp.push(priorRecreateId);
      rawOps.push(entryContent as ParsedContent);
    }

    const resolvedOps = await this.refResolverService.resolveBatchPseudoRefs(workbookId, rawOps);

    // No FK rewrite here: revert-creates have their FK fields stripped at
    // plan-build (pass4) and re-applied via the BACKFILL phase, which runs
    // AFTER all creates in this plan land. That's the only phase where
    // RecreatedIdMap is guaranteed to have every (prior → new) row this
    // publish will produce — so cyclic/sibling revert-FKs resolve correctly.
    // dispatchUpdateBatch carries the remap rewrite for the backfill phase.

    const operations: ConnectorFile[] = [];
    const entriesWithOps: { entry: PublishOperation; resolvedOp: ConnectorFile; priorRemoteId: string | null }[] = [];

    let opIndex = 0;
    for (const entry of entries) {
      if (!entry.content) continue;
      const resolvedOp = resolvedOps[opIndex];
      const priorRemoteId = priorRemoteIdPerOp[opIndex];
      opIndex++;
      operations.push(resolvedOp);
      entriesWithOps.push({ entry, resolvedOp, priorRemoteId });
    }

    if (operations.length === 0) return;

    // Bulk create
    const returnedRecords = await connector.createRecords(tableSpec, operations);

    // Post-process
    const fileIndexUpdates: { workbookId: string; folderPath: string; filename: string; recordId: string }[] = [];
    const refUpdates: { path: string; content: ParsedContent }[] = [];
    const gitFiles: { path: string; content: string }[] = [];

    for (let i = 0; i < entriesWithOps.length; i++) {
      const { entry, resolvedOp, priorRemoteId } = entriesWithOps[i];
      const returned = returnedRecords[i] || resolvedOp; // Fallback if connector doesn't return

      // Update File Index. Path-aware read: for a nested id path (Attio's
      // `id.record_id`) a plain property access returns undefined, which
      // silently skipped the index row — making the freshly-created record
      // impossible to update/delete in later publishes.
      const realId = readRecordIdAsString(returned as Record<string, unknown>, idField);
      if (realId !== null && realId !== '') {
        const { folderPath, filename } = parsePath(entry.filePath);
        fileIndexUpdates.push({
          workbookId,
          folderPath,
          filename,
          recordId: realId,
        });

        // Revert-create success: record the (prior → new) mapping so future
        // FK rewrites against this folder can relink stale literal ids. The
        // folder we store matches CLI patch paths (e.g. `public/projects`):
        // `folderPath` is already in that shape after `parsePath`.
        if (priorRemoteId !== null && connectorAccountId) {
          await this.recreatedIdMapService.upsert({
            workbookId,
            connectorAccountId,
            folder: folderPath,
            priorRemoteId,
            newRemoteId: realId,
          });
        }
      } else {
        // No usable id: `readRecordIdAsString` returns null for non-scalar
        // or non-finite values, and the empty string is rejected by the
        // guard above. Surface the raw value so a connector returning an
        // unusable id is loud instead of silently unindexed (which is
        // exactly how the nested-id bug stayed hidden).
        const rawValueAtIdPath = readRecordId(returned as Record<string, unknown>, idField);
        if (rawValueAtIdPath !== undefined && rawValueAtIdPath !== null) {
          WSLogger.error({
            source: 'PublishRunService.dispatchCreateBatch',
            message: 'Unusable record id in publish create batch — record not indexed',
            workbookId,
            filePath: entry.filePath,
            idField,
            idType: typeof rawValueAtIdPath,
            id: JSON.stringify(rawValueAtIdPath),
          });
        }
      }

      // Update Refs
      refUpdates.push({ path: entry.filePath, content: returned as ParsedContent });

      // Git
      gitFiles.push({ path: entry.filePath, content: formatRecordJson(returned as Record<string, unknown>) });
    }

    if (fileIndexUpdates.length > 0) {
      await this.fileIndexService.upsertBatch(fileIndexUpdates);
    }

    await this.fileReferenceService.updateRefsForFiles(workbookId, 'main', refUpdates);

    await this.scratchGitService.commitFilesToBranch(
      repoId,
      'main',
      gitFiles,
      `Publish V2 create batch (${entries.length})`,
    );

    // Dirty sync
    const dirtySyncBatch = entriesWithOps.map(({ entry, resolvedOp }, i) => {
      const returned = returnedRecords[i] || resolvedOp;
      return {
        filePath: entry.filePath,
        content: formatRecordJson(returned as Record<string, unknown>),
      };
    });
    await this.syncBatchToDirtyIfFinal(workbookId, planId, phase, dirtySyncBatch, repoId);
  }

  private async dispatchDeleteBatch(
    entries: PublishOperation[],
    connector: Connector,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    planId: string,
    repoId: string,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId;
    const filters: ConnectorFile[] = [];
    const validEntries: PublishOperation[] = [];

    for (const entry of entries) {
      if (entry.remoteRecordId) {
        // Path-aware id stub: a nested id path (Attio's `id.record_id`) must
        // produce `{ id: { record_id: … } }`, not a flat `"id.record_id"`
        // key the connector's extractor can't see. For single-segment paths
        // (every other connector) this is identical to the old
        // `{ [idField]: id }` literal. (A flat column name that itself
        // contains path metacharacters is not representable here — see the
        // limitation note on `recordWithId`.)
        filters.push(recordWithId(idField, entry.remoteRecordId) as ConnectorFile);
        validEntries.push(entry);
      }
    }

    if (filters.length === 0) return;

    // Bulk delete
    await connector.deleteRecords(tableSpec, filters);

    // Cleanup local state
    const filesToDelete = validEntries.map((e) => e.filePath);

    // 1. Refs
    await this.db.client.fileReference.deleteMany({
      where: { workbookId, sourceFilePath: { in: filesToDelete } },
    });

    // 2. Index
    const fileIndexDeletes = validEntries.map((e) => {
      const { folderPath, filename } = parsePath(e.filePath);
      return { folderPath, filename };
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
    const dirtySyncBatch = validEntries.map((entry) => ({
      filePath: entry.filePath,
      content: null,
    }));
    await this.syncBatchToDirtyIfFinal(workbookId, planId, 'delete', dirtySyncBatch, repoId);
  }

  private async dispatchRenameBatch(entries: PublishOperation[], workbookId: string, repoId: string): Promise<void> {
    if (entries.length === 0) return;

    // Group operations by folderPath
    const byFolder = new Map<string, PublishOperation[]>();
    for (const entry of entries) {
      const { folderPath } = parsePath(entry.filePath);
      const list = byFolder.get(folderPath) || [];
      list.push(entry);
      byFolder.set(folderPath, list);
    }

    // Process each folder batch
    for (const [folderPath, folderEntries] of byFolder.entries()) {
      const filenames = folderEntries.map((e) => parsePath(e.filePath).filename);

      // Find the recordIds that were assigned during the 'create' phase
      const indexRecords = await this.db.client.fileIndex.findMany({
        where: {
          workbookId,
          folderPath,
          filename: { in: filenames },
        },
      });

      const filenameToRecordId = new Map(indexRecords.map((r) => [r.filename, r.recordId]));

      const renames: { oldName: string; newName: string }[] = [];
      const fileIndexUpdates: { workbookId: string; folderPath: string; recordId: string; filename: string }[] = [];
      const refUpdates: { oldPath: string; newPath: string }[] = [];

      for (const entry of folderEntries) {
        const { filename: oldName } = parsePath(entry.filePath);
        const recordId = filenameToRecordId.get(oldName);
        if (!recordId) {
          throw new Error(`Cannot find recordId for ${oldName} in folder ${folderPath} during rename`);
        }
        const newName = `${recordId}.json`;

        if (oldName === newName) continue;

        renames.push({ oldName, newName });
        fileIndexUpdates.push({ workbookId, folderPath, recordId, filename: newName });

        const oldPathFull = folderPath ? `${folderPath}/${oldName}` : oldName;
        const newPathFull = folderPath ? `${folderPath}/${newName}` : newName;
        refUpdates.push({ oldPath: oldPathFull, newPath: newPathFull });
      }

      if (renames.length > 0) {
        // Apply batch rename directly via Git
        await this.scratchGitService.renameFiles(
          repoId,
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
    }
  }

  /**
   * Identifies which files in the batch are going through their final operation
   * (no later phases pending), and syncs them to the dirty branch.
   * If content is null, it means the file was deleted.
   */
  private async syncBatchToDirtyIfFinal(
    workbookId: string,
    planId: string,
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
      const laterEntries = await this.db.client.publishPlanOperation.groupBy({
        by: ['filePath'],
        where: {
          planId,
          filePath: { in: filePaths },
          phase: { in: ['backfill', 'delete'] },
          status: 'pending',
        },
        _count: true,
      });

      // Map of filePath -> count of later pending entries
      const pendingMap = new Map(laterEntries.map((g) => [g.filePath, g._count]));

      for (const item of items) {
        if (!pendingMap.has(item.filePath)) {
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
