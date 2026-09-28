import type { TableView } from '@spinner/shared-types';
import type { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';
import { readRecordIdAsString } from 'src/remote-service/connectors/types';
import type { TableSpecLocation } from 'src/workbook/table-spec-store/table-spec-store';
import type {
  FinishFolderOptions,
  PullSink,
  PullSinkFolder,
  PullSinkFolderChangeSummary,
} from 'src/worker/jobs/job-definitions/pull-sink/pull-sink';
import { type RunStoreClient, type RunStoreEntryToPut, type RunStoreKey } from './run-store-client';
import { runStorePulledRecordPath, runStoreRecordsCollection } from './run-store-collections';
import { RunStoreTableSpecStore } from './run-store-table-spec-store';

/**
 * The Live Export run-store `PullSink`: each connector page is written to the run's
 * `records:<dataFolderId>` collection as one bulk request, and the fetched table spec to `schemas`.
 * No git, no FileIndex/FileReference/Asset rows, no commits, no stale-file deletion — the run store
 * started empty this run, so everything in it was pulled by this run.
 *
 * Every page is written before the job checkpoints the connector cursor past it, so a resumed pull
 * never skips a record; re-delivered records converge on the same key (upsert).
 */
export class RunStorePullSink implements PullSink {
  /** The run store starts empty every run: there is no baseline for an incremental pull to extend. */
  readonly persistsIncrementalPullBaseline = false;

  private readonly tableSpecStore: RunStoreTableSpecStore;
  private recordsWithoutIdCounter = 0;

  constructor(
    private readonly runStoreClient: RunStoreClient,
    private readonly runStoreKey: RunStoreKey,
    /**
     * Persists a folder's record count (`DataFolder.recordCount` — the Live Export record limit and the
     * UI read it). The classic pull derives it from git; a run-store pull knows it exactly.
     */
    private readonly recordPulledRecordCount?: (dataFolderId: string, recordCount: number) => Promise<void>,
  ) {
    this.tableSpecStore = new RunStoreTableSpecStore(runStoreClient, runStoreKey);
  }

  /** The routine's first step created the run store; fail fast (with a clear message) if it's gone. */
  async prepareStorageBeforeLoadingFolders(): Promise<void> {
    const summary = await this.runStoreClient.getRunStoreSummary(this.runStoreKey);
    if (!summary) {
      throw new Error(
        `Live Export run store ${this.runStoreKey} does not exist — the run's first step should have created it`,
      );
    }
  }

  async storeFolderTableSpec(location: TableSpecLocation, tableSpec: BaseJsonTableSpec): Promise<void> {
    await this.tableSpecStore.writeTableSpec(location, tableSpec);
  }

  /** Views are a UI concern; nothing in a Live Export run reads them. */
  storeFolderDefaultView(location: TableSpecLocation, defaultView: TableView): Promise<void> {
    void location;
    void defaultView;
    return Promise.resolve();
  }

  prepareFolderForIncomingRecordPages(folder: PullSinkFolder): Promise<void> {
    void folder;
    return Promise.resolve();
  }

  async writeConnectorRecordPage(folder: PullSinkFolder, connectorRecordsInPage: ConnectorFile[]): Promise<void> {
    if (connectorRecordsInPage.length === 0) {
      return;
    }
    const { dataFolder, tableSpec } = folder;
    const entries: RunStoreEntryToPut[] = connectorRecordsInPage.map((record) => {
      const recordId = readRecordIdAsString(record, tableSpec.idPath);
      // A record with no id can't be addressed; keep it under a unique key so the sync reports it
      // (it fails with "missing id") instead of it silently vanishing.
      const recordKeyId = recordId ?? `__record-without-id-${this.recordsWithoutIdCounter++}`;
      return {
        key: runStorePulledRecordPath(dataFolder.path ?? dataFolder.name, recordKeyId),
        meta: { recordId },
        // Verbatim connector output (Connector Prime Directive); compact, since nothing reads it by eye.
        body: JSON.stringify(record),
      };
    });
    await this.runStoreClient.putEntries(this.runStoreKey, runStoreRecordsCollection(dataFolder.id), entries);
  }

  releaseRecordPageWritingStateForFolder(folder: PullSinkFolder): void {
    void folder;
  }

  /**
   * Every page is already in the store; only the folder's record count is persisted (the store dedupes
   * re-delivered records, so its entry count is exact). The run store has no previous state to compare
   * against, so there are no created/updated/deleted counts — the job reports what it fetched.
   */
  async finishFolderAfterAllRecordPagesWritten(
    folder: PullSinkFolder,
    options: FinishFolderOptions,
  ): Promise<PullSinkFolderChangeSummary> {
    void options;
    if (this.recordPulledRecordCount) {
      const summary = await this.runStoreClient.getRunStoreSummary(this.runStoreKey);
      const recordsCollection = runStoreRecordsCollection(folder.dataFolder.id);
      const recordCount =
        summary?.collections.find((collection) => collection.collection === recordsCollection)?.entryCount ?? 0;
      await this.recordPulledRecordCount(folder.dataFolder.id, recordCount);
    }
    return {
      created: 0,
      updated: 0,
      deleted: 0,
      createdPaths: [],
      updatedPaths: [],
      deletedPaths: [],
    };
  }

  /** The run store outlives the pull: the run deletes it when it ends. */
  cleanUpTemporaryStorageAfterPullAttempt(): Promise<void> {
    return Promise.resolve();
  }

  finalizeStorageAfterAllFoldersFinished(): Promise<void> {
    return Promise.resolve();
  }
}
