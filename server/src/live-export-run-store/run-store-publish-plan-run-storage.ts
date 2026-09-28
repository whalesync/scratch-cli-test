import type { PublishOrigin } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import {
  type ConnectionFolderIndex,
  RefResolverService,
  type TranslatedPseudoRef,
} from 'src/publish-plan/ref-resolver.service';
import type {
  CreatedRecordToWriteBack,
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
} from 'src/publish-plan/run-storage/publish-plan-run-storage-ports';
import type { PublishPlanPhase, PublishPlanStatus } from 'src/publish-plan/types';
import type { ParsedContent } from 'src/utils/objects';
import type { TableSpecStore } from 'src/workbook/table-spec-store/table-spec-store';
import {
  readAllRunStoreEntries,
  RUN_STORE_BULK_PAGE_SIZE,
  type RunStoreClient,
  type RunStoreKey,
} from './run-store-client';
import {
  folderPathWithoutLeadingSlash,
  RUN_STORE_CREATED_RECORDS_COLLECTION,
  RUN_STORE_PLAN_STATE_COLLECTION,
  runStorePlanCollection,
  runStorePlanStateKey,
  runStoreRecordsCollection,
} from './run-store-collections';
import type { RunStorePlanOperationMeta } from './run-store-publish-plan-builder';
import { RunStoreTableSpecStore } from './run-store-table-spec-store';

/**
 * The Live Export run-store implementation of the publish-run ports (see
 * `src/publish-plan/run-storage/publish-plan-run-storage-ports.ts`): the plan built by
 * `RunStorePublishPlanBuilder` is read and its statuses are persisted in the run store (so a resumed
 * publish job continues where it stopped), created records' ids are recorded there for `@/…`
 * resolution, and nothing is written back to git or the Postgres file indexes.
 */
export class RunStorePublishPlanRunStorage implements PublishPlanRunStorage {
  readonly tableSpecStore: TableSpecStore;
  readonly pseudoRefResolver: PublishPseudoRefResolver;
  private readonly createdRecords: RunStoreCreatedRecords;
  private readonly pulledRecordIds: RunStorePulledRecordIds;

  constructor(
    private readonly dependencies: {
      runStoreClient: RunStoreClient;
      runStoreKey: RunStoreKey;
      db: DbService;
      fileIndexService: FileIndexService;
      workbookId: string;
      userId: string;
      connectorAccountId: string;
    },
  ) {
    const { runStoreClient, runStoreKey, db, fileIndexService, workbookId, connectorAccountId } = dependencies;
    this.tableSpecStore = new RunStoreTableSpecStore(runStoreClient, runStoreKey);
    this.createdRecords = new RunStoreCreatedRecords(runStoreClient, runStoreKey);
    this.pulledRecordIds = new RunStorePulledRecordIds(runStoreClient, runStoreKey, db, workbookId, connectorAccountId);
    this.pseudoRefResolver = new RunStorePseudoRefResolver(
      fileIndexService,
      db,
      connectorAccountId,
      this.createdRecords,
      this.pulledRecordIds,
    );
  }

  openPlanStore(planId: string): RunStorePlanStore {
    return new RunStorePlanStore(this.dependencies, planId);
  }

  openRecordWriteback(plan: PublishPlanRunPlan, planStore: PlanStore): Promise<RecordWriteback> {
    void plan;
    void planStore;
    return Promise.resolve(new RunStoreRecordWriteback(this.createdRecords, this.pulledRecordIds));
  }
}

// =====================================================================================================
// Plan store
// =====================================================================================================

interface PlanOperationIndexEntry extends RunStorePlanOperationMeta {
  id: string;
}

/**
 * The run's plan for one connection. Operation metadata (a few hundred bytes each) is loaded into
 * memory once and the queries run over it; bodies are fetched by id when a batch is dispatched.
 * Every status change is written through to the run store before the call returns.
 */
export class RunStorePlanStore implements PlanStore {
  private operationIndexPromise: Promise<PlanOperationIndexEntry[]> | null = null;
  private readonly planCollection: string;
  private readonly planStateKey: string;

  constructor(
    private readonly dependencies: {
      runStoreClient: RunStoreClient;
      runStoreKey: RunStoreKey;
      workbookId: string;
      userId: string;
      connectorAccountId: string;
    },
    private readonly planId: string,
  ) {
    this.planCollection = runStorePlanCollection(dependencies.connectorAccountId);
    this.planStateKey = runStorePlanStateKey(dependencies.connectorAccountId);
  }

  async readPlan(): Promise<PublishPlanRunPlan | null> {
    const { runStoreClient, runStoreKey, workbookId, userId, connectorAccountId } = this.dependencies;
    const planState = (
      await runStoreClient.readEntriesByKeys(runStoreKey, RUN_STORE_PLAN_STATE_COLLECTION, [this.planStateKey], {
        includeBodies: false,
      })
    ).entries[0];
    if (!planState) return null;
    const createdAt = typeof planState.meta.createdAt === 'string' ? new Date(planState.meta.createdAt) : new Date();
    return {
      id: this.planId,
      workbookId,
      userId,
      connectorAccountId,
      status: String(planState.meta.status),
      branchName: '',
      createdAt,
    };
  }

  readPlanConnectorAccountId(): Promise<string | null> {
    return Promise.resolve(this.dependencies.connectorAccountId);
  }

  async updatePlanStatus(status: string): Promise<void> {
    await this.patchPlanState({ status });
  }

  async recordPlanFinalStatusAndResult(
    status: PublishPlanStatus,
    result: { successCount: number; failedCount: number },
  ): Promise<void> {
    await this.patchPlanState({
      status,
      successCount: result.successCount,
      failedCount: result.failedCount,
      finishedAt: new Date().toISOString(),
    });
  }

  async countOperationsInPhase(phase: PublishPlanPhase): Promise<number> {
    return (await this.operations()).filter((operation) => operation.phase === phase).length;
  }

  async countOperationsInPhaseWithStatus(phase: PublishPlanPhase, status: PublishPlanOperationStatus): Promise<number> {
    return (await this.operations()).filter((operation) => operation.phase === phase && operation.status === status)
      .length;
  }

  async countFailedOperationsInPhaseWithError(phase: PublishPlanPhase, error: string): Promise<number> {
    return (await this.operations()).filter(
      (operation) => operation.phase === phase && operation.status === 'failed-batch' && operation.error === error,
    ).length;
  }

  async countOperationsGroupedByPhaseAndStatus(): Promise<{ phase: string; status: string; count: number }[]> {
    const countByPhaseAndStatus = new Map<string, { phase: string; status: string; count: number }>();
    for (const operation of await this.operations()) {
      const groupKey = `${operation.phase}\0${operation.status}`;
      const group = countByPhaseAndStatus.get(groupKey) ?? {
        phase: operation.phase,
        status: operation.status,
        count: 0,
      };
      group.count++;
      countByPhaseAndStatus.set(groupKey, group);
    }
    return [...countByPhaseAndStatus.values()];
  }

  async listPendingOperationsInPhase(phase: PublishPlanPhase): Promise<PublishPlanRunOperation[]> {
    const ids = (await this.operations())
      .filter((operation) => operation.phase === phase && operation.status === 'pending')
      .map((operation) => operation.id);
    return this.readOperationsByIdsOrderedById(ids);
  }

  async listDataFolderIdsWithPendingOperationsInPhase(phase: PublishPlanPhase): Promise<(string | null)[]> {
    const dataFolderIds = new Set<string | null>();
    for (const operation of await this.operations()) {
      if (operation.phase === phase && operation.status === 'pending') dataFolderIds.add(operation.dataFolderId);
    }
    return [...dataFolderIds];
  }

  async listPendingOperationIdsInPhaseForDataFolder(phase: PublishPlanPhase, dataFolderId: string): Promise<string[]> {
    return (await this.operations())
      .filter(
        (operation) =>
          operation.phase === phase && operation.status === 'pending' && operation.dataFolderId === dataFolderId,
      )
      .map((operation) => operation.id);
  }

  async listFailedOperationIdsInPhase(phase: PublishPlanPhase): Promise<string[]> {
    return (await this.operations())
      .filter((operation) => operation.phase === phase && operation.status === 'failed-batch')
      .map((operation) => operation.id);
  }

  async readOperationsByIdsOrderedById(operationIds: string[]): Promise<PublishPlanRunOperation[]> {
    const { runStoreClient, runStoreKey } = this.dependencies;
    const operationById = new Map((await this.operations()).map((operation) => [operation.id, operation]));
    const fullOperations: PublishPlanRunOperation[] = [];
    const sortedIds = [...operationIds].sort();
    for (let index = 0; index < sortedIds.length; index += RUN_STORE_BULK_PAGE_SIZE) {
      const { entries } = await runStoreClient.readEntriesByKeys(
        runStoreKey,
        this.planCollection,
        sortedIds.slice(index, index + RUN_STORE_BULK_PAGE_SIZE),
        { includeBodies: true },
      );
      for (const entry of entries) {
        const indexed = operationById.get(entry.key);
        if (!indexed) continue;
        const body = JSON.parse(entry.body ?? '{}') as {
          content?: ParsedContent;
          changedFields?: Record<string, unknown> | null;
        };
        fullOperations.push({
          id: indexed.id,
          filePath: indexed.filePath,
          content: body.content ?? {},
          remoteRecordId: indexed.remoteRecordId,
          dataFolderId: indexed.dataFolderId,
          isRecreate: indexed.isRecreate,
          changedFields: body.changedFields ?? null,
        });
      }
    }
    return fullOperations;
  }

  async readOperationById(operationId: string): Promise<PublishPlanRunOperation | null> {
    return (await this.readOperationsByIdsOrderedById([operationId]))[0] ?? null;
  }

  async listDistinctFilePathsWithFailedOperations(): Promise<string[]> {
    return [
      ...new Set(
        (await this.operations())
          .filter((operation) => operation.status === 'failed-batch')
          .map((operation) => operation.filePath),
      ),
    ];
  }

  async listFailedOperationsOrderedByFilePath(): Promise<PublishPlanRunFailedOperation[]> {
    return (await this.operations())
      .filter((operation) => operation.status === 'failed-batch')
      .map((operation) => ({
        filePath: operation.filePath,
        phase: operation.phase,
        error: operation.error,
        errorCode: operation.errorCode,
      }))
      .sort((left, right) => (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0));
  }

  async findFilePathsWithPendingOperationsInPhases(
    filePaths: string[],
    phases: PublishPlanPhase[],
  ): Promise<Set<string>> {
    const wantedPaths = new Set(filePaths);
    const found = new Set<string>();
    for (const operation of await this.operations()) {
      if (operation.status === 'pending' && phases.includes(operation.phase) && wantedPaths.has(operation.filePath)) {
        found.add(operation.filePath);
      }
    }
    return found;
  }

  /** Successful creates and deletes per destination folder — what moves the folder's record count. */
  async countSuccessfulCreatesAndDeletesByDataFolder(): Promise<Map<string, { creates: number; deletes: number }>> {
    const countsByDataFolderId = new Map<string, { creates: number; deletes: number }>();
    for (const operation of await this.operations()) {
      if (operation.status !== 'success' || !operation.dataFolderId) continue;
      if (operation.phase !== 'create' && operation.phase !== 'delete') continue;
      const counts = countsByDataFolderId.get(operation.dataFolderId) ?? { creates: 0, deletes: 0 };
      if (operation.phase === 'create') counts.creates++;
      else counts.deletes++;
      countsByDataFolderId.set(operation.dataFolderId, counts);
    }
    return countsByDataFolderId;
  }

  async listOperationFilePathsAndStatuses(): Promise<{ filePath: string; status: string }[]> {
    return (await this.operations()).map((operation) => ({ filePath: operation.filePath, status: operation.status }));
  }

  async markOperationsSucceeded(operationIds: string[]): Promise<void> {
    await this.patchOperations(operationIds, { status: 'success', error: null, errorCode: null });
  }

  async markOperationsFailed(operationIds: string[], failure: PublishPlanRunOperationFailure): Promise<void> {
    await this.patchOperations(operationIds, {
      status: 'failed-batch',
      error: failure.error,
      errorCode: failure.errorCode,
    });
  }

  async markOperationFailed(operationId: string, failure: PublishPlanRunOperationFailure): Promise<void> {
    await this.markOperationsFailed([operationId], failure);
  }

  /** Nothing to release: the whole run store is deleted when the run ends. */
  releaseInputsConsumedByCompletedRun(plan: PublishPlanRunPlan): Promise<void> {
    void plan;
    return Promise.resolve();
  }

  private operations(): Promise<PlanOperationIndexEntry[]> {
    if (!this.operationIndexPromise) {
      this.operationIndexPromise = this.loadOperationIndex();
      this.operationIndexPromise.catch(() => {
        this.operationIndexPromise = null;
      });
    }
    return this.operationIndexPromise;
  }

  private async loadOperationIndex(): Promise<PlanOperationIndexEntry[]> {
    const { runStoreClient, runStoreKey } = this.dependencies;
    const operations: PlanOperationIndexEntry[] = [];
    for await (const entries of readAllRunStoreEntries(runStoreClient, runStoreKey, this.planCollection, {
      includeBodies: false,
    })) {
      for (const entry of entries) {
        const meta = entry.meta as unknown as RunStorePlanOperationMeta;
        operations.push({
          id: entry.key,
          phase: meta.phase,
          dataFolderId: meta.dataFolderId ?? null,
          filePath: meta.filePath,
          status: meta.status,
          error: meta.error ?? null,
          errorCode: meta.errorCode ?? null,
          remoteRecordId: meta.remoteRecordId ?? null,
          isRecreate: meta.isRecreate ?? false,
        });
      }
    }
    return operations;
  }

  private async patchOperations(
    operationIds: string[],
    patch: Pick<RunStorePlanOperationMeta, 'status' | 'error' | 'errorCode'>,
  ): Promise<void> {
    if (operationIds.length === 0) return;
    const { runStoreClient, runStoreKey } = this.dependencies;
    for (let index = 0; index < operationIds.length; index += RUN_STORE_BULK_PAGE_SIZE) {
      await runStoreClient.patchEntryMeta(
        runStoreKey,
        this.planCollection,
        operationIds.slice(index, index + RUN_STORE_BULK_PAGE_SIZE).map((key) => ({ key, metaPatch: { ...patch } })),
      );
    }
    const patchedIds = new Set(operationIds);
    for (const operation of await this.operations()) {
      if (patchedIds.has(operation.id)) Object.assign(operation, patch);
    }
  }

  private async patchPlanState(metaPatch: Record<string, unknown>): Promise<void> {
    const { runStoreClient, runStoreKey } = this.dependencies;
    await runStoreClient.patchEntryMeta(runStoreKey, RUN_STORE_PLAN_STATE_COLLECTION, [
      { key: this.planStateKey, metaPatch },
    ]);
  }
}

// =====================================================================================================
// Record ids: created this run, and as pulled
// =====================================================================================================

/** Remote ids of the records this run's create phase made, by record path (persisted for resume). */
export class RunStoreCreatedRecords {
  private remoteRecordIdByPathPromise: Promise<Map<string, string>> | null = null;

  constructor(
    private readonly runStoreClient: RunStoreClient,
    private readonly runStoreKey: RunStoreKey,
  ) {}

  async recordCreatedRecords(records: Array<{ filePath: string; remoteRecordId: string }>): Promise<void> {
    if (records.length === 0) return;
    for (let index = 0; index < records.length; index += RUN_STORE_BULK_PAGE_SIZE) {
      await this.runStoreClient.putEntries(
        this.runStoreKey,
        RUN_STORE_CREATED_RECORDS_COLLECTION,
        records
          .slice(index, index + RUN_STORE_BULK_PAGE_SIZE)
          .map((record) => ({ key: record.filePath, meta: { remoteRecordId: record.remoteRecordId } })),
      );
    }
    const remoteRecordIdByPath = await this.remoteRecordIdByPath();
    for (const record of records) remoteRecordIdByPath.set(record.filePath, record.remoteRecordId);
  }

  async lookUpRemoteRecordId(filePath: string): Promise<string | null> {
    return (await this.remoteRecordIdByPath()).get(filePath) ?? null;
  }

  private remoteRecordIdByPath(): Promise<Map<string, string>> {
    if (!this.remoteRecordIdByPathPromise) {
      this.remoteRecordIdByPathPromise = (async () => {
        const remoteRecordIdByPath = new Map<string, string>();
        for await (const entries of readAllRunStoreEntries(
          this.runStoreClient,
          this.runStoreKey,
          RUN_STORE_CREATED_RECORDS_COLLECTION,
          { includeBodies: false },
        )) {
          for (const entry of entries) {
            if (typeof entry.meta.remoteRecordId === 'string') {
              remoteRecordIdByPath.set(entry.key, entry.meta.remoteRecordId);
            }
          }
        }
        return remoteRecordIdByPath;
      })();
      this.remoteRecordIdByPathPromise.catch(() => {
        this.remoteRecordIdByPathPromise = null;
      });
    }
    return this.remoteRecordIdByPathPromise;
  }
}

/** Remote ids of destination records as this run pulled them, by record path. */
export class RunStorePulledRecordIds {
  private dataFolderIdByFolderPathPromise: Promise<Map<string, string>> | null = null;

  constructor(
    private readonly runStoreClient: RunStoreClient,
    private readonly runStoreKey: RunStoreKey,
    private readonly db: DbService,
    private readonly workbookId: string,
    private readonly connectorAccountId: string,
  ) {}

  async lookUpRemoteRecordIds(filePaths: string[]): Promise<Map<string, string>> {
    const dataFolderIdByFolderPath = await this.dataFolderIdByFolderPath();
    const pathsByDataFolderId = new Map<string, string[]>();
    for (const filePath of filePaths) {
      const lastSlash = filePath.lastIndexOf('/');
      const dataFolderId = dataFolderIdByFolderPath.get(lastSlash === -1 ? '' : filePath.substring(0, lastSlash));
      if (!dataFolderId) continue;
      const paths = pathsByDataFolderId.get(dataFolderId) ?? [];
      paths.push(filePath);
      pathsByDataFolderId.set(dataFolderId, paths);
    }
    const remoteRecordIdByPath = new Map<string, string>();
    for (const [dataFolderId, paths] of pathsByDataFolderId) {
      for (let index = 0; index < paths.length; index += RUN_STORE_BULK_PAGE_SIZE) {
        const { entries } = await this.runStoreClient.readEntriesByKeys(
          this.runStoreKey,
          runStoreRecordsCollection(dataFolderId),
          paths.slice(index, index + RUN_STORE_BULK_PAGE_SIZE),
          { includeBodies: false },
        );
        for (const entry of entries) {
          if (typeof entry.meta.recordId === 'string') remoteRecordIdByPath.set(entry.key, entry.meta.recordId);
        }
      }
    }
    return remoteRecordIdByPath;
  }

  private dataFolderIdByFolderPath(): Promise<Map<string, string>> {
    if (!this.dataFolderIdByFolderPathPromise) {
      this.dataFolderIdByFolderPathPromise = this.db.client.dataFolder
        .findMany({
          where: { workbookId: this.workbookId, connectorAccountId: this.connectorAccountId },
          select: { id: true, path: true },
        })
        .then(
          (dataFolders) =>
            new Map(
              dataFolders
                .filter((dataFolder) => dataFolder.path)
                .map((dataFolder) => [folderPathWithoutLeadingSlash(dataFolder.path), dataFolder.id]),
            ),
        );
      this.dataFolderIdByFolderPathPromise.catch(() => {
        this.dataFolderIdByFolderPathPromise = null;
      });
    }
    return this.dataFolderIdByFolderPathPromise;
  }
}

// =====================================================================================================
// Record writeback
// =====================================================================================================

/**
 * Nothing is written back to git or the file indexes (a run-store workbook keeps no such state). The
 * only write-back that matters within the run is the remote id of every created record: the backfill
 * phase addresses those records, and `@/…` refs name them.
 */
export class RunStoreRecordWriteback implements RecordWriteback {
  constructor(
    private readonly createdRecords: RunStoreCreatedRecords,
    private readonly pulledRecordIds: RunStorePulledRecordIds,
  ) {}

  captureStorageStateBeforeFirstRun(): Promise<void> {
    return Promise.resolve();
  }

  writeBackUpdatedRecords(): Promise<void> {
    return Promise.resolve();
  }

  async writeBackCreatedRecords(args: { records: CreatedRecordToWriteBack[] }): Promise<void> {
    await this.createdRecords.recordCreatedRecords(
      args.records
        .filter((record): record is CreatedRecordToWriteBack & { createdRemoteRecordId: string } =>
          Boolean(record.createdRemoteRecordId),
        )
        .map((record) => ({ filePath: record.filePath, remoteRecordId: record.createdRemoteRecordId })),
    );
  }

  writeBackDeletedRecords(): Promise<void> {
    return Promise.resolve();
  }

  recordUploadedAsset(): Promise<void> {
    return Promise.reject(new Error('Asset uploads are not supported by the Live Export run-store engine'));
  }

  async lookupRemoteRecordIdForFile(args: { filePath: string }): Promise<string | null> {
    return (
      (await this.createdRecords.lookUpRemoteRecordId(args.filePath)) ??
      (await this.pulledRecordIds.lookUpRemoteRecordIds([args.filePath])).get(args.filePath) ??
      null
    );
  }

  lookupRemoteRecordIdsByFilenameInFolder(): Promise<Map<string, string>> {
    return Promise.reject(new Error(RENAME_FILES_UNSUPPORTED_MESSAGE));
  }

  readPublishedRecordFilesInFolder(): Promise<{ path: string; content: string | null }[]> {
    return Promise.reject(new Error(RENAME_FILES_UNSUPPORTED_MESSAGE));
  }

  listFilenamesInFolder(): Promise<string[]> {
    return Promise.reject(new Error(RENAME_FILES_UNSUPPORTED_MESSAGE));
  }

  renamePublishedFilesInFolder(args: {
    folderPath: string;
    renames: PublishedRecordFileRename[];
    connectorAccountId: string | null;
  }): Promise<void> {
    void args;
    return Promise.reject(new Error(RENAME_FILES_UNSUPPORTED_MESSAGE));
  }

  reconcileLocalEditsAfterRun(args: { publishOrigin?: PublishOrigin }): Promise<void> {
    void args;
    return Promise.resolve();
  }

  captureStorageStateAfterRun(): Promise<void> {
    return Promise.resolve();
  }
}

const RENAME_FILES_UNSUPPORTED_MESSAGE =
  'The rename-files phase does not exist for Live Export run-store plans (records have no filenames to fix up)';

// =====================================================================================================
// Pseudo-ref resolver
// =====================================================================================================

/**
 * Resolves `@/<connection>/<path>` refs the way `RefResolverService` does (same parsing, same content
 * walk, same errors), but looks the target up among the records this run created — every `@/…` ref a
 * Live Export sync writes names one — falling back to the records it pulled.
 */
export class RunStorePseudoRefResolver extends RefResolverService {
  constructor(
    fileIndexService: FileIndexService,
    db: DbService,
    private readonly destinationConnectorAccountId: string,
    private readonly createdRecords: RunStoreCreatedRecords,
    private readonly pulledRecordIds: RunStorePulledRecordIds,
  ) {
    super(fileIndexService, db);
  }

  protected override async resolvePseudoRefStrings(
    workbookId: string,
    refStrings: string[],
    connectionFolders: ConnectionFolderIndex,
  ): Promise<Map<string, string>> {
    void workbookId;
    const refStringToRecordId = new Map<string, string>();
    const unresolvedPathByRefString = new Map<string, string>();
    for (const refString of refStrings) {
      const translated: TranslatedPseudoRef = this.translatePseudoRef(refString, connectionFolders);
      if (!translated.candidateConnectorAccountIds.includes(this.destinationConnectorAccountId)) continue;
      const recordPath = translated.folderPath
        ? `${translated.folderPath}/${translated.filename}`
        : translated.filename;
      const createdRemoteRecordId = await this.createdRecords.lookUpRemoteRecordId(recordPath);
      if (createdRemoteRecordId) {
        refStringToRecordId.set(refString, createdRemoteRecordId);
      } else {
        unresolvedPathByRefString.set(refString, recordPath);
      }
    }
    if (unresolvedPathByRefString.size > 0) {
      const pulledRemoteRecordIdByPath = await this.pulledRecordIds.lookUpRemoteRecordIds([
        ...unresolvedPathByRefString.values(),
      ]);
      for (const [refString, recordPath] of unresolvedPathByRefString) {
        const pulledRemoteRecordId = pulledRemoteRecordIdByPath.get(recordPath);
        if (pulledRemoteRecordId) refStringToRecordId.set(refString, pulledRemoteRecordId);
      }
    }
    return refStringToRecordId;
  }
}
