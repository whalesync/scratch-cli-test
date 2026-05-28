import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { type DataFolderOptions, isScratchPendingPublishId, WorkbookId } from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { chunk } from 'lodash';
import { AssetIndexService } from 'src/asset/asset-index.service';
import { ParsedContent, Schema } from 'src/utils/objects';
import { CredentialEncryptionService } from '../credential-encryption/credential-encryption.service';
import { DbService } from '../db/db.service';
import { WSLogger } from '../logger';
import { Connector } from '../remote-service/connectors/connector';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec } from '../remote-service/connectors/types';
import { DIRTY_BRANCH, MAIN_BRANCH, ScratchGitService } from '../scratch-git/scratch-git.service';
import { EncryptedData } from '../utils/encryption';
import { computeChangedFields } from './diff-utils';
import { FileIndexService } from './file-index.service';
import { FileReferenceService } from './file-reference.service';
import { RefCleanerService } from './ref-cleaner.service';
import { SchemaHelperService } from './schema-helper.service';
import { PhaseRequiringChangedFields, PublishPlanInfo, PublishPlanPhase, PublishPlanStatus } from './types';
import { parsePath } from './utils';

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

  /** Returns all relevant repo IDs for a workbook. When connectorAccountId is provided, returns just that one. */
  private async resolveAllRepoIds(workbookId: WorkbookId, connectorAccountId?: string): Promise<string[]> {
    if (connectorAccountId) {
      const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
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

  async hasDiffs(
    workbookId: string,
    connectorAccountId?: string,
    folderPath?: string,
    filePath?: string,
  ): Promise<boolean> {
    const wkbId = workbookId as WorkbookId;
    const repoIds = await this.resolveAllRepoIds(wkbId, connectorAccountId);
    const allStatuses = await Promise.all(repoIds.map((id) => this.scratchGitService.getRepoStatus(id)));
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

    const wkbId = workbookId as WorkbookId;
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);

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

    let changes = await this.scratchGitService.getRepoStatus(repoId);

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

    // Cache table specs to avoid repeated reads
    // Cache table specs to avoid repeated reads
    const dataFolderCache = new Map<string, { id: string; tableId: string[]; spec: BaseJsonTableSpec } | null>();

    const getDataFolderInfo = async (folderPath: string) => {
      return this.schemaService.getDataFolderInfo(workbookId, folderPath, dataFolderCache);
    };

    // --- Prepare for "Delete Ref Clearing" ---
    // 1. Identify Deleted Record IDs (bulk lookup)

    await reportProgress(`Resolving deleted record IDs (${deletedFiles.length} files)`);

    const deletedLookups = deletedFiles.map((del) => {
      const { folderPath, filename: fileName } = parsePath(del.path);
      return { folderPath, filename: fileName };
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

    for (const del of deletedFiles) {
      const { folderPath, filename: fileName } = parsePath(del.path);
      const recordId = recordIdMap.get(`${folderPath}:${fileName}`) ?? null;
      const folderInfo = await getDataFolderInfo(folderPath);
      // Use the last segment of the remote tableId path as the remote table identifier
      const tableIdArr: string[] = folderInfo?.tableId ?? [];
      const remoteTableId: string | undefined = tableIdArr.length ? tableIdArr[tableIdArr.length - 1] : undefined;

      if (recordId) deletedRecordIds.add(recordId);
      deletedFileRecordIds.set(del.path, recordId);
      targetsForRefCheck.push({ remoteTableId, recordId: recordId ?? undefined });
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
    // Discriminated by phase: edit/backfill require `changedFields` (the sparse
    // partial that gets PATCHed). The other phases never use it.
    type PlanOperation =
      | {
          phase: PhaseRequiringChangedFields;
          filePath: string;
          content: ParsedContent;
          changedFields: Record<string, unknown>;
          remoteRecordId?: string | null;
          dataFolderId?: string | null;
          status: string;
        }
      | {
          phase: Exclude<PublishPlanPhase, PhaseRequiringChangedFields>;
          filePath: string;
          content: ParsedContent;
          remoteRecordId?: string | null;
          dataFolderId?: string | null;
          status: string;
        };
    const planOperations: PlanOperation[] = [];

    const savePlanOperations = async () => {
      if (planOperations.length === 0) return;
      await this.db.client.publishPlanOperation.createMany({
        data: planOperations.map((e) => ({
          planId: pipelineId,
          filePath: e.filePath,
          phase: e.phase,
          content: e.content,
          changedFields:
            e.phase === 'edit' || e.phase === 'backfill' ? (e.changedFields as Prisma.InputJsonValue) : undefined,
          remoteRecordId: e.remoteRecordId ?? null,
          dataFolderId: e.dataFolderId ?? null,
          status: e.status,
        })),
      });
      planOperations.length = 0;
    };

    // --- Phase 0: [asset-upload] ---
    // Create asset-upload operations for destination assets that need uploading
    if (connectorAccountId) {
      await reportProgress('Checking for assets to upload');
      const connector = await this.resolveConnector(connectorAccountId);
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
    const filesToProcessInEditPhase = new Set(modifiedFiles.map((f) => f.path));
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
            // Not JSON? Just commit as is if it was user-modified.
            if (modifiedFiles.some((m) => m.path === filePath)) {
              const { folderPath } = parsePath(filePath);
              const info = await getDataFolderInfo(folderPath);

              planOperations.push({
                filePath,
                phase: 'edit',
                content: JSON.parse(rawContent) as ParsedContent,
                changedFields: {},
                dataFolderId: info?.id,
                status: 'pending',
              });
              editCount++;
              liveCounts.editsPlanned++;
            }
            continue;
          }

          const { folderPath } = parsePath(filePath);
          const info = await getDataFolderInfo(folderPath);
          const schema = info?.spec?.schema as Schema;
          const dataFolderId = info?.id;

          // --- THREE PASS STRIPPING ---

          // Pass 1: Strip references to DELETED records.
          const pass1ContentObj = this.refCleanerService.stripDeletedRecordRefs(contentObj, schema, deletedRecordIds);
          const pass1ContentStr = JSON.stringify(pass1ContentObj, null, 2);

          // Pass 2: Strip references to NEW records (Pseudo-refs).
          const pass2ContentObj = this.refCleanerService.stripPseudoRefs(pass1ContentObj, schema);
          const pass2ContentStr = JSON.stringify(pass2ContentObj, null, 2);

          // Pass 3: Strip @asset/ pseudo-refs (schema-agnostic).
          const pass3ContentObj = this.refCleanerService.stripAssetPseudoRefs(pass2ContentObj);
          const pass3ContentStr = JSON.stringify(pass3ContentObj, null, 2);

          // Determine Edit Operation
          const originalContentStr = JSON.stringify(contentObj, null, 2);
          const isUserModified = modifiedFiles.some((m) => m.path === filePath);
          const isRefCleared = pass1ContentStr !== originalContentStr;
          const isPseudoStripped = pass2ContentStr !== pass1ContentStr;
          const isAssetStripped = pass3ContentStr !== pass2ContentStr;

          if (isUserModified || isRefCleared || isPseudoStripped || isAssetStripped) {
            // Compute changedFields by diffing main vs dirty (after stripping)
            const mainRaw = mainMap.get(filePath);
            const mainObj = mainRaw ? (JSON.parse(mainRaw) as Record<string, unknown>) : null;
            const changed = mainObj
              ? computeChangedFields(mainObj, pass3ContentObj as Record<string, unknown>)
              : (pass3ContentObj as Record<string, unknown>);

            planOperations.push({
              filePath,
              phase: 'edit',
              content: pass3ContentObj,
              changedFields: changed,
              dataFolderId: dataFolderId || null,
              status: 'pending',
            });
            editCount++;
            liveCounts.editsPlanned++;

            // Backfill Logic — backfill if pseudo-refs or asset-refs were stripped
            if (pass3ContentStr !== pass1ContentStr) {
              // changedFields for backfill: diff between fully-stripped (pass3) and pre-pseudo (pass1)
              const backfillChanged = computeChangedFields(
                pass3ContentObj as Record<string, unknown>,
                pass1ContentObj as Record<string, unknown>,
              );

              planOperations.push({
                filePath,
                phase: 'backfill',
                content: pass1ContentObj,
                changedFields: backfillChanged,
                dataFolderId: dataFolderId || null,
                status: 'pending',
              });
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
            planOperations.push({
              filePath: add.path,
              phase: 'create',
              content: JSON.parse(rawContent) as ParsedContent,
              dataFolderId: info?.id || null,
              status: 'pending',
            });
            createCount++;
            liveCounts.createsPlanned++;
            if (isScratchPendingPublishId(filename)) {
              planOperations.push({
                filePath: add.path,
                phase: 'rename-files',
                content: {},
                dataFolderId: info?.id || null,
                status: 'pending',
              });
              liveCounts.renameFilesPlanned++;
            }
            continue;
          }

          const schema = info?.spec?.schema as Schema;
          const dataFolderId = info?.id;

          // Pass 1: Strip Deleted
          const pass1ContentObj = this.refCleanerService.stripDeletedRecordRefs(contentObj, schema, deletedRecordIds);
          const pass1ContentStr = JSON.stringify(pass1ContentObj, null, 2);

          // Pass 2: Strip Pseudo
          const pass2ContentObj = this.refCleanerService.stripPseudoRefs(pass1ContentObj, schema);

          // Pass 3: Strip @asset/ pseudo-refs
          const pass3ContentObj = this.refCleanerService.stripAssetPseudoRefs(pass2ContentObj);
          const pass3ContentStr = JSON.stringify(pass3ContentObj, null, 2);

          planOperations.push({
            filePath: add.path,
            phase: 'create',
            content: pass3ContentObj,
            dataFolderId: dataFolderId || null,
            status: 'pending',
          });
          createCount++;
          liveCounts.createsPlanned++;

          if (isScratchPendingPublishId(filename)) {
            planOperations.push({
              filePath: add.path,
              phase: 'rename-files',
              content: {},
              dataFolderId: dataFolderId || null,
              status: 'pending',
            });
            liveCounts.renameFilesPlanned++;
          }

          if (pass3ContentStr !== pass1ContentStr) {
            // The create above sent pass3 (refs stripped). Anything that differs in
            // pass1 is a ref that got stripped and now needs to be written back once
            // the create has resolved IDs — that's exactly what this backfill is for.
            // The diff (pass3 vs pass1) gives us the keys that were stripped, which is
            // the sparse partial the connector should PATCH.
            //
            // Example: user creates a new article that references a co-pending author.
            //   pass1: { title: 'Hi', authorId: '@/people/jane.json', cover: '@asset/x' }
            //   pass3: { title: 'Hi', authorId: null,                 cover: null       }
            //   create posts pass3 (Jane's id and the asset id aren't known yet).
            //   diff(pass3, pass1) => { authorId: '@/people/jane.json', cover: '@asset/x' }
            //   the publish runner later resolves those refs and PATCHes the new record.
            const backfillChanged = computeChangedFields(
              pass3ContentObj as Record<string, unknown>,
              pass1ContentObj as Record<string, unknown>,
            );
            planOperations.push({
              filePath: add.path,
              phase: 'backfill',
              content: pass1ContentObj,
              changedFields: backfillChanged,
              dataFolderId: dataFolderId || null,
              status: 'pending',
            });
            liveCounts.backfillsPlanned++;
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

  private async resolveConnector(connectorAccountId: string): Promise<Connector> {
    const account = await this.db.client.connectorAccount.findUnique({
      where: { id: connectorAccountId },
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
