import { Injectable } from '@nestjs/common';
import { isScratchPendingPublishId, Service, WorkbookId } from '@spinner/shared-types';
import { WSLogger } from 'src/logger';
import { ParsedContent } from 'src/utils/objects';
import { CredentialEncryptionService } from '../credential-encryption/credential-encryption.service';
import { DbService } from '../db/db.service';
import { Connector } from '../remote-service/connectors/connector';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, ConnectorFile } from '../remote-service/connectors/types';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { EncryptedData } from '../utils/encryption';
import { FileIndexService } from './file-index.service';
import { FileReferenceService } from './file-reference.service';
import { RefResolverService } from './ref-resolver.service';
import { SchemaHelperService } from './schema-helper.service';
import { PublishPlanInfo } from './types';
import { parsePath } from './utils';

type PublishEntry = {
  id: string;
  filePath: string;
  operation: any;
  remoteRecordId?: string | null;
  dataFolderId?: string | null;
};

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
  ) {}

  async runPipeline(
    pipelineId: string,
    executeSinglePhase?: boolean,
    abortSignal?: AbortSignal,
    onProgress?: (counts: {
      editsExecuted: number;
      createsExecuted: number;
      deletesExecuted: number;
      backfillsExecuted: number;
      editsPlanned: number;
      createsPlanned: number;
      deletesPlanned: number;
      backfillsPlanned: number;
      currentPhase: string;
    }) => Promise<void>,
  ): Promise<PublishPlanInfo> {
    const plan = await this.db.client.publishPlan.findUnique({ where: { id: pipelineId } });
    if (!plan) {
      throw new Error('Pipeline plan not found');
    }

    // Resolve connector
    const connector = await this.resolveConnector(plan.connectorAccountId);

    // Cache tableSpecs per folder to avoid repeated DB lookups
    const tableSpecCache = new Map<string, BaseJsonTableSpec>();
    // Cache tableSpecs per dataFolderId
    const dataFolderSpecCache = new Map<string, BaseJsonTableSpec | null>();

    try {
      const allPhases = ['edit', 'create', 'delete', 'backfill'] as const;

      // Determine starting index based on status.
      // *-running means the phase was interrupted — restart it from the beginning (pending entries only).
      // *-completed means the phase finished — move to the next phase.
      const startIndex: number = (() => {
        switch (plan.status) {
          case 'planned':
          case 'edits-running':
            return 0;
          case 'edits-completed':
          case 'creates-running':
            return 1;
          case 'creates-completed':
          case 'deletes-running':
            return 2;
          case 'deletes-completed':
          case 'backfills-running':
            return 3;
          case 'completed':
          case 'completed-with-errors':
            return 4; // nothing left to run
          default:
            throw new Error(`Cannot run pipeline in status: ${plan.status}`);
        }
      })();

      let phasesToRun = allPhases.slice(startIndex);
      if (executeSinglePhase) {
        phasesToRun = phasesToRun.slice(0, 1);
      }

      // Pre-count total entries per phase across all statuses (for stable progress denominator)
      const totalByPhase = { edit: 0, create: 0, delete: 0, backfill: 0 };
      for (const p of ['edit', 'create', 'delete', 'backfill'] as const) {
        const count = await this.db.client.publishPlanEntry.count({
          where: { planId: pipelineId, phase: p },
        });
        totalByPhase[p] = count;
      }
      // Seed completed counts from DB so previously-executed phases don't drop to 0 on resume
      const completedByPhase = { edit: 0, create: 0, delete: 0, backfill: 0 };
      for (const p of ['edit', 'create', 'delete', 'backfill'] as const) {
        completedByPhase[p] = await this.db.client.publishPlanEntry.count({
          where: { planId: pipelineId, phase: p, status: 'success' },
        });
      }

      const reportRunProgress = async (currentPhase: string) => {
        await onProgress?.({
          editsExecuted: completedByPhase.edit,
          createsExecuted: completedByPhase.create,
          deletesExecuted: completedByPhase.delete,
          backfillsExecuted: completedByPhase.backfill,
          editsPlanned: totalByPhase.edit,
          createsPlanned: totalByPhase.create,
          deletesPlanned: totalByPhase.delete,
          backfillsPlanned: totalByPhase.backfill,
          currentPhase,
        });
      };

      for (const currentPhase of phasesToRun) {
        // Check for cancellation before starting each phase
        abortSignal?.throwIfAborted();

        // Set status to {phase}s-running (e.g. "edits-running", "creates-running")
        const phasePrefix = currentPhase + 's';
        await this.db.client.publishPlan.update({
          where: { id: pipelineId },
          data: { status: `${phasePrefix}-running` },
        });

        // Fetch pending entries for this phase
        const entries = await this.db.client.publishPlanEntry.findMany({
          where: { planId: pipelineId, phase: currentPhase, status: 'pending' },
        });

        WSLogger.info({
          source: 'PublishRunService.runPipeline',
          message: `Executing ${currentPhase} Phase: ${entries.length} entries`,
          workbookId: plan.workbookId,
          data: { pipelineId },
        });

        // Fetch distinct tables (by dataFolderId) that have pending entries
        const distinctFolders = await this.db.client.publishPlanEntry.findMany({
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
          const entries = await this.db.client.publishPlanEntry.findMany({
            where: {
              planId: pipelineId,
              phase: currentPhase,
              status: 'pending',
              dataFolderId,
            },
            orderBy: { id: 'asc' }, // Ensure deterministic order
          });

          if (entries.length === 0) continue;

          // Resolve table spec
          const tableSpec = await this.schemaService.getTableSpecById(dataFolderId, dataFolderSpecCache);
          if (!tableSpec) {
            WSLogger.warn({
              source: 'PublishRunService.runPipeline',
              message: `Could not find spec for dataFolderId: ${dataFolderId}`,
              workbookId: plan.workbookId,
            });
            // Mark entries as failed?
            continue;
          }

          // Determine batch size
          const batchSize = connector.getBatchSize(
            currentPhase === 'delete' ? 'delete' : currentPhase === 'create' ? 'create' : 'update',
          );

          WSLogger.info({
            source: 'PublishRunService.runPipeline',
            message: `Processing table for folder ${dataFolderId} (${entries.length} entries)`,
            workbookId: plan.workbookId,
            data: { pipelineId, tableSpecName: tableSpec.name, batchSize },
          });

          // Chunk entries
          for (let i = 0; i < entries.length; i += batchSize) {
            // Check for cancellation between batches
            abortSignal?.throwIfAborted();

            const batch = entries.slice(i, i + batchSize);
            await this.processBatch(currentPhase, batch, connector, tableSpec, plan.workbookId, plan.id);
            (completedByPhase as Record<string, number>)[currentPhase] =
              ((completedByPhase as Record<string, number>)[currentPhase] ?? 0) + batch.length;
            await reportRunProgress(currentPhase);
          }
        }

        // --- RETRY LOGIC ---
        // Fetch failed-batch entries for this phase (across all tables)
        const failedEntries = await this.db.client.publishPlanEntry.findMany({
          where: { planId: pipelineId, phase: currentPhase, status: 'failed-batch' },
        });

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
            await this.processBatch(currentPhase, [entry], connector, tableSpec, plan.workbookId, plan.id);
          }
        }

        const completedStatus = currentPhase === 'backfill' ? 'completed' : `${phasePrefix}-completed`;
        await this.db.client.publishPlan.update({
          where: { id: pipelineId },
          data: { status: completedStatus },
        });
      }

      // Query final entry counts per phase to determine accurate status
      const countRows = await this.db.client.publishPlanEntry.groupBy({
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

      // If we exit early intentionally because of single-phase execution, retain the completed suffix.
      // Otherwise, the entire pipeline is done.
      const lastPhaseRun = phasesToRun[phasesToRun.length - 1];
      const finalStatus =
        failedCount > 0
          ? 'completed-with-errors'
          : executeSinglePhase && lastPhaseRun && lastPhaseRun !== 'backfill'
            ? `${lastPhaseRun}s-completed`
            : 'completed';

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
      await this.scratchGitService.rebaseDirty(plan.workbookId as WorkbookId);

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
          data: { status: 'canceled' },
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
        data: { status: 'failed' },
      });
      throw err;
    }
  }

  /**
   * Resolve the connector instance for the given connector account.
   */
  private async resolveConnector(connectorAccountId: string | null): Promise<Connector<Service, any>> {
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
      service: account.service as Service,
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
   */
  private async processBatch(
    phase: string,
    entries: PublishEntry[], // Type explicitly if possible, but 'any' avoids circular dep issues for now
    connector: Connector<Service, any>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    planId: string,
  ): Promise<void> {
    try {
      switch (phase) {
        case 'edit':
        case 'backfill':
          await this.dispatchUpdateBatch(phase, entries, connector, tableSpec, workbookId, planId);
          break;
        case 'create':
          await this.dispatchCreateBatch(phase, entries, connector, tableSpec, workbookId, planId);
          break;
        case 'delete':
          await this.dispatchDeleteBatch(entries, connector, tableSpec, workbookId, planId);
          break;
        default:
          throw new Error(`Unknown phase: ${phase}`);
      }

      // success
      await this.db.client.publishPlanEntry.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: { status: 'success', error: null },
      });
    } catch (err) {
      WSLogger.warn({
        source: 'PublishRunService.processBatch',
        message: `Batch failed (size=${entries.length})`,
        error: err,
        workbookId,
        data: { planId, phase, entryIds: entries.map((e) => e.id) },
      });

      // failed-batch
      await this.db.client.publishPlanEntry.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: {
          status: 'failed-batch',
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private async dispatchUpdateBatch(
    phase: string,
    entries: PublishEntry[],
    connector: Connector<Service, any>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    planId: string,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId || 'id';
    const rawOps = entries.map((e) => e.operation as Record<string, unknown>).filter(Boolean);
    const resolvedOps = await this.refResolverService.resolveBatchPseudoRefs(workbookId, rawOps);

    const operations: ParsedContent[] = [];
    const entriesWithOps: { entry: PublishEntry; resolvedOp: ParsedContent }[] = [];

    let opIndex = 0;
    for (const entry of entries) {
      if (!entry.operation) continue;
      let resolvedOp = resolvedOps[opIndex++] as ParsedContent;

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
      resolvedOp = { ...(resolvedOp as Record<string, unknown>), [idField]: remoteId } as ParsedContent;

      operations.push(resolvedOp);
      entriesWithOps.push({ entry, resolvedOp });
    }

    if (operations.length === 0) return;

    // Bulk update
    await connector.updateRecords(tableSpec, operations);

    // Update Refs & Git
    // We can do this in parallel or sequentially. Sequential for safety.
    const refUpdates = entriesWithOps.map(({ entry, resolvedOp }) => ({
      path: entry.filePath,
      content: resolvedOp,
    }));

    await this.fileReferenceService.updateRefsForFiles(workbookId, 'main', refUpdates);

    // Git Commit (Main)
    const gitFiles = refUpdates.map((u) => ({ path: u.path, content: JSON.stringify(u.content, null, 2) }));
    await this.scratchGitService.commitFilesToBranch(
      workbookId as WorkbookId,
      'main',
      gitFiles,
      `Publish V2 ${phase} batch (${entries.length})`,
    );

    // Git Commit (Dirty) - checking if final
    const dirtySyncBatch = entriesWithOps.map(({ entry, resolvedOp }) => ({
      filePath: entry.filePath,
      content: JSON.stringify(resolvedOp, null, 2),
    }));
    await this.syncBatchToDirtyIfFinal(workbookId, planId, phase, dirtySyncBatch);
  }

  private async dispatchCreateBatch(
    phase: string,
    entries: PublishEntry[],
    connector: Connector<Service, any>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    planId: string,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId || 'id';

    const rawOps = entries
      .map((e) => {
        if (!e.operation) return null;
        const content = { ...(e.operation as Record<string, unknown>) };
        // Strip temporary ID
        const idValue = content[idField];
        if (isScratchPendingPublishId(idValue)) {
          delete content[idField];
        }
        return content;
      })
      .filter(Boolean) as Record<string, unknown>[];

    const resolvedOps = await this.refResolverService.resolveBatchPseudoRefs(workbookId, rawOps);

    const operations: any[] = [];
    const entriesWithOps: { entry: PublishEntry; resolvedOp: ParsedContent }[] = [];

    let opIndex = 0;
    for (const entry of entries) {
      if (!entry.operation) continue;
      const resolvedOp = resolvedOps[opIndex++];
      operations.push(resolvedOp);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      entriesWithOps.push({ entry, resolvedOp: resolvedOp as any });
    }

    if (operations.length === 0) return;

    // Bulk create
    const returnedRecords = await connector.createRecords(tableSpec, operations as ConnectorFile[]);

    // Post-process
    const fileIndexUpdates: { workbookId: string; folderPath: string; filename: string; recordId: string }[] = [];
    const refUpdates: { path: string; content: any }[] = [];
    const gitFiles: { path: string; content: string }[] = [];

    for (let i = 0; i < entriesWithOps.length; i++) {
      const { entry, resolvedOp } = entriesWithOps[i];
      const returned = returnedRecords[i] || resolvedOp; // Fallback if connector doesn't return

      // Update File Index
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const realId = (returned as any)[idField];
      if (realId && (typeof realId === 'string' || typeof realId === 'number')) {
        const { folderPath, filename } = parsePath(entry.filePath);
        fileIndexUpdates.push({
          workbookId,
          folderPath,
          filename,
          recordId: String(realId),
        });
      }

      // Update Refs
      refUpdates.push({ path: entry.filePath, content: returned });

      // Git
      gitFiles.push({ path: entry.filePath, content: JSON.stringify(returned, null, 2) });
    }

    if (fileIndexUpdates.length > 0) {
      await this.fileIndexService.upsertBatch(fileIndexUpdates);
    }

    await this.fileReferenceService.updateRefsForFiles(workbookId, 'main', refUpdates);

    await this.scratchGitService.commitFilesToBranch(
      workbookId as WorkbookId,
      'main',
      gitFiles,
      `Publish V2 create batch (${entries.length})`,
    );

    // Dirty sync
    const dirtySyncBatch = entriesWithOps.map(({ entry, resolvedOp }, i) => {
      const returned = returnedRecords[i] || resolvedOp;
      return {
        filePath: entry.filePath,
        content: JSON.stringify(returned, null, 2),
      };
    });
    await this.syncBatchToDirtyIfFinal(workbookId, planId, phase, dirtySyncBatch);
  }

  private async dispatchDeleteBatch(
    entries: PublishEntry[],
    connector: Connector<Service, any>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    planId: string,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId || 'id';
    const filters: { [key: string]: string }[] = [];
    const validEntries: PublishEntry[] = [];

    for (const entry of entries) {
      if (entry.remoteRecordId) {
        filters.push({ [idField]: entry.remoteRecordId });
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
      workbookId as WorkbookId,
      'main',
      filesToDelete,
      `Publish V2 delete batch (${filesToDelete.length})`,
    );

    // Dirty sync
    const dirtySyncBatch = validEntries.map((entry) => ({
      filePath: entry.filePath,
      content: null,
    }));
    await this.syncBatchToDirtyIfFinal(workbookId, planId, 'delete', dirtySyncBatch);
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
      const laterEntries = await this.db.client.publishPlanEntry.groupBy({
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
        workbookId as WorkbookId,
        'dirty',
        finalDeletes,
        `Sync published deletes to dirty (${finalDeletes.length})`,
      );
    }

    if (finalCommits.length > 0) {
      await this.scratchGitService.commitFilesToBranch(
        workbookId as WorkbookId,
        'dirty',
        finalCommits,
        `Sync published content to dirty (${finalCommits.length})`,
      );
    }
  }
}
