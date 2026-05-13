import { Injectable } from '@nestjs/common';
import { isScratchPendingPublishId } from '@spinner/shared-types';
import axios from 'axios';
import { WSLogger } from 'src/logger';
import { ParsedContent } from 'src/utils/objects';
import { CredentialEncryptionService } from '../credential-encryption/credential-encryption.service';
import { DbService } from '../db/db.service';
import { Connector } from '../remote-service/connectors/connector';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, ConnectorFile } from '../remote-service/connectors/types';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { EncryptedData } from '../utils/encryption';
import { pickByShape } from './diff-utils';
import { FileIndexService } from './file-index.service';
import { FileReferenceService } from './file-reference.service';
import { RefResolverService } from './ref-resolver.service';
import { SchemaHelperService } from './schema-helper.service';
import { PublishPlanInfo, PublishPlanStatus } from './types';
import { parsePath } from './utils';

type PublishOperation = {
  id: string;
  filePath: string;
  content: ParsedContent;
  changedFields: Record<string, unknown>;
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
  ): Promise<boolean> {
    try {
      switch (phase) {
        case 'asset-upload':
          await this.dispatchAssetUploadBatch(entries, connector);
          break;
        case 'edit':
        case 'backfill':
          await this.dispatchUpdateBatch(phase, entries, connector, tableSpec, workbookId, planId, repoId);
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
      WSLogger.warn({
        source: 'PublishRunService.processBatch',
        message: `Batch failed (size=${entries.length})`,
        error: err,
        workbookId,
        data: { planId, phase, entryIds: entries.map((e) => e.id) },
      });

      // failed-batch
      await this.db.client.publishPlanOperation.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: {
          status: 'failed-batch',
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return true;
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
    entries: PublishOperation[],
    connector: Connector,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    planId: string,
    repoId: string,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId;
    const rawContents = entries.map((e) => e.content).filter(Boolean);
    const resolvedContents = await this.refResolverService.resolveBatchPseudoRefs(workbookId, rawContents, (asset) =>
      connector.resolveAssetReference(asset),
    );

    const contents: ParsedContent[] = [];
    const changedFieldsArray: Record<string, unknown>[] = [];
    const entriesWithOps: { entry: PublishOperation; resolvedContent: ParsedContent }[] = [];

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
      resolvedContent = {
        ...resolvedContent,
        [idField]: remoteId,
      } as ParsedContent;

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

    await connector.updateRecords(tableSpec, contents, changedFieldsArray);

    // Update Refs & Git
    // We can do this in parallel or sequentially. Sequential for safety.
    const refUpdates = entriesWithOps.map(({ entry, resolvedContent: resolvedOp }) => ({
      path: entry.filePath,
      content: resolvedOp,
    }));

    await this.fileReferenceService.updateRefsForFiles(workbookId, 'main', refUpdates);

    // Git Commit (Main) — always commit full content
    const gitFiles = refUpdates.map((u) => ({ path: u.path, content: JSON.stringify(u.content, null, 2) }));
    await this.scratchGitService.commitFilesToBranch(
      repoId,
      'main',
      gitFiles,
      `Publish V2 ${phase} batch (${entries.length})`,
    );

    // Git Commit (Dirty) — uses full content, not changedFields
    const dirtySyncBatch = entriesWithOps.map(({ entry, resolvedContent: resolvedOp }) => ({
      filePath: entry.filePath,
      content: JSON.stringify(resolvedOp, null, 2),
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

    const rawOps = entries
      .map((e) => {
        if (!e.content) return null;
        const entryContent = { ...(e.content as Record<string, unknown>) };
        // Strip temporary ID
        const idValue = entryContent[idField];
        if (isScratchPendingPublishId(idValue)) {
          delete entryContent[idField];
        }
        return entryContent;
      })
      .filter(Boolean) as ParsedContent[];

    const resolvedOps = await this.refResolverService.resolveBatchPseudoRefs(workbookId, rawOps);

    const operations: ConnectorFile[] = [];
    const entriesWithOps: { entry: PublishOperation; resolvedOp: ConnectorFile }[] = [];

    let opIndex = 0;
    for (const entry of entries) {
      if (!entry.content) continue;
      const resolvedOp = resolvedOps[opIndex++];
      operations.push(resolvedOp);
      entriesWithOps.push({ entry, resolvedOp });
    }

    if (operations.length === 0) return;

    // Bulk create
    const returnedRecords = await connector.createRecords(tableSpec, operations);

    // Post-process
    const fileIndexUpdates: { workbookId: string; folderPath: string; filename: string; recordId: string }[] = [];
    const refUpdates: { path: string; content: ParsedContent }[] = [];
    const gitFiles: { path: string; content: string }[] = [];

    for (let i = 0; i < entriesWithOps.length; i++) {
      const { entry, resolvedOp } = entriesWithOps[i];
      const returned = returnedRecords[i] || resolvedOp; // Fallback if connector doesn't return

      // Update File Index
      const realId = returned[idField];
      if (realId && (typeof realId === 'string' || typeof realId === 'number')) {
        const { folderPath, filename } = parsePath(entry.filePath);
        fileIndexUpdates.push({
          workbookId,
          folderPath,
          filename,
          recordId: String(realId),
        });
      } else if (realId) {
        WSLogger.error({
          source: 'PublishRunService.dispatchCreateBatch',
          message: 'Unexpected ID type in publish create batch',
          workbookId,
          filePath: entry.filePath,
          idField,
          idType: typeof realId,
          id: JSON.stringify(realId),
        });
      }

      // Update Refs
      refUpdates.push({ path: entry.filePath, content: returned as ParsedContent });

      // Git
      gitFiles.push({ path: entry.filePath, content: JSON.stringify(returned, null, 2) });
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
        content: JSON.stringify(returned, null, 2),
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
    const filters: { [key: string]: string }[] = [];
    const validEntries: PublishOperation[] = [];

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
