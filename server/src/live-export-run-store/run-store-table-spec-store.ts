import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import type { TableSpecLocation, TableSpecStore } from 'src/workbook/table-spec-store/table-spec-store';
import { type RunStoreClient, type RunStoreKey } from './run-store-client';
import { RUN_STORE_SCHEMAS_COLLECTION, runStoreTableSpecKey } from './run-store-collections';

/**
 * Table specs in the run store: the pull writes the spec it just fetched from the connector, and the
 * sync and publish of the same run read it back. Reads are cached for the life of this object (a job).
 * Keyed by connection + folder path; the location's `dataFolderId` is ignored.
 */
export class RunStoreTableSpecStore implements TableSpecStore {
  private readonly tableSpecByKey = new Map<string, Promise<BaseJsonTableSpec | null>>();

  constructor(
    private readonly runStoreClient: RunStoreClient,
    private readonly runStoreKey: RunStoreKey,
  ) {}

  readTableSpec(location: TableSpecLocation): Promise<BaseJsonTableSpec | null> {
    const key = runStoreTableSpecKey(location.connectorAccountId, location.folderPath);
    let tableSpec = this.tableSpecByKey.get(key);
    if (!tableSpec) {
      tableSpec = this.runStoreClient
        .readEntriesByKeys(this.runStoreKey, RUN_STORE_SCHEMAS_COLLECTION, [key], { includeBodies: true })
        .then(({ entries }) => {
          const body = entries[0]?.body;
          return body ? (JSON.parse(body) as BaseJsonTableSpec) : null;
        });
      this.tableSpecByKey.set(key, tableSpec);
      // A failed read is not cached: the next caller gets its own attempt.
      tableSpec.catch(() => this.tableSpecByKey.delete(key));
    }
    return tableSpec;
  }

  async writeTableSpec(location: TableSpecLocation, tableSpec: BaseJsonTableSpec): Promise<void> {
    const key = runStoreTableSpecKey(location.connectorAccountId, location.folderPath);
    await this.runStoreClient.putEntries(this.runStoreKey, RUN_STORE_SCHEMAS_COLLECTION, [
      { key, body: JSON.stringify(tableSpec) },
    ]);
    this.tableSpecByKey.set(key, Promise.resolve(tableSpec));
  }
}
