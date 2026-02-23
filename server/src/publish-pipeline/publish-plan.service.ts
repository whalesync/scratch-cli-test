import { Injectable } from '@nestjs/common';
import { FileDiffStatus, WorkbookId } from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { chunk } from 'lodash';
import { ParsedContent, Schema } from 'src/utils/objects';
import { DbService } from '../db/db.service';
import { WSLogger } from '../logger';
import { BaseJsonTableSpec } from '../remote-service/connectors/types';
import { DIRTY_BRANCH, MAIN_BRANCH, ScratchGitService } from '../scratch-git/scratch-git.service';
import { FileIndexService } from './file-index.service';
import { FileReferenceService } from './file-reference.service';
import { PublishSchemaService } from './publish-schema.service';
import { RefCleanerService } from './ref-cleaner.service';
import { PipelinePhase, PublishPlanInfo, PublishPlanPhase } from './types';
import { parsePath } from './utils';

@Injectable()
export class PublishPlanService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly refCleanerService: RefCleanerService,
    private readonly schemaService: PublishSchemaService,
  ) {}

  /**
   * Creates a new pipeline record in the database.
   * Can be called independently (e.g. from controller before enqueuing a job).
   */
  async createPipeline(
    workbookId: string,
    userId: string,
    connectorAccountId?: string,
  ): Promise<{ pipelineId: string; branchName: string }> {
    const pipelineId = randomUUID();
    const branchName = `publish/${userId}/${pipelineId}`;

    await this.db.client.publishPlan.create({
      data: {
        id: pipelineId,
        workbookId,
        userId,
        status: 'planning',
        branchName,
        phases: [],
        connectorAccountId: connectorAccountId || null,
      },
    });

    return { pipelineId, branchName };
  }

  async hasDiffs(workbookId: string, connectorAccountId?: string): Promise<boolean> {
    const wkbId = workbookId as WorkbookId;
    const changes = (await this.scratchGitService.getRepoStatus(wkbId)) as Array<{ path: string; status: string }>;
    if (changes.length === 0) return false;
    if (!connectorAccountId) return true;

    const dataFolders = await this.db.client.dataFolder.findMany({ where: { workbookId: wkbId, connectorAccountId } });
    const prefixes = dataFolders
      .map((df) => df.path)
      .filter((p): p is string => !!p)
      .map((p) => (p.startsWith('/') ? p.substring(1) : p))
      .map((p) => (p.endsWith('/') ? p : p + '/'));

    if (prefixes.length === 0) return false;
    return changes.some((c) => prefixes.some((prefix) => c.path.startsWith(prefix)));
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
    onProgress?: (step: string) => Promise<void>,
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

    // 2. Get diff between main and dirty
    let changes = (await this.scratchGitService.getRepoStatus(wkbId)) as Array<{
      path: string;
      status: FileDiffStatus;
    }>;

    await onProgress?.(`Diffing branches (${changes.length} changes found)`);

    if (connectorAccountId) {
      // Find all data folders for this connector in this workbook
      const dataFolders = await this.db.client.dataFolder.findMany({
        where: { workbookId: wkbId, connectorAccountId },
      });

      const prefixes = dataFolders
        .map((df) => df.path)
        .filter((p): p is string => !!p)
        .map((p) => (p.startsWith('/') ? p.substring(1) : p)) // Normalize: remove leading slash
        .map((p) => (p.endsWith('/') ? p : p + '/'));

      if (prefixes.length > 0) {
        changes = changes.filter((c) => prefixes.some((prefix) => c.path.startsWith(prefix)));
      } else {
        // No folders? Then no changes for this connector.
        changes = [];
      }
    }

    const modifiedFiles = changes.filter((c) => c.status === 'modified');
    const addedFiles = changes.filter((c) => c.status === 'added');
    const deletedFiles = changes.filter((c) => c.status === 'deleted');

    const phases: PipelinePhase[] = [];

    // Cache table specs to avoid repeated reads
    // Cache table specs to avoid repeated reads
    const dataFolderCache = new Map<string, { id: string; spec: BaseJsonTableSpec } | null>();

    const getDataFolderInfo = async (folderPath: string) => {
      return this.schemaService.getDataFolderInfo(workbookId, folderPath, dataFolderCache);
    };

    // --- Prepare for "Delete Ref Clearing" ---
    // 1. Identify Deleted Record IDs (bulk lookup)

    await onProgress?.(`Resolving deleted record IDs (${deletedFiles.length} files)`);

    const deletedLookups = deletedFiles.map((del) => {
      const { folderPath, filename: fileName } = parsePath(del.path);
      return { folderPath, filename: fileName };
    });
    const recordIdMap = await this.fileIndexService.getRecordIds(workbookId, deletedLookups);

    const deletedRecordIds = new Set<string>();
    const deletedFileRecordIds = new Map<string, string | null>();
    const targetsForRefCheck: Array<{ folderPath: string; fileName: string; recordId?: string }> = [];

    for (const del of deletedFiles) {
      const { folderPath, filename: fileName } = parsePath(del.path);
      const recordId = recordIdMap.get(`${folderPath}:${fileName}`) ?? null;

      if (recordId) deletedRecordIds.add(recordId);
      deletedFileRecordIds.set(del.path, recordId);
      targetsForRefCheck.push({ folderPath, fileName, recordId: recordId ?? undefined });
    }

    // 2. Identify Inbound Refs to Deleted Files
    // TODO: do we need to search in both branches?
    const searchBranches = [MAIN_BRANCH, DIRTY_BRANCH];
    const inboundRefs = await this.fileReferenceService.findRefsToFiles(
      workbookId,
      targetsForRefCheck,
      searchBranches,
      onProgress,
    );

    // Identify files that need editing because they reference a deleted file.
    // This includes files that are themselves being deleted — their FK references
    // must still be cleared in the edit phase before the delete phase runs,
    // since delete ordering is not guaranteed.
    const filesReferringToDeletedFiles = new Set<string>();
    for (const ref of inboundRefs) {
      filesReferringToDeletedFiles.add(ref.sourceFilePath);
    }

    // --- Phase 1: [edit] ---
    // Process Union of Modified Files and Ref-Clearing Candidate Files
    const filesToProcessInEditPhase = new Set(modifiedFiles.map((f) => f.path));
    for (const p of filesReferringToDeletedFiles) filesToProcessInEditPhase.add(p);

    let editCount = 0;
    const editPhaseTotal = filesToProcessInEditPhase.size;
    let editPhaseProcessed = 0;
    const planEntries: Array<{
      filePath: string;
      phase: PublishPlanPhase;
      operation: ParsedContent;
      remoteRecordId?: string | null;
      dataFolderId?: string | null;
      status: string;
    }> = [];

    const savePlanEntries = async () => {
      if (planEntries.length === 0) return;
      await this.db.client.publishPlanEntry.createMany({
        data: planEntries.map((e) => ({
          planId: pipelineId,
          filePath: e.filePath,
          phase: e.phase,
          operation: e.operation,
          remoteRecordId: e.remoteRecordId ?? null,
          dataFolderId: e.dataFolderId ?? null,
          status: e.status,
        })),
      });
      planEntries.length = 0;
    };

    for (const editBatch of chunk(Array.from(filesToProcessInEditPhase), 100)) {
      // Bulk fetch from dirty; fall back to main for any missing paths
      const dirtyResults = await this.scratchGitService.readRepoFilesByFolder(wkbId, 'dirty', editBatch);
      const dirtyMap = new Map(dirtyResults.map((r) => [r.path, r.content]));

      const missingPaths = editBatch.filter((p) => !dirtyMap.get(p));
      const mainMap = new Map<string, string | null>();
      if (missingPaths.length > 0) {
        const mainResults = await this.scratchGitService.readRepoFilesByFolder(wkbId, 'main', missingPaths);
        for (const r of mainResults) mainMap.set(r.path, r.content);
      }

      for (const filePath of editBatch) {
        editPhaseProcessed++;
        if (editPhaseProcessed === 1 || editPhaseProcessed % 50 === 0 || editPhaseProcessed === editPhaseTotal) {
          await onProgress?.(`Processing edits (${editPhaseProcessed}/${editPhaseTotal})`);
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

              planEntries.push({
                filePath,
                phase: 'edit',
                operation: JSON.parse(rawContent) as ParsedContent,
                dataFolderId: info?.id,
                status: 'pending',
              });
              editCount++;
            }
            continue;
          }

          const { folderPath } = parsePath(filePath);
          const info = await getDataFolderInfo(folderPath);
          const schema = info?.spec?.schema as Schema;
          const dataFolderId = info?.id;

          // --- TWO PASS STRIPPING ---

          // Pass 1: Strip references to DELETED records.
          const pass1ContentObj = this.refCleanerService.stripDeletedRecordRefs(contentObj, schema, deletedRecordIds);
          const pass1ContentStr = JSON.stringify(pass1ContentObj, null, 2);

          // Pass 2: Strip all pseudo-refs (@/ references) unconditionally.
          const pass2ContentObj = this.refCleanerService.stripPseudoRefs(pass1ContentObj, schema);
          const pass2ContentStr = JSON.stringify(pass2ContentObj, null, 2);

          // Determine Edit Operation
          const originalContentStr = JSON.stringify(contentObj, null, 2);
          const isUserModified = modifiedFiles.some((m) => m.path === filePath);
          const isRefCleared = pass1ContentStr !== originalContentStr;
          const isPseudoStripped = pass2ContentStr !== pass1ContentStr;

          if (isUserModified || isRefCleared || isPseudoStripped) {
            planEntries.push({
              filePath,
              phase: 'edit',
              operation: pass2ContentObj,
              dataFolderId: dataFolderId || null,
              status: 'pending',
            });
            editCount++;

            // Backfill Logic
            if (pass2ContentStr !== pass1ContentStr) {
              planEntries.push({
                filePath,
                phase: 'backfill',
                operation: pass1ContentObj,
                dataFolderId: dataFolderId || null,
                status: 'pending',
              });
            }
          }
        }
      }
      await savePlanEntries();
    }

    if (editCount > 0) {
      phases.push({ type: 'edit', recordCount: editCount });
    }

    // --- Phase 2: [create] ---
    let createCount = 0;
    let createPhaseProcessed = 0;
    const createPhaseTotal = addedFiles.length;

    for (const createBatch of chunk(addedFiles, 100)) {
      const batchPaths = createBatch.map((f) => f.path);
      const dirtyResults = await this.scratchGitService.readRepoFilesByFolder(wkbId, 'dirty', batchPaths);
      const dirtyMap = new Map(dirtyResults.map((r) => [r.path, r.content]));

      for (const add of createBatch) {
        createPhaseProcessed++;
        if (
          createPhaseProcessed === 1 ||
          createPhaseProcessed % 50 === 0 ||
          createPhaseProcessed === createPhaseTotal
        ) {
          await onProgress?.(`Processing creates (${createPhaseProcessed}/${createPhaseTotal})`);
        }

        const rawContent = dirtyMap.get(add.path);
        if (rawContent) {
          const { folderPath } = parsePath(add.path);
          const info = await getDataFolderInfo(folderPath);

          let contentObj: ParsedContent;
          try {
            contentObj = JSON.parse(rawContent) as ParsedContent;
          } catch {
            planEntries.push({
              filePath: add.path,
              phase: 'create',
              operation: JSON.parse(rawContent) as ParsedContent,
              dataFolderId: info?.id || null,
              status: 'pending',
            });
            createCount++;
            continue;
          }

          const schema = info?.spec?.schema as Schema;
          const dataFolderId = info?.id;

          // Pass 1: Strip references to DELETED records.
          const pass1ContentObj = this.refCleanerService.stripDeletedRecordRefs(contentObj, schema, deletedRecordIds);
          const pass1ContentStr = JSON.stringify(pass1ContentObj, null, 2);

          // Pass 2: Strip all pseudo-refs (@/ references) unconditionally.
          const pass2ContentObj = this.refCleanerService.stripPseudoRefs(pass1ContentObj, schema);
          const pass2ContentStr = JSON.stringify(pass2ContentObj, null, 2);

          planEntries.push({
            filePath: add.path,
            phase: 'create',
            operation: pass2ContentObj,
            dataFolderId: dataFolderId || null,
            status: 'pending',
          });
          createCount++;

          if (pass2ContentStr !== pass1ContentStr) {
            planEntries.push({
              filePath: add.path,
              phase: 'backfill',
              operation: pass1ContentObj,
              dataFolderId: dataFolderId || null,
              status: 'pending',
            });
          }
        }
      }
      await savePlanEntries();
    }

    if (createCount > 0) {
      phases.push({ type: 'create', recordCount: createCount });
    }

    // --- Phase 3: [delete] ---
    const deletePhaseTotal = deletedFiles.length;
    let deletePhaseProcessed = 0;

    for (const del of deletedFiles) {
      deletePhaseProcessed++;
      if (deletePhaseProcessed === 1 || deletePhaseProcessed % 50 === 0 || deletePhaseProcessed === deletePhaseTotal) {
        await onProgress?.(`Processing deletes (${deletePhaseProcessed}/${deletePhaseTotal})`);
      }
      // recordId was already looked up above when building deletedRecordIds
      const recordId = deletedFileRecordIds.get(del.path);
      const { folderPath } = parsePath(del.path);
      const info = await getDataFolderInfo(folderPath);

      planEntries.push({
        filePath: del.path,
        phase: 'delete',
        operation: {},
        remoteRecordId: recordId || null,
        dataFolderId: info?.id || null,
        status: 'pending',
      });
    }

    if (deletedFiles.length > 0) {
      phases.push({ type: 'delete', recordCount: deletedFiles.length });
    }

    await onProgress?.('Saving plan entries');
    await savePlanEntries();

    // Mark as planned (ready to run)
    await this.db.client.publishPlan.update({
      where: { id: pipelineId },
      data: { status: 'planned' },
    });

    return {
      pipelineId,
      workbookId,
      userId,
      phases,
      branchName,
      createdAt: new Date(),
      status: 'planned',
    };
  }
}
