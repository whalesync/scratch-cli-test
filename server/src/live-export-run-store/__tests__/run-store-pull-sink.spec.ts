import type { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';
import type { PullSinkFolder } from 'src/worker/jobs/job-definitions/pull-sink/pull-sink';
import { InMemoryRunStoreClient } from '../in-memory-run-store-client';
import { runStoreKeyForRoutineRun } from '../run-store-client';
import { runStoreRecordsCollection } from '../run-store-collections';
import { RunStorePullSink } from '../run-store-pull-sink';
import { RunStoreTableSpecStore } from '../run-store-table-spec-store';

const RUN_STORE_KEY = runStoreKeyForRoutineRun('rrn_pull');
const TABLE_SPEC = { name: 'Products', idPath: 'id' } as unknown as BaseJsonTableSpec;
const FOLDER = {
  dataFolder: {
    id: 'dfd_products',
    workbookId: 'wkb_1',
    name: 'Products',
    path: '/Shop/Products',
    connectorService: 'SHOPIFY',
    connectorAccountId: 'coa_1',
  },
  connector: {},
  tableSpec: TABLE_SPEC,
} as unknown as PullSinkFolder;

describe('RunStorePullSink', () => {
  it('refuses to pull into a run store the run never created', async () => {
    const sink = new RunStorePullSink(new InMemoryRunStoreClient(), RUN_STORE_KEY);
    await expect(sink.prepareStorageBeforeLoadingFolders()).rejects.toThrow('does not exist');
  });

  it('stores each page verbatim under one key per record id, the spec for the sync, and the record count', async () => {
    const client = new InMemoryRunStoreClient();
    await client.createOrClearRunStore(RUN_STORE_KEY);
    const recordPulledRecordCount = jest.fn().mockResolvedValue(undefined);
    const sink = new RunStorePullSink(client, RUN_STORE_KEY, recordPulledRecordCount);
    await sink.prepareStorageBeforeLoadingFolders();
    await sink.storeFolderTableSpec({ connectorAccountId: 'coa_1', folderPath: '/Shop/Products' }, TABLE_SPEC);

    await sink.writeConnectorRecordPage(FOLDER, [
      { id: 'gid://shopify/Product/1', title: 'A' },
      { id: 'gid://shopify/Product/2', title: 'B', nested: { keep: ['as', 'is'] } },
    ] as ConnectorFile[]);
    // Re-delivered record (e.g. an unstable page boundary) converges on the same entry.
    await sink.writeConnectorRecordPage(FOLDER, [{ id: 'gid://shopify/Product/1', title: 'A' }] as ConnectorFile[]);
    const summary = await sink.finishFolderAfterAllRecordPagesWritten(FOLDER, {
      isResumingFromEarlierAttempt: false,
      mayRemoveRecordsAbsentFromThisPull: true,
      reportDurableProgress: jest.fn(),
    });

    const stored = await client.readEntriesPage(RUN_STORE_KEY, runStoreRecordsCollection('dfd_products'), {
      includeBodies: true,
    });
    expect(stored.entries).toEqual([
      {
        key: 'Shop/Products/gid%3A%2F%2Fshopify%2FProduct%2F1.json',
        meta: { recordId: 'gid://shopify/Product/1' },
        body: '{"id":"gid://shopify/Product/1","title":"A"}',
      },
      {
        key: 'Shop/Products/gid%3A%2F%2Fshopify%2FProduct%2F2.json',
        meta: { recordId: 'gid://shopify/Product/2' },
        body: '{"id":"gid://shopify/Product/2","title":"B","nested":{"keep":["as","is"]}}',
      },
    ]);
    expect(recordPulledRecordCount).toHaveBeenCalledWith('dfd_products', 2);
    expect(summary).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    expect(
      await new RunStoreTableSpecStore(client, RUN_STORE_KEY).readTableSpec({
        connectorAccountId: 'coa_1',
        folderPath: 'Shop/Products',
      }),
    ).toEqual(TABLE_SPEC);
    expect(sink.persistsIncrementalPullBaseline).toBe(false);
    expect(sink.reportsRecordChangeCounts).toBe(false);
  });
});
