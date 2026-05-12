import { Injectable } from '@nestjs/common';
import { type DataFolderOptions, isScratchPendingPublishId, WorkbookId } from '@spinner/shared-types';
import { cloneDeep } from 'lodash';
import { WSLogger } from 'src/logger';
import { JsonSafeObject, ParsedContent } from 'src/utils/objects';
import { CredentialEncryptionService } from '../credential-encryption/credential-encryption.service';
import { DbService } from '../db/db.service';
import { Connector } from '../remote-service/connectors/connector';
import { ConnectorsService } from '../remote-service/connectors/connectors.service';
import { exceptionForConnectorError } from '../remote-service/connectors/error';
import {
  BaseJsonTableSpec,
  clearRecordId,
  ConnectorFile,
  IdPath,
  readRecordId,
  readRecordIdAsString,
  recordWithId,
  writeRecordId,
} from '../remote-service/connectors/types';
import { ScratchGitNotFoundError } from '../scratch-git/scratch-git.client';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { assertUnreachable } from '../utils/asserts';
import { EncryptedData } from '../utils/encryption';
import { formatJsonWithPrettier } from '../utils/json-formatter';
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

interface BasePhaseOperation {
  /** Relative path within the connection dir, e.g. "public/posts/rec1.json" */
  relPath: string;
}

interface EditPhaseOperation extends BasePhaseOperation {
  phase: 'edit';
  content: ParsedContent;
  changedFields: Record<string, unknown>;
  remoteId: string;
}

interface BackfillPhaseOperation extends BasePhaseOperation {
  phase: 'backfill';
  content: ParsedContent;
  changedFields: Record<string, unknown>;
  remoteId: string;
}

interface CreatePhaseOperation extends BasePhaseOperation {
  phase: 'create';
  content: ParsedContent;
}

interface DeletePhaseOperation extends BasePhaseOperation {
  phase: 'delete';
  remoteId: string;
}

interface RenamePhaseOperation extends BasePhaseOperation {
  phase: 'rename';
}

type PhaseOperation =
  | EditPhaseOperation
  | BackfillPhaseOperation
  | CreatePhaseOperation
  | DeletePhaseOperation
  | RenamePhaseOperation;

type UpdatePhaseOperation = EditPhaseOperation | BackfillPhaseOperation;

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
   * Return the set of normalized DataFolder paths in this workbook/connector
   * that are marked read-only by the user (options.readOnly === true). Used
   * to skip locked folders when running a plan built locally by the CLI.
   */
  private async loadReadOnlyFolderPaths(workbookId: WorkbookId, connectorAccountId: string): Promise<Set<string>> {
    const folders = await this.db.client.dataFolder.findMany({
      where: { workbookId, connectorAccountId },
      select: { path: true, options: true },
    });
    const result = new Set<string>();
    for (const f of folders) {
      if (!f.path) continue;
      if ((f.options as DataFolderOptions | null)?.readOnly) {
        result.add(normalizeReadOnlyPath(f.path));
      }
    }
    return result;
  }

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

    // Read-only folders are excluded from publish (DEV-9928). The plan.json
    // file is built locally by the CLI / Rust plan-builder, which today does
    // not know about DataFolder.options. Re-check here against Postgres so
    // user-locked folders never publish via this path either.
    const readOnlyFolderPaths = await this.loadReadOnlyFolderPaths(workbookId, connectorAccountId);

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
    let publishError: Error | null = null;

    try {
      for (const phase of phases) {
        currentPhase = phase;
        await emitProgress();

        const rawPhaseFolders = await this.listPhaseFolders(repoId, plan.tablePaths, phase);
        const phaseFolders = rawPhaseFolders.filter(({ tablePath }) => {
          if (!readOnlyFolderPaths.has(normalizeReadOnlyPath(tablePath))) return true;
          WSLogger.info({
            source: 'PublishFromGitService.runFromGit',
            message: `Skipping read-only folder during ${phase} phase`,
            workbookId,
            data: { planId: plan.planId, tablePath },
          });
          return false;
        });
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
              const folderOps = [...page.files]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((file) => this.parsePhaseOperation(tablePath, phaseDir, phase, file.name, file.content))
                .filter((op): op is RenamePhaseOperation => op?.phase === 'rename');
              if (folderOps.length === 0) {
                cursor = page.nextCursor;
                continue;
              }

              try {
                await this.dispatchRenameBatch(tablePath, folderOps, workbookId, repoId);
                successCount += folderOps.length;
                processedCount += folderOps.length;
                await emitProgress();
              } catch (err) {
                failedCount += folderOps.length;
                WSLogger.error({
                  source: 'PublishFromGitService.runFromGit',
                  message: `Rename batch failed for folder ${tablePath}`,
                  error: err,
                  workbookId,
                  data: { planId: plan.planId },
                });
                await emitProgress();
                throw new Error(
                  `Publish failed in rename phase for ${describeTablePath(tablePath)}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
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
              if (page.files.length === 0) {
                cursor = page.nextCursor;
                continue;
              }

              if (!tableSpec) {
                WSLogger.warn({
                  source: 'PublishFromGitService.runFromGit',
                  message: `No tableSpec for folder ${tablePath}, skipping ${phase}`,
                  workbookId,
                });
                failedCount += page.files.length;
                await emitProgress();
                throw new Error(`No table spec found for ${describeTablePath(tablePath)} during ${phase} publish`);
              }

              const sortedFiles = [...page.files].sort((a, b) => a.name.localeCompare(b.name));
              let count = 0;
              try {
                if (phase === 'delete') {
                  const deletes = sortedFiles
                    .map((f) => this.parsePhaseOperation(tablePath, phaseDir, 'delete', f.name, f.content))
                    .filter((op): op is DeletePhaseOperation => op !== null);
                  count = deletes.length;
                  if (count > 0) {
                    await this.dispatchDeleteBatch(deletes, connector, tableSpec, workbookId, repoId);
                  }
                } else if (phase === 'create') {
                  const creates = sortedFiles
                    .map((f) => this.parsePhaseOperation(tablePath, phaseDir, 'create', f.name, f.content))
                    .filter((op): op is CreatePhaseOperation => op !== null);
                  count = creates.length;
                  if (count > 0) {
                    await this.dispatchCreateBatch(creates, connector, tableSpec, workbookId, repoId, hasLaterPhase);
                  }
                } else {
                  const idField = tableSpec.idColumnRemoteId;
                  const updates = await this.parseAndResolveUpdatePhaseOps(
                    repoId,
                    tablePath,
                    phaseDir,
                    phase,
                    sortedFiles,
                    idField,
                  );
                  count = updates.length;
                  if (count > 0) {
                    await this.dispatchUpdateBatch(
                      phase,
                      updates,
                      connector,
                      tableSpec,
                      workbookId,
                      repoId,
                      hasLaterPhase,
                    );
                  }
                }
                if (count > 0) {
                  successCount += count;
                  processedCount += count;
                  await emitProgress();
                }
              } catch (err) {
                failedCount += count > 0 ? count : page.files.length;
                WSLogger.error({
                  source: 'PublishFromGitService.runFromGit',
                  message: `${phase} batch failed (folder=${tablePath}, size=${count})`,
                  error: err,
                  workbookId,
                  data: { planId: plan.planId },
                });
                await emitProgress();
                throw exceptionForConnectorError(err, connector);
              }
              cursor = page.nextCursor;
            } while (cursor);
          }
        }
      }
    } catch (err) {
      publishError = err instanceof Error ? err : new Error(String(err));
    }

    if (publishError) {
      WSLogger.info({
        source: 'PublishFromGitService.runFromGit',
        message: 'Rebasing dirty on main after failed publish',
        workbookId,
        data: { planId: plan.planId },
      });
      await this.scratchGitService.rebaseDirty(repoId);
      throw publishError;
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

    return results.sort((a, b) => a.tablePath.localeCompare(b.tablePath));
  }

  /**
   * Lists all relPaths of files in a given phase.
   *
   * Used by the "has later phase" pre-scan. This stays metadata-only and
   * paginated so we avoid one file-read request per plan entry.
   */
  private async listPhaseFiles(repoId: string, tablePaths: string[], phase: PlanPhase): Promise<string[]> {
    const results: string[] = [];
    const phaseFolders = await this.listPhaseFolders(repoId, tablePaths, phase);

    for (const { tablePath, phaseDir } of phaseFolders) {
      let cursor: string | undefined;
      do {
        const page = await this.listPhaseFilesPage(repoId, phaseDir, 500, cursor);
        for (const file of page.files) {
          results.push(`${tablePath}/${file.name}`);
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
    return new Set([...backfill, ...del]);
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

  private parsePhaseOperation<P extends 'create' | 'delete' | 'rename'>(
    tablePath: string,
    phaseDir: string,
    phase: P,
    fileName: string,
    fileContent: string,
  ): Extract<PhaseOperation, { phase: P }> | null {
    const relPath = `${tablePath}/${fileName}`;
    const gitPath = `${phaseDir}/${fileName}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fileContent);
    } catch {
      WSLogger.warn({
        source: 'PublishFromGitService.parsePhaseOperation',
        message: `Failed to parse ${gitPath}`,
      });
      return null;
    }

    switch (phase) {
      case 'create':
        return { phase, relPath, content: parsed as ParsedContent } as Extract<PhaseOperation, { phase: P }>;
      case 'delete': {
        const remoteId = (parsed as DeletePhaseFile).remoteId;
        if (!remoteId) {
          WSLogger.warn({
            source: 'PublishFromGitService.parsePhaseOperation',
            message: `Delete phase file is missing remoteId: ${gitPath}`,
          });
          return null;
        }
        return { phase, relPath, remoteId } as Extract<PhaseOperation, { phase: P }>;
      }
      case 'rename':
        return { phase, relPath } as Extract<PhaseOperation, { phase: P }>;
      default:
        assertUnreachable(phase);
    }
  }

  /**
   * Parse a page of edit/backfill phase files and resolve each entry's `remoteId`.
   *
   * For most entries, `remoteId` is read directly from `content[idField]`. Entries
   * whose content lacks the id (e.g. user removed it from the JSON) are resolved in
   * one batched `lookupFilenamesByFolder` call against the file index, and the
   * looked-up string id is also injected into the entry's `content` so the
   * connector and git see a consistent value.
   *
   * Throws if any entry's id cannot be resolved.
   */
  private async parseAndResolveUpdatePhaseOps(
    repoId: string,
    tablePath: string,
    phaseDir: string,
    phase: 'edit' | 'backfill',
    files: { name: string; content: string }[],
    idField: IdPath,
  ): Promise<UpdatePhaseOperation[]> {
    type Pending = {
      filename: string;
      relPath: string;
      content: ParsedContent;
      changedFields: Record<string, unknown>;
      remoteId: string | null;
    };

    const pending: Pending[] = [];
    for (const file of files) {
      const relPath = `${tablePath}/${file.name}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.content);
      } catch {
        WSLogger.warn({
          source: 'PublishFromGitService.parseAndResolveUpdatePhaseOps',
          message: `Failed to parse ${phaseDir}/${file.name}`,
        });
        continue;
      }
      const envelope = parsed as PhaseFileEnvelope;
      const remoteId = readRecordIdAsString(envelope.content as Record<string, unknown>, idField);
      pending.push({
        filename: file.name,
        relPath,
        content: envelope.content,
        changedFields: envelope.changedFields,
        remoteId,
      });
    }

    const needsLookup = pending.filter((p) => p.remoteId === null);
    if (needsLookup.length > 0) {
      const filenameMap = await this.scratchGitService.lookupFilenamesByFolder(
        repoId,
        tablePath,
        needsLookup.map((p) => p.filename),
      );
      for (const p of needsLookup) {
        const looked = filenameMap.get(p.filename);
        if (!looked) {
          throw new Error(`Could not resolve remote ID for entry: ${p.relPath}`);
        }
        p.remoteId = looked;
        // id was absent from content — inject the looked-up string id so the
        // connector and git both see a consistent value. When content already
        // had an id we leave it untouched so its native type (e.g. numeric
        // Postgres id) is preserved in git.
        const cloned = cloneDeep(p.content) as Record<string, unknown>;
        writeRecordId(cloned, idField, looked);
        p.content = cloned as ParsedContent;
      }
    }

    return pending.map((p) => ({
      phase,
      relPath: p.relPath,
      content: p.content,
      changedFields: p.changedFields,
      remoteId: p.remoteId as string,
    }));
  }

  // ---------------------------------------------------------------------------
  // Edit / backfill dispatch
  // ---------------------------------------------------------------------------

  private async dispatchUpdateBatch(
    phase: 'edit' | 'backfill',
    entries: UpdatePhaseOperation[],
    connector: Connector<string, JsonSafeObject>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    repoId: string,
    hasLaterPhase: Set<string>,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId;
    const rawRecordContents = entries.map((e) => e.content);
    const resolvedRecordContents = await this.refResolverService.resolveBatchPseudoRefs(
      workbookId,
      rawRecordContents,
      (asset) => connector.resolveAssetReference(asset),
    );

    const recordContents: ParsedContent[] = [];
    const changedFieldsArray: Record<string, unknown>[] = [];
    const entriesWithOps: { entry: UpdatePhaseOperation; resolvedContent: ParsedContent }[] = [];

    for (let opIndex = 0; opIndex < entries.length; opIndex++) {
      const entry = entries[opIndex];
      const resolvedContent = resolvedRecordContents[opIndex] as ParsedContent;

      if (Object.keys(entry.changedFields).length === 0) continue;

      const resolvedChangedFields = pickByShape(resolvedContent as Record<string, unknown>, entry.changedFields);

      recordContents.push(resolvedContent);
      changedFieldsArray.push(resolvedChangedFields);
      entriesWithOps.push({ entry, resolvedContent });
    }

    if (recordContents.length === 0) return;

    await connector.updateRecords(tableSpec, recordContents, changedFieldsArray);

    const committedEntries = await this.refreshUpdatedEntries(
      connector,
      tableSpec,
      idField,
      entriesWithOps,
      workbookId,
      phase,
    );

    const refUpdates = committedEntries.map(({ entry, content }) => ({
      path: entry.relPath,
      content,
    }));
    await this.fileReferenceService.updateRefsForFiles(workbookId, 'main', refUpdates);

    const gitFiles = refUpdates.map((u) => ({
      path: u.path,
      content: formatJsonWithPrettier(u.content as Record<string, unknown>),
    }));
    await this.scratchGitService.commitFilesToBranch(
      repoId,
      'main',
      gitFiles,
      `Publish V2 ${phase} batch (${entries.length})`,
    );

    // Sync to dirty for files that have no later phase.
    // Backfill is always the terminal phase for a record (nothing follows it), so always sync it
    // regardless of hasLaterPhase (which contains backfill paths themselves and would skip them).
    const finalItems = committedEntries
      .filter(({ entry }) => phase === 'backfill' || !hasLaterPhase.has(entry.relPath))
      .map(({ entry, content }) => ({
        path: entry.relPath,
        content: formatJsonWithPrettier(content as Record<string, unknown>),
      }));
    if (finalItems.length > 0) {
      await this.scratchGitService.commitFilesToBranch(repoId, 'dirty', finalItems, `Sync dirty after ${phase}`);
    }
  }

  /**
   * After an edit/backfill batch is sent to the connector, re-pull the rows by id
   * so git is committed with the source of truth (not just our local resolved
   * content). This matters because the connector may set fields the client did
   * not — server-side timestamps, computed columns, formula results, normalized
   * field values, etc. — and we want those reflected in the next pull and in any
   * `fileReference` updates that depend on the committed shape.
   *
   * Returns one `{ entry, content }` pair per input entry, in the same order.
   * For each entry, `content` is the freshly-pulled row when available; otherwise
   * we fall back to the local `resolvedContent` so the publish can still commit
   * something coherent. The whole pull failing or individual rows missing both
   * log a warning but never throw — refresh is best-effort.
   */
  private async refreshUpdatedEntries(
    connector: Connector<string, JsonSafeObject>,
    tableSpec: BaseJsonTableSpec,
    idField: IdPath,
    entriesWithOps: { entry: UpdatePhaseOperation; resolvedContent: ParsedContent }[],
    workbookId: string,
    phase: 'edit' | 'backfill',
  ): Promise<Array<{ entry: UpdatePhaseOperation; content: ParsedContent }>> {
    const fallback = entriesWithOps.map(({ entry, resolvedContent }) => ({
      entry,
      content: resolvedContent,
    }));
    const ids = entriesWithOps.map(({ entry }) => entry.remoteId);

    if (ids.length === 0) {
      return fallback;
    }

    const refreshedById = new Map<string, ParsedContent>();

    try {
      await connector.pullRecordFilesByIds(tableSpec, [...new Set(ids)], ({ files }) => {
        for (const file of files) {
          const remoteId = readRecordIdAsString(file as Record<string, unknown>, idField);
          if (remoteId !== null) {
            refreshedById.set(remoteId, file as ParsedContent);
          }
        }
        return Promise.resolve();
      });
    } catch (error) {
      WSLogger.warn({
        source: 'PublishFromGitService.refreshUpdatedEntries',
        message: `Failed to refresh updated rows after ${phase}; falling back to resolved content`,
        workbookId,
        error,
      });
      return fallback;
    }

    const missingIds: string[] = [];
    const refreshedEntries = entriesWithOps.map(({ entry, resolvedContent }) => {
      const refreshed = refreshedById.get(entry.remoteId);
      if (!refreshed) {
        missingIds.push(entry.remoteId);
        return { entry, content: resolvedContent };
      }

      return { entry, content: refreshed };
    });

    if (missingIds.length > 0) {
      WSLogger.warn({
        source: 'PublishFromGitService.refreshUpdatedEntries',
        message: `Refresh after ${phase} missed ${missingIds.length} updated row(s); keeping local resolved content`,
        workbookId,
        data: { missingIds },
      });
    }

    return refreshedEntries;
  }

  // ---------------------------------------------------------------------------
  // Create dispatch
  // ---------------------------------------------------------------------------

  private async dispatchCreateBatch(
    entries: CreatePhaseOperation[],
    connector: Connector<string, JsonSafeObject>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    repoId: string,
    hasLaterPhase: Set<string>,
  ): Promise<void> {
    const idField = tableSpec.idColumnRemoteId;

    const rawOps = entries.map((e) => {
      const entryContent = cloneDeep(e.content as Record<string, unknown>);
      if (isScratchPendingPublishId(readRecordId(entryContent, idField))) {
        clearRecordId(entryContent, idField);
      }
      return entryContent as ParsedContent;
    });

    const resolvedOps = await this.refResolverService.resolveBatchPseudoRefs(workbookId, rawOps, (asset) =>
      connector.resolveAssetReference(asset),
    );

    const operations: ParsedContent[] = [];
    const entriesWithOps: { entry: CreatePhaseOperation; resolvedOp: ParsedContent }[] = [];

    for (let opIndex = 0; opIndex < entries.length; opIndex++) {
      const entry = entries[opIndex];
      const resolvedOp = resolvedOps[opIndex] as ParsedContent;
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

      const realId = readRecordIdAsString(returned, idField);
      if (realId !== null) {
        const { folderPath, filename } = parsePath(entry.relPath);
        fileIndexUpdates.push({ workbookId, folderPath, filename, recordId: realId });
      }

      refUpdates.push({ path: entry.relPath, content: returned });
      gitFiles.push({ path: entry.relPath, content: formatJsonWithPrettier(returned) });
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
        content: formatJsonWithPrettier(
          (returnedRecords[i] ?? entriesWithOps[i].resolvedOp) as Record<string, unknown>,
        ),
      }));
    if (finalItems.length > 0) {
      await this.scratchGitService.commitFilesToBranch(repoId, 'dirty', finalItems, `Sync dirty after create`);
    }
  }

  // ---------------------------------------------------------------------------
  // Delete dispatch
  // ---------------------------------------------------------------------------

  private async dispatchDeleteBatch(
    entries: DeletePhaseOperation[],
    connector: Connector<string, JsonSafeObject>,
    tableSpec: BaseJsonTableSpec,
    workbookId: string,
    repoId: string,
  ): Promise<void> {
    if (entries.length === 0) return;

    const idField = tableSpec.idColumnRemoteId;
    const filters = entries.map((e) => recordWithId(idField, e.remoteId) as ConnectorFile);

    await connector.deleteRecords(tableSpec, filters);

    const filesToDelete = entries.map((e) => e.relPath);

    await this.db.client.fileReference.deleteMany({
      where: { workbookId, sourceFilePath: { in: filesToDelete } },
    });

    const fileIndexDeletes = entries.map((e) => {
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
    entries: RenamePhaseOperation[],
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

/**
 * Normalize a folder path for membership lookup in the read-only set.
 * DataFolder.path is stored with a leading slash (e.g. "/Articles"); the plan
 * file's tablePath uses the same shape but the dirty branch can yield variants
 * without the leading slash. Strip both leading and trailing slashes so both
 * sources hash to the same key.
 */
function normalizeReadOnlyPath(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
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
      assertUnreachable(phase);
  }
}
