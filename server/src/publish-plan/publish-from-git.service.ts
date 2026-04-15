import { Injectable } from '@nestjs/common';
import { isScratchPendingPublishId, WorkbookId } from '@spinner/shared-types';
import { WSLogger } from 'src/logger';
import { JsonSafeObject, ParsedContent } from 'src/utils/objects';
import { CredentialEncryptionService } from '../credential-encryption/credential-encryption.service';
import { DbService } from '../db/db.service';
import { Connector } from '../remote-service/connectors/connector';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, ConnectorFile } from '../remote-service/connectors/types';
import { ScratchGitNotFoundError } from '../scratch-git/scratch-git.client';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { EncryptedData } from '../utils/encryption';
import { pickByShape } from './diff-utils';
import { FileReferenceService } from './file-reference.service';
import { RefResolverService } from './ref-resolver.service';
import { SchemaHelperService } from './schema-helper.service';
import { parsePath } from './utils';

// Shape of the plan.json written by `scratchmd plan-publish`
interface PlanMeta {
  planId: string;
  createdAt: string;
  connectionName: string;
  connectionId: string;
  summary: { edit: number; create: number; delete: number; backfill: number; rename: number };
  /** Table folder paths that have phase files, e.g. ["Folder/Table"]. */
  tablePaths: string[];
}

// Shape of edit/backfill phase files: { content, changedFields }
interface PhaseFileEnvelope {
  content: ParsedContent;
  changedFields: Record<string, unknown>;
}

// Shape of delete phase files: { remoteId }
interface DeletePhaseFile {
  remoteId: string;
}

type PlanPhase = 'edit' | 'create' | 'delete' | 'backfill' | 'rename';

type PhaseOperation = {
  /** Relative path within the connection dir, e.g. "public/posts/rec1.json" */
  relPath: string;
  /** Full git path to the plan file, e.g. "{planPath}/public/posts/edit/rec1.json" */
  gitPath: string;
  content: ParsedContent | null;
  remoteRecordId: string | null;
  changedFields: Record<string, unknown> | null;
};

export interface PublishFromGitResult {
  planId: string;
  connectionName: string;
  tableName: string;
  currentTableName: string;
  tableCount: number;
  currentPhase: string;
  processedCount: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  editsPlanned: number;
  createsPlanned: number;
  deletesPlanned: number;
  backfillsPlanned: number;
  renameFilesPlanned: number;
}

export type PublishFromGitProgressUpdate = PublishFromGitResult;

@Injectable()
export class PublishFromGitService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly connectorsService: ConnectorsService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly refResolverService: RefResolverService,
    private readonly schemaService: SchemaHelperService,
  ) {}

  /**
   * Execute a publish plan stored in the dirty branch at `planPath`.
   *
   * @param workbookId   The workbook that owns this connector
   * @param connectorAccountId   The connector account to publish to
   * @param planPath   Relative path inside the dirty branch to the plan folder,
   *                   e.g. "Airtable - MyBase/.scratch/publish-plans/20240101-120000"
   */
  async runFromGit(
    workbookId: WorkbookId,
    connectorAccountId: string,
    planPath: string,
    onProgress?: (progress: PublishFromGitProgressUpdate) => Promise<void>,
  ): Promise<PublishFromGitResult> {
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);

    // Read plan.json from dirty branch
    const planFile = await this.scratchGitService.getRepoFile(repoId, 'dirty', `${planPath}/plan.json`);
    if (!planFile) {
      throw new Error(`plan.json not found at dirty:${planPath}/plan.json`);
    }

    let plan: PlanMeta;
    try {
      plan = JSON.parse(planFile.content) as PlanMeta;
    } catch (err) {
      throw new Error(`Failed to parse plan.json: ${err instanceof Error ? err.message : String(err)}`);
    }

    WSLogger.info({
      source: 'PublishFromGitService.runFromGit',
      message: `Starting publish-from-git for plan ${plan.planId}`,
      workbookId,
      data: { planPath, planId: plan.planId, summary: plan.summary },
    });

    const connector = await this.resolveConnector(connectorAccountId);
    const tableSpecCache = new Map<string, BaseJsonTableSpec | null>();

    // Build hasLaterPhase by scanning backfill and delete directories
    const hasLaterPhase = await this.buildHasLaterPhase(repoId, plan.tablePaths);

    const editsPlanned = plan.summary.edit ?? 0;
    const createsPlanned = plan.summary.create ?? 0;
    const deletesPlanned = plan.summary.delete ?? 0;
    const backfillsPlanned = plan.summary.backfill ?? 0;
    const renameFilesPlanned = plan.summary.rename ?? 0;
    const totalCount = editsPlanned + createsPlanned + deletesPlanned + backfillsPlanned + renameFilesPlanned;
    const tableCount = plan.tablePaths.length;
    const tableName = tableCount === 1 ? describeTablePath(plan.tablePaths[0]) : '';

    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    let currentPhase = '';
    let currentTableName = '';

    const emitProgress = async () => {
      if (!onProgress) {
        return;
      }

      await onProgress({
        planId: plan.planId,
        connectionName: plan.connectionName,
        tableName,
        currentTableName,
        tableCount,
        currentPhase,
        processedCount,
        totalCount,
        successCount,
        failedCount,
        editsPlanned,
        createsPlanned,
        deletesPlanned,
        backfillsPlanned,
        renameFilesPlanned,
      });
    };

    await emitProgress();

    const phases: PlanPhase[] = ['edit', 'create', 'delete', 'backfill', 'rename'];

    for (const phase of phases) {
      currentPhase = phase;
      await emitProgress();

      const phaseFolders = await this.listPhaseFolders(repoId, plan.tablePaths, phase);
      if (phaseFolders.length === 0) continue;

      const plannedForPhase = getPlannedCountForPhase(
        phase,
        editsPlanned,
        createsPlanned,
        deletesPlanned,
        backfillsPlanned,
        renameFilesPlanned,
      );

      WSLogger.info({
        source: 'PublishFromGitService.runFromGit',
        message: `Executing ${phase} phase`,
        workbookId,
        data: { planId: plan.planId, phase, plannedForPhase, folderCount: phaseFolders.length },
      });

      if (phase === 'rename') {
        for (const { tablePath, phaseDir } of phaseFolders) {
          currentTableName = describeTablePath(tablePath);
          await emitProgress();

          let cursor: string | undefined;
          do {
            const page = await this.readPhaseFilesPage(repoId, phaseDir, 100, cursor);
            const folderOps = page.files.map((file) =>
              this.parsePhaseOperation(tablePath, phaseDir, phase, file.name, file.content),
            );
            if (folderOps.length === 0) {
              cursor = page.nextCursor;
              continue;
            }

            try {
              await this.dispatchRenameBatch(tablePath, folderOps, workbookId, repoId);
              successCount += folderOps.length;
            } catch (err) {
              failedCount += folderOps.length;
              WSLogger.error({
                source: 'PublishFromGitService.runFromGit',
                message: `Rename batch failed for folder ${tablePath}`,
                error: err,
                workbookId,
                data: { planId: plan.planId },
              });
            }

            processedCount += folderOps.length;
            await emitProgress();
            cursor = page.nextCursor;
          } while (cursor);
        }
      } else {
        const batchSize =
          phase === 'create'
            ? connector.getBatchSize('create')
            : phase === 'delete'
              ? connector.getBatchSize('delete')
              : connector.getBatchSize('update');

        for (const { tablePath, phaseDir } of phaseFolders) {
          currentTableName = describeTablePath(tablePath);
          await emitProgress();

          const tableSpec = await this.schemaService.getTableSpec(workbookId, tablePath, tableSpecCache);
          let cursor: string | undefined;

          do {
            const page = await this.readPhaseFilesPage(repoId, phaseDir, batchSize, cursor);
            const folderOps = page.files.map((file) =>
              this.parsePhaseOperation(tablePath, phaseDir, phase, file.name, file.content),
            );
            if (folderOps.length === 0) {
              cursor = page.nextCursor;
              continue;
            }

            if (!tableSpec) {
              WSLogger.warn({
                source: 'PublishFromGitService.runFromGit',
                message: `No tableSpec for folder ${tablePath}, skipping ${phase}`,
                workbookId,
              });
              failedCount += folderOps.length;
              processedCount += folderOps.length;
              await emitProgress();
              cursor = page.nextCursor;
              continue;
            }

            try {
              if (phase === 'delete') {
                await this.dispatchDeleteBatch(folderOps, connector, tableSpec, workbookId, repoId);
              } else if (phase === 'create') {
                await this.dispatchCreateBatch(folderOps, connector, tableSpec, workbookId, repoId, hasLaterPhase);
              } else {
                await this.dispatchUpdateBatch(
                  phase,
                  folderOps,
                  connector,
                  tableSpec,
                  workbookId,
                  repoId,
                  hasLaterPhase,
                );
              }
              successCount += folderOps.length;
            } catch (err) {
              failedCount += folderOps.length;
              WSLogger.error({
                source: 'PublishFromGitService.runFromGit',
                message: `${phase} batch failed (folder=${tablePath}, size=${folderOps.length})`,
                error: err,
                workbookId,
                data: { planId: plan.planId },
              });
            }

            processedCount += folderOps.length;
            await emitProgress();
            cursor = page.nextCursor;
          } while (cursor);
        }
      }
    }

    // Rebase dirty on main so published changes are reflected
    currentPhase = 'rebase';
    currentTableName = '';
    await emitProgress();

    WSLogger.info({
      source: 'PublishFromGitService.runFromGit',
      message: 'Rebasing dirty on main',
      workbookId,
      data: { planId: plan.planId },
    });
    await this.scratchGitService.rebaseDirty(repoId);

    WSLogger.info({
      source: 'PublishFromGitService.runFromGit',
      message: `Publish-from-git complete: ${successCount} succeeded, ${failedCount} failed`,
      workbookId,
      data: { planId: plan.planId },
    });

    return {
      planId: plan.planId,
      connectionName: plan.connectionName,
      tableName,
      currentTableName: '',
      tableCount,
      currentPhase,
      processedCount,
      totalCount,
      successCount,
      failedCount,
      editsPlanned,
      createsPlanned,
      deletesPlanned,
      backfillsPlanned,
      renameFilesPlanned,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase file loading
  // ---------------------------------------------------------------------------

  private async listPhaseFolders(
    repoId: string,
    tablePaths: string[],
    phase: PlanPhase,
  ): Promise<Array<{ tablePath: string; phaseDir: string }>> {
    const results: Array<{ tablePath: string; phaseDir: string }> = [];

    for (const tablePath of tablePaths) {
      const scratchTableDir = `.scratch/${tablePath}`;
      const scratchEntries = await this.scratchGitService
        .listRepoFiles(repoId, 'dirty', scratchTableDir)
        .catch(() => []);
      const planDir = scratchEntries.find((e) => e.type === 'directory' && e.name.startsWith('publish-plan-'));
      if (!planDir) continue;

      results.push({
        tablePath,
        phaseDir: `${scratchTableDir}/${planDir.name}/${phase}`,
      });
    }

    return results;
  }

  /**
   * Lists all { relPath, gitPath } pairs for a given phase.
   *
   * Used by the "has later phase" pre-scan. This stays metadata-only and
   * paginated so we avoid one file-read request per plan entry.
   */
  private async listPhaseFiles(
    repoId: string,
    tablePaths: string[],
    phase: PlanPhase,
  ): Promise<{ relPath: string; gitPath: string }[]> {
    const results: { relPath: string; gitPath: string }[] = [];
    const phaseFolders = await this.listPhaseFolders(repoId, tablePaths, phase);

    for (const { tablePath, phaseDir } of phaseFolders) {
      let cursor: string | undefined;
      do {
        const page = await this.listPhaseFilesPage(repoId, phaseDir, 500, cursor);
        for (const file of page.files) {
          results.push({
            relPath: `${tablePath}/${file.name}`,
            gitPath: `${phaseDir}/${file.name}`,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }

    return results;
  }

  /** Returns the set of rel_paths that appear in backfill or delete phases. */
  private async buildHasLaterPhase(repoId: string, tablePaths: string[]): Promise<Set<string>> {
    const [backfill, del] = await Promise.all([
      this.listPhaseFiles(repoId, tablePaths, 'backfill'),
      this.listPhaseFiles(repoId, tablePaths, 'delete'),
    ]);
    return new Set([...backfill.map((f) => f.relPath), ...del.map((f) => f.relPath)]);
  }

  private async listPhaseFilesPage(
    repoId: string,
    phaseDir: string,
    limit: number,
    cursor?: string,
  ): Promise<{ files: Array<{ name: string; path: string }>; nextCursor?: string }> {
    try {
      return await this.scratchGitService.listRepoFilesPaginated(repoId, 'dirty', phaseDir, limit, cursor);
    } catch (err) {
      if (err instanceof ScratchGitNotFoundError) {
        return { files: [] };
      }
      throw err;
    }
  }

  private async readPhaseFilesPage(
    repoId: string,
    phaseDir: string,
    limit: number,
    cursor?: string,
  ): Promise<{ files: Array<{ name: string; content: string }>; nextCursor?: string }> {
    try {
      return await this.scratchGitService.getRepoFilesPaginated(repoId, 'dirty', phaseDir, limit, cursor);
    } catch (err) {
      if (err instanceof ScratchGitNotFoundError) {
        return { files: [] };
      }
      throw err;
    }
  }

  private parsePhaseOperation(
    tablePath: string,
    phaseDir: string,
    phase: PlanPhase,
    fileName: string,
    fileContent: string,
  ): PhaseOperation {
    const relPath = `${tablePath}/${fileName}`;
    const gitPath = `${phaseDir}/${fileName}`;

    let content: ParsedContent | null = null;
    let remoteRecordId: string | null = null;
    let changedFields: Record<string, unknown> | null = null;

    try {
      const parsed = JSON.parse(fileContent) as unknown;
      if (phase === 'edit' || phase === 'backfill') {
        const envelope = parsed as PhaseFileEnvelope;
        content = envelope.content;
        changedFields = envelope.changedFields;
      } else if (phase === 'delete') {
        remoteRecordId = (parsed as DeletePhaseFile).remoteId ?? null;
      } else {
        content = parsed as ParsedContent;
      }
    } catch {
      WSLogger.warn({
        source: 'PublishFromGitService.parsePhaseOperation',
        message: `Failed to parse ${gitPath}`,
      });
    }

    return { relPath, gitPath, content, remoteRecordId, changedFields };
  }

  // ---------------------------------------------------------------------------
  // Edit / backfill dispatch
  // ---------------------------------------------------------------------------

  private async dispatchUpdateBatch(
    phase: string,
    entries: PhaseOperation[],
    connector: Connector<string, JsonSafeObject>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    repoId: string,
    hasLaterPhase: Set<string>,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId || 'id';
    const rawContents = entries.map((e) => e.content).filter(Boolean) as ParsedContent[];
    const resolvedContents = await this.refResolverService.resolveBatchPseudoRefs(workbookId, rawContents, (asset) =>
      connector.resolveAssetReference(asset),
    );

    const contents: ParsedContent[] = [];
    const changedFieldsArray: (Record<string, unknown> | undefined)[] = [];
    const entriesWithOps: { entry: PhaseOperation; resolvedContent: ParsedContent }[] = [];

    let opIndex = 0;
    for (const entry of entries) {
      if (!entry.content) continue;
      let resolvedContent = resolvedContents[opIndex++] as ParsedContent;

      // Resolve remote ID: try content `id` field, then file index
      const contentId = (entry.content as Record<string, unknown>)[idField];
      let remoteId = typeof contentId === 'string' || typeof contentId === 'number' ? String(contentId) : null;
      if (!remoteId) {
        const { folderPath, filename } = parsePath(entry.relPath);
        const filenameMap = await this.scratchGitService.lookupFilenamesByFolder(repoId, folderPath, [filename]);
        remoteId = filenameMap.get(filename) ?? null;
        if (!remoteId) {
          throw new Error(`Could not resolve remote ID for entry: ${entry.relPath}`);
        }
        // id was absent from content — inject the looked-up string id so the
        // connector and git both see a consistent value
        resolvedContent = { ...resolvedContent, [idField]: remoteId } as ParsedContent;
      }
      // When contentId was already present we leave resolvedContent[idField]
      // untouched so its native type (e.g. numeric Postgres id) is preserved
      // in git. remoteId (string) is kept for internal lookup only.

      if (entry.changedFields && Object.keys(entry.changedFields).length === 0) continue;

      const resolvedChangedFields = entry.changedFields
        ? pickByShape(resolvedContent as Record<string, unknown>, entry.changedFields)
        : undefined;

      contents.push(resolvedContent);
      changedFieldsArray.push(resolvedChangedFields);
      entriesWithOps.push({ entry, resolvedContent });
    }

    if (contents.length === 0) return;

    const hasChangedFields = changedFieldsArray.some((cf) => cf !== undefined);
    await connector.updateRecords(tableSpec, contents, hasChangedFields ? changedFieldsArray : undefined);

    const refUpdates = entriesWithOps.map(({ entry, resolvedContent }) => ({
      path: entry.relPath,
      content: resolvedContent,
    }));
    await this.fileReferenceService.updateRefsForFiles(workbookId, 'main', refUpdates);

    const gitFiles = refUpdates.map((u) => ({ path: u.path, content: JSON.stringify(u.content, null, 2) }));
    await this.scratchGitService.commitFilesToBranch(
      repoId,
      'main',
      gitFiles,
      `Publish V2 ${phase} batch (${entries.length})`,
    );

    // Sync to dirty for files that have no later phase
    const finalItems = entriesWithOps
      .filter(({ entry }) => !hasLaterPhase.has(entry.relPath))
      .map(({ entry, resolvedContent }) => ({
        path: entry.relPath,
        content: JSON.stringify(resolvedContent, null, 2),
      }));
    if (finalItems.length > 0) {
      await this.scratchGitService.commitFilesToBranch(repoId, 'dirty', finalItems, `Sync dirty after ${phase}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Create dispatch
  // ---------------------------------------------------------------------------

  private async dispatchCreateBatch(
    entries: PhaseOperation[],
    connector: Connector<string, JsonSafeObject>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    repoId: string,
    hasLaterPhase: Set<string>,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId || 'id';

    const rawOps = entries
      .map((e) => {
        if (!e.content) return null;
        const entryContent = { ...(e.content as Record<string, unknown>) };
        const idValue = entryContent[idField];
        if (isScratchPendingPublishId(idValue)) {
          delete entryContent[idField];
        }
        return entryContent;
      })
      .filter(Boolean) as ParsedContent[];

    const resolvedOps = await this.refResolverService.resolveBatchPseudoRefs(workbookId, rawOps, (asset) =>
      connector.resolveAssetReference(asset),
    );

    const operations: ParsedContent[] = [];
    const entriesWithOps: { entry: PhaseOperation; resolvedOp: ParsedContent }[] = [];

    let opIndex = 0;
    for (const entry of entries) {
      if (!entry.content) continue;
      const resolvedOp = resolvedOps[opIndex++] as ParsedContent;
      operations.push(resolvedOp);
      entriesWithOps.push({ entry, resolvedOp });
    }

    if (operations.length === 0) return;

    const returnedRecords = await connector.createRecords(tableSpec, operations as ConnectorFile[]);

    const fileIndexUpdates: { workbookId: string; folderPath: string; filename: string; recordId: string }[] = [];
    const refUpdates: { path: string; content: unknown }[] = [];
    const gitFiles: { path: string; content: string }[] = [];

    for (let i = 0; i < entriesWithOps.length; i++) {
      const { entry, resolvedOp } = entriesWithOps[i];
      const returned = (returnedRecords[i] ?? resolvedOp) as Record<string, unknown>;

      const realId = returned[idField];
      if (realId && (typeof realId === 'string' || typeof realId === 'number')) {
        const { folderPath, filename } = parsePath(entry.relPath);
        fileIndexUpdates.push({ workbookId, folderPath, filename, recordId: String(realId) });
      }

      refUpdates.push({ path: entry.relPath, content: returned });
      gitFiles.push({ path: entry.relPath, content: JSON.stringify(returned, null, 2) });
    }

    if (fileIndexUpdates.length > 0) {
      await this.scratchGitService.upsertIndexEntries(
        repoId,
        fileIndexUpdates.map((u) => ({ folder: u.folderPath, filename: u.filename, remoteId: u.recordId })),
      );
    }
    await this.fileReferenceService.updateRefsForFiles(
      workbookId,
      'main',
      refUpdates as { path: string; content: ParsedContent }[],
    );
    await this.scratchGitService.commitFilesToBranch(
      repoId,
      'main',
      gitFiles,
      `Publish V2 create batch (${entries.length})`,
    );

    // Sync to dirty for files with no later phase
    const finalItems = entriesWithOps
      .filter(({ entry }) => !hasLaterPhase.has(entry.relPath))
      .map(({ entry }, i) => ({
        path: entry.relPath,
        content: JSON.stringify((returnedRecords[i] ?? entriesWithOps[i].resolvedOp) as unknown, null, 2),
      }));
    if (finalItems.length > 0) {
      await this.scratchGitService.commitFilesToBranch(repoId, 'dirty', finalItems, `Sync dirty after create`);
    }
  }

  // ---------------------------------------------------------------------------
  // Delete dispatch
  // ---------------------------------------------------------------------------

  private async dispatchDeleteBatch(
    entries: PhaseOperation[],
    connector: Connector<string, JsonSafeObject>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    repoId: string,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId || 'id';
    const filters: Record<string, string>[] = [];
    const validEntries: PhaseOperation[] = [];

    for (const entry of entries) {
      if (entry.remoteRecordId) {
        filters.push({ [idField]: entry.remoteRecordId });
        validEntries.push(entry);
      }
    }

    if (filters.length === 0) return;

    await connector.deleteRecords(tableSpec, filters);

    const filesToDelete = validEntries.map((e) => e.relPath);

    await this.db.client.fileReference.deleteMany({
      where: { workbookId, sourceFilePath: { in: filesToDelete } },
    });

    const fileIndexDeletes = validEntries.map((e) => {
      const { folderPath, filename } = parsePath(e.relPath);
      return { folder: folderPath, filename };
    });
    if (fileIndexDeletes.length > 0) {
      await this.scratchGitService.deleteIndexEntries(repoId, fileIndexDeletes);
    }

    await this.scratchGitService.deleteFilesFromBranch(
      repoId,
      'main',
      filesToDelete,
      `Publish V2 delete batch (${filesToDelete.length})`,
    );
    await this.scratchGitService.deleteFilesFromBranch(
      repoId,
      'dirty',
      filesToDelete,
      `Sync dirty deletes (${filesToDelete.length})`,
    );
  }

  // ---------------------------------------------------------------------------
  // Rename dispatch
  // ---------------------------------------------------------------------------

  private async dispatchRenameBatch(
    folderPath: string,
    entries: PhaseOperation[],
    workbookId: string,
    repoId: string,
  ): Promise<void> {
    const filenames = entries.map((e) => parsePath(e.relPath).filename);

    const filenameToRecordId = await this.scratchGitService.lookupFilenamesByFolder(repoId, folderPath, filenames);

    const renames: { oldName: string; newName: string }[] = [];
    const fileIndexUpdates: { workbookId: string; folderPath: string; recordId: string; filename: string }[] = [];
    const refUpdates: { oldPath: string; newPath: string }[] = [];

    for (const entry of entries) {
      const { filename: oldName } = parsePath(entry.relPath);
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

    if (renames.length === 0) return;

    await this.scratchGitService.renameFiles(
      repoId,
      folderPath,
      renames,
      `Publish V2 rename batch (${renames.length})`,
    );
    await this.scratchGitService.upsertIndexEntries(
      repoId,
      fileIndexUpdates.map((u) => ({ folder: u.folderPath, filename: u.filename, remoteId: u.recordId })),
    );

    for (const ref of refUpdates) {
      await this.db.client.fileReference.updateMany({
        where: { workbookId, sourceFilePath: ref.oldPath },
        data: { sourceFilePath: ref.newPath },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async resolveConnector(connectorAccountId: string): Promise<Connector<string, JsonSafeObject>> {
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
}

function describeTablePath(tablePath: string): string {
  const segments = tablePath.split('/').filter(Boolean);
  return segments.at(-1) ?? tablePath;
}

function getPlannedCountForPhase(
  phase: PlanPhase,
  editsPlanned: number,
  createsPlanned: number,
  deletesPlanned: number,
  backfillsPlanned: number,
  renameFilesPlanned: number,
): number {
  switch (phase) {
    case 'edit':
      return editsPlanned;
    case 'create':
      return createsPlanned;
    case 'delete':
      return deletesPlanned;
    case 'backfill':
      return backfillsPlanned;
    case 'rename':
      return renameFilesPlanned;
    default:
      return 0;
  }
}
