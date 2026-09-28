import { type DataFolderOptions, PublishPlanStatus, type WorkbookId } from '@spinner/shared-types';
import isEqual from 'lodash/isEqual';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import {
  planCreateOperationsForRecord,
  planEditOperationsForRecord,
  type PlanOperation,
} from 'src/publish-plan/plan-operations-for-record';
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import type { PublishPlanPhase } from 'src/publish-plan/types';
import { parsePath } from 'src/publish-plan/utils';
import { safeJsonParse } from 'src/utils/helpers';
import type { ParsedContent, Schema } from 'src/utils/objects';
import {
  readAllRunStoreEntries,
  RUN_STORE_BULK_PAGE_SIZE,
  type RunStoreClient,
  type RunStoreEntry,
  type RunStoreEntryToPut,
  type RunStoreKey,
} from './run-store-client';
import {
  folderPathWithoutLeadingSlash,
  RUN_STORE_PLAN_STATE_COLLECTION,
  runStorePlanCollection,
  runStorePlanOperationKey,
  runStorePlanStateKey,
  runStoreRecordsCollection,
  runStoreSyncOutputCollection,
} from './run-store-collections';
import { RunStoreTableSpecStore } from './run-store-table-spec-store';

/** Planned-operation counts, in the shape the publish job reports while planning. */
export interface RunStorePlanCounts {
  assetUploadsPlanned: number;
  editsPlanned: number;
  createsPlanned: number;
  deletesPlanned: number;
  backfillsPlanned: number;
  renameFilesPlanned: number;
}

/** The meta each plan entry carries (bodies hold `{ content, changedFields }`). */
export interface RunStorePlanOperationMeta {
  phase: PublishPlanPhase;
  dataFolderId: string | null;
  filePath: string;
  status: string;
  error: string | null;
  errorCode: string | null;
  remoteRecordId: string | null;
  isRecreate: boolean;
}

interface DestinationFolderForPlanning {
  id: string;
  folderPath: string;
  remoteTableId: string | undefined;
  schema: Schema;
}

/**
 * Builds a Live Export run's publish plan for one destination connection from the run store — the
 * run-store counterpart of `PublishPlanBuildService.buildPipeline`, which diffs git `main..dirty`.
 * Here "main" is the destination as this run pulled it (`records:<folderId>`) and "dirty" is main plus
 * the sync's output (`sync-output:<folderId>`). Each changed record is planned by the same
 * `planEditOperationsForRecord` / `planCreateOperationsForRecord` the classic build uses, so both
 * engines produce the same operations for the same change. Differences, all because a run store has
 * no filenames, assets or revert patches: no `rename-files` or `asset-upload` operations, no
 * recreate paths, and edits carry their `remoteRecordId` so dispatch needs no id lookup.
 *
 * Idempotent: a plan that finished building is reused (a resumed publish job continues it); a build
 * that crashed half-way is discarded and redone.
 */
export class RunStorePublishPlanBuilder {
  constructor(
    private readonly dependencies: {
      runStoreClient: RunStoreClient;
      runStoreKey: RunStoreKey;
      db: DbService;
      refCleanerService: RefCleanerService;
      fileReferenceService: FileReferenceService;
    },
  ) {}

  async buildPlanUnlessAlreadyBuilt(args: {
    workbookId: WorkbookId;
    connectorAccountId: string;
    /** Narrows the plan like the classic build's `folderPath` / `filePath` arguments. */
    scope?: { folderPath?: string; filePath?: string };
    onProgress?: (counts: RunStorePlanCounts & { step?: string }) => Promise<void>;
  }): Promise<RunStorePlanCounts> {
    const { runStoreClient, runStoreKey } = this.dependencies;
    const { workbookId, connectorAccountId, onProgress } = args;
    const isInPublishScope = publishScopePredicate(args.scope);
    const planCollection = runStorePlanCollection(connectorAccountId);
    const planStateKey = runStorePlanStateKey(connectorAccountId);

    const existingPlanState = (
      await runStoreClient.readEntriesByKeys(runStoreKey, RUN_STORE_PLAN_STATE_COLLECTION, [planStateKey], {
        includeBodies: false,
      })
    ).entries[0];
    if (existingPlanState && existingPlanState.meta.status !== PublishPlanStatus.Planning) {
      return (existingPlanState.meta.plannedCounts as RunStorePlanCounts | undefined) ?? emptyPlanCounts();
    }
    // Fresh build, or one that crashed half-way: start from an empty plan.
    await runStoreClient.deleteCollection(runStoreKey, planCollection);
    await runStoreClient.putEntries(runStoreKey, RUN_STORE_PLAN_STATE_COLLECTION, [
      { key: planStateKey, meta: { status: PublishPlanStatus.Planning, createdAt: new Date().toISOString() } },
    ]);

    const counts = emptyPlanCounts();
    const destinationFolders = await this.loadWritableDestinationFolders(workbookId, connectorAccountId);
    const planWriter = new PlanOperationWriter(runStoreClient, runStoreKey, planCollection, counts);

    // 1. Deletes first: their remote ids feed the reference stripping of every other record (pass 1).
    await onProgress?.({ ...counts, step: 'Resolving deleted records' });
    const deletedRecordIds = new Set<string>();
    const deletedRecordTargets: Array<{ remoteTableId: string; recordId: string }> = [];
    for (const folder of destinationFolders) {
      for await (const outputEntries of readAllRunStoreEntries(
        runStoreClient,
        runStoreKey,
        runStoreSyncOutputCollection(folder.id),
        { includeBodies: false },
      )) {
        const deletedPaths = outputEntries
          .filter((entry) => entry.meta.deleted === true && isInPublishScope(entry.key))
          .map((entry) => entry.key);
        if (deletedPaths.length === 0) continue;
        const pulledEntryByPath = await this.readPulledRecords(folder.id, deletedPaths, false);
        for (const filePath of deletedPaths) {
          const pulled = pulledEntryByPath.get(filePath);
          // Created and deleted in the same run → never existed remotely → nothing to publish.
          if (!pulled) continue;
          const recordId = typeof pulled.meta.recordId === 'string' ? pulled.meta.recordId : null;
          if (recordId) {
            deletedRecordIds.add(recordId);
            if (folder.remoteTableId) deletedRecordTargets.push({ remoteTableId: folder.remoteTableId, recordId });
          }
          await planWriter.add({
            filePath,
            phase: 'delete',
            content: {},
            remoteRecordId: recordId,
            dataFolderId: folder.id,
            status: 'pending',
          });
        }
      }
    }

    // 2. Edits and creates: every record the sync wrote.
    for (const folder of destinationFolders) {
      for await (const outputEntries of readAllRunStoreEntries(
        runStoreClient,
        runStoreKey,
        runStoreSyncOutputCollection(folder.id),
        { includeBodies: true },
      )) {
        const writtenEntries = outputEntries.filter(
          (entry) => entry.meta.deleted !== true && isInPublishScope(entry.key),
        );
        if (writtenEntries.length === 0) continue;
        const pulledEntryByPath = await this.readPulledRecords(
          folder.id,
          writtenEntries.map((entry) => entry.key),
          true,
        );
        for (const outputEntry of writtenEntries) {
          const filePath = outputEntry.key;
          const contentObj = parseRecordOrWarn(outputEntry.body, filePath, workbookId, 'sync output');
          if (!contentObj) continue;
          const pulled = pulledEntryByPath.get(filePath);
          if (pulled) {
            const pulledObj = parseRecordOrWarn(pulled.body, filePath, workbookId, 'pulled record');
            // Written but identical to what's published (e.g. the FK phase rewrote a DATA-phase no-op) is
            // treated like an untouched record: planned only if it references a record deleted this run.
            const isUserModified = !(pulledObj && isEqual(pulledObj, contentObj));
            for (const operation of planEditOperationsForRecord({
              refCleanerService: this.dependencies.refCleanerService,
              filePath,
              contentObj,
              readPublishedContentForDiff: () => pulledObj as Record<string, unknown> | null,
              schema: folder.schema,
              dataFolderId: folder.id,
              deletedRecordIds,
              isRecreatePath: false,
              isUserModified,
              remoteRecordId: typeof pulled.meta.recordId === 'string' ? pulled.meta.recordId : null,
            })) {
              await planWriter.add(operation);
            }
          } else {
            for (const operation of planCreateOperationsForRecord({
              refCleanerService: this.dependencies.refCleanerService,
              filePath,
              filename: parsePath(filePath).filename,
              contentObj,
              schema: folder.schema,
              dataFolderId: folder.id,
              deletedRecordIds,
              isRecreatePath: false,
              includeRenameFilesOperation: false,
            })) {
              await planWriter.add(operation);
            }
          }
        }
        await onProgress?.({ ...counts, step: `Planning ${folder.folderPath}` });
      }
    }

    // 3. Records the sync didn't touch that reference a deleted record: clear the dangling reference
    //    (the classic build finds these through the FileReference index).
    if (deletedRecordTargets.length > 0) {
      await onProgress?.({ ...counts, step: 'Clearing references to deleted records' });
      await this.planReferenceClearingEdits(
        destinationFolders,
        deletedRecordIds,
        deletedRecordTargets,
        planWriter,
        isInPublishScope,
      );
    }

    await planWriter.flush();
    await runStoreClient.putEntries(runStoreKey, RUN_STORE_PLAN_STATE_COLLECTION, [
      {
        key: planStateKey,
        meta: { status: PublishPlanStatus.Planned, plannedCounts: counts, createdAt: new Date().toISOString() },
      },
    ]);
    WSLogger.info({
      source: 'RunStorePublishPlanBuilder',
      message: 'Built Live Export run-store publish plan',
      workbookId,
      runStoreKey,
      connectorAccountId,
      counts,
    });
    await onProgress?.({ ...counts, step: 'Plan ready' });
    return counts;
  }

  private async planReferenceClearingEdits(
    destinationFolders: DestinationFolderForPlanning[],
    deletedRecordIds: Set<string>,
    deletedRecordTargets: Array<{ remoteTableId: string; recordId: string }>,
    planWriter: PlanOperationWriter,
    isInPublishScope: (filePath: string) => boolean,
  ): Promise<void> {
    const { runStoreClient, runStoreKey, fileReferenceService, refCleanerService } = this.dependencies;
    const deletedTargetKeys = new Set(
      deletedRecordTargets.map((target) => `${target.remoteTableId}|${target.recordId}`),
    );
    for (const folder of destinationFolders) {
      const pathsInSyncOutput = new Set<string>();
      for await (const outputEntries of readAllRunStoreEntries(
        runStoreClient,
        runStoreKey,
        runStoreSyncOutputCollection(folder.id),
        { includeBodies: false },
      )) {
        for (const entry of outputEntries) pathsInSyncOutput.add(entry.key);
      }
      for await (const pulledEntries of readAllRunStoreEntries(
        runStoreClient,
        runStoreKey,
        runStoreRecordsCollection(folder.id),
        { includeBodies: true },
      )) {
        for (const pulled of pulledEntries) {
          if (pathsInSyncOutput.has(pulled.key) || !isInPublishScope(pulled.key)) continue; // planned above
          const pulledObj = safeJsonParse<ParsedContent>(pulled.body ?? '');
          if (!pulledObj.ok) continue;
          const referencesDeletedRecord = fileReferenceService
            .extractReferences(pulled.key, pulledObj.value, folder.schema)
            .some((ref) => deletedTargetKeys.has(`${ref.targetRemoteTableId ?? ''}|${ref.targetRemoteId ?? ''}`));
          if (!referencesDeletedRecord) continue;
          for (const operation of planEditOperationsForRecord({
            refCleanerService,
            filePath: pulled.key,
            contentObj: pulledObj.value,
            readPublishedContentForDiff: () => pulledObj.value as Record<string, unknown>,
            schema: folder.schema,
            dataFolderId: folder.id,
            deletedRecordIds,
            isRecreatePath: false,
            isUserModified: false,
            remoteRecordId: typeof pulled.meta.recordId === 'string' ? pulled.meta.recordId : null,
          })) {
            await planWriter.add(operation);
          }
        }
      }
    }
  }

  /** The connection's folders a publish may write to (read-only folders are never published, DEV-9928). */
  private async loadWritableDestinationFolders(
    workbookId: WorkbookId,
    connectorAccountId: string,
  ): Promise<DestinationFolderForPlanning[]> {
    const dataFolders = await this.dependencies.db.client.dataFolder.findMany({
      where: { workbookId, connectorAccountId },
      select: { id: true, path: true, tableId: true, options: true },
    });
    const tableSpecStore = new RunStoreTableSpecStore(this.dependencies.runStoreClient, this.dependencies.runStoreKey);
    const folders: DestinationFolderForPlanning[] = [];
    for (const dataFolder of dataFolders) {
      if ((dataFolder.options as DataFolderOptions | null)?.readOnly || !dataFolder.path) continue;
      const tableSpec = await tableSpecStore.readTableSpec({ connectorAccountId, folderPath: dataFolder.path });
      folders.push({
        id: dataFolder.id,
        folderPath: folderPathWithoutLeadingSlash(dataFolder.path),
        remoteTableId: dataFolder.tableId.length > 0 ? dataFolder.tableId[dataFolder.tableId.length - 1] : undefined,
        schema: tableSpec?.schema as Schema,
      });
    }
    return folders;
  }

  private async readPulledRecords(
    dataFolderId: string,
    paths: string[],
    includeBodies: boolean,
  ): Promise<Map<string, RunStoreEntry>> {
    const entryByPath = new Map<string, RunStoreEntry>();
    for (let index = 0; index < paths.length; index += RUN_STORE_BULK_PAGE_SIZE) {
      const { entries } = await this.dependencies.runStoreClient.readEntriesByKeys(
        this.dependencies.runStoreKey,
        runStoreRecordsCollection(dataFolderId),
        paths.slice(index, index + RUN_STORE_BULK_PAGE_SIZE),
        { includeBodies },
      );
      for (const entry of entries) entryByPath.set(entry.key, entry);
    }
    return entryByPath;
  }
}

/** Appends plan operations to the run store in bulk batches, numbering them in insertion order. */
class PlanOperationWriter {
  private nextSequenceNumber = 1;
  private bufferedEntries: RunStoreEntryToPut[] = [];

  constructor(
    private readonly runStoreClient: RunStoreClient,
    private readonly runStoreKey: RunStoreKey,
    private readonly planCollection: string,
    private readonly counts: RunStorePlanCounts,
  ) {}

  async add(operation: PlanOperation): Promise<void> {
    const meta: RunStorePlanOperationMeta = {
      phase: operation.phase,
      dataFolderId: operation.dataFolderId ?? null,
      filePath: operation.filePath,
      status: operation.status,
      error: null,
      errorCode: null,
      remoteRecordId: operation.remoteRecordId ?? null,
      isRecreate: operation.isRecreate ?? false,
    };
    this.bufferedEntries.push({
      key: runStorePlanOperationKey(this.nextSequenceNumber++),
      meta: { ...meta },
      body: JSON.stringify({
        content: operation.content,
        changedFields: 'changedFields' in operation ? operation.changedFields : null,
      }),
    });
    countPlannedOperation(this.counts, operation.phase);
    if (this.bufferedEntries.length >= RUN_STORE_BULK_PAGE_SIZE) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.bufferedEntries.length === 0) return;
    const entries = this.bufferedEntries;
    this.bufferedEntries = [];
    await this.runStoreClient.putEntries(this.runStoreKey, this.planCollection, entries);
  }
}

/** The classic build's `folderPath` / `filePath` filter (`PublishPlanBuildService.buildPipeline`). */
function publishScopePredicate(scope: { folderPath?: string; filePath?: string } | undefined) {
  if (scope?.filePath) {
    const filePath = scope.filePath;
    return (path: string) => path === filePath;
  }
  if (scope?.folderPath) {
    const normalizedFolder = folderPathWithoutLeadingSlash(scope.folderPath);
    const prefix = normalizedFolder.endsWith('/') ? normalizedFolder : normalizedFolder + '/';
    return (path: string) => path.startsWith(prefix);
  }
  return () => true;
}

function emptyPlanCounts(): RunStorePlanCounts {
  return {
    assetUploadsPlanned: 0,
    editsPlanned: 0,
    createsPlanned: 0,
    deletesPlanned: 0,
    backfillsPlanned: 0,
    renameFilesPlanned: 0,
  };
}

function countPlannedOperation(counts: RunStorePlanCounts, phase: PublishPlanPhase): void {
  switch (phase) {
    case 'asset-upload':
      counts.assetUploadsPlanned++;
      break;
    case 'edit':
      counts.editsPlanned++;
      break;
    case 'create':
      counts.createsPlanned++;
      break;
    case 'delete':
      counts.deletesPlanned++;
      break;
    case 'backfill':
      counts.backfillsPlanned++;
      break;
    case 'rename-files':
      counts.renameFilesPlanned++;
      break;
  }
}

/**
 * A record body that isn't valid JSON is corrupt; like the classic build (DEV-9981) the record is
 * skipped with a warning rather than failing the whole plan.
 */
function parseRecordOrWarn(
  body: string | null | undefined,
  filePath: string,
  workbookId: string,
  label: string,
): ParsedContent | null {
  const parsed = safeJsonParse<ParsedContent>(body ?? '');
  if (parsed.ok && parsed.value && typeof parsed.value === 'object') return parsed.value;
  WSLogger.warn({
    source: 'RunStorePublishPlanBuilder',
    message: `Skipping record with invalid JSON (${label}): ${filePath}`,
    workbookId,
  });
  return null;
}
