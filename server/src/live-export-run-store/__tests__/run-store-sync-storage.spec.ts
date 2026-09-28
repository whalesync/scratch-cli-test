import type { DataFolderId, SyncId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { InMemoryRunStoreClient } from '../in-memory-run-store-client';
import { runStoreKeyForRoutineRun } from '../run-store-client';
import { runStoreRecordsCollection, runStoreSyncOutputCollection } from '../run-store-collections';
import {
  createRunStoreSyncStoragePorts,
  InMemorySyncMatchIndex,
  resetRunStoreSyncOutputForDestinationFolders,
  RunStoreSyncOutputSink,
  RunStoreSyncRecordSource,
  SyncOutputOverlay,
} from '../run-store-sync-storage';

const RUN_STORE_KEY = runStoreKeyForRoutineRun('rrn_test');
const SOURCE_FOLDER = 'dfd_source' as DataFolderId;
const DESTINATION_FOLDER = 'dfd_destination' as DataFolderId;
const DESTINATION_LOCATION = {
  dataFolderId: DESTINATION_FOLDER,
  folderPathWithoutLeadingSlash: 'Posts',
  connectorAccountId: 'coa_1',
};
const LOG_CONTEXT = { syncId: 'syn_1', passLabel: 'Pass 1', destinationFolderPath: '/Posts' };

async function collectPages<T>(pages: AsyncGenerator<T[]>): Promise<T[][]> {
  const collected: T[][] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

async function storeWithDestinationRecords(): Promise<InMemoryRunStoreClient> {
  const client = new InMemoryRunStoreClient();
  await client.createOrClearRunStore(RUN_STORE_KEY);
  await client.putEntries(RUN_STORE_KEY, runStoreRecordsCollection(DESTINATION_FOLDER), [
    { key: 'Posts/1.json', meta: { recordId: '1' }, body: '{"id":"1","title":"one"}' },
    { key: 'Posts/2.json', meta: { recordId: '2' }, body: '{"id":"2","title":"two"}' },
    { key: 'Posts/3.json', meta: { recordId: '3' }, body: '{"id":"3","title":"three"}' },
  ]);
  return client;
}

describe('InMemorySyncMatchIndex (the SyncMatchKeys/SyncRemoteIdMapping semantics, in memory)', () => {
  it('keeps the first entry for a duplicated match id and joins source keys to destination keys', async () => {
    const index = new InMemorySyncMatchIndex();
    await index.addMatchKeysForDataFolder(SOURCE_FOLDER, [
      { matchId: 'a', remoteId: 'src_a', filePath: 'src/a.json' },
      { matchId: 'b', remoteId: 'src_b', filePath: 'src/b.json' },
    ]);
    await index.addMatchKeysForDataFolder(DESTINATION_FOLDER, [
      { matchId: 'a', remoteId: 'dst_a', filePath: 'Posts/a.json' },
      { matchId: 'a', remoteId: 'dst_a_duplicate', filePath: 'Posts/a2.json' },
    ]);

    const counts = await index.joinMatchKeysIntoRemoteIdMappings({
      sourceDataFolderId: SOURCE_FOLDER,
      destinationDataFolderId: DESTINATION_FOLDER,
    });

    expect(counts).toEqual({ totalSourceRecords: 2, matchedRecords: 1 });
    const mappings = await index.getDestinationMappingsForSourceRemoteIds(SOURCE_FOLDER, ['src_a', 'src_b', 'src_x']);
    expect(Object.fromEntries(mappings)).toEqual({
      src_a: { destinationRemoteId: 'dst_a', destinationFilePath: 'Posts/a.json' },
      src_b: { destinationRemoteId: null, destinationFilePath: null },
    });
    expect(await index.loadMatchIdsForDataFolder(SOURCE_FOLDER)).toEqual(new Set(['a', 'b']));
  });

  it('prefers a matched destination when one source record reduced to several match ids', async () => {
    const index = new InMemorySyncMatchIndex();
    await index.addMatchKeysForDataFolder(SOURCE_FOLDER, [
      { matchId: 'unmatched-key', remoteId: 'src_dup', filePath: 'src/dup-1.json' },
      { matchId: 'matched-key', remoteId: 'src_dup', filePath: 'src/dup-2.json' },
    ]);
    await index.addMatchKeysForDataFolder(DESTINATION_FOLDER, [
      { matchId: 'matched-key', remoteId: 'dst_1', filePath: 'Posts/1.json' },
    ]);

    await index.joinMatchKeysIntoRemoteIdMappings({
      sourceDataFolderId: SOURCE_FOLDER,
      destinationDataFolderId: DESTINATION_FOLDER,
    });

    const mappings = await index.getDestinationMappingsForSourceRemoteIds(SOURCE_FOLDER, ['src_dup']);
    expect(mappings.get('src_dup')).toEqual({ destinationRemoteId: 'dst_1', destinationFilePath: 'Posts/1.json' });
  });

  it('fills in the destination of newly created records only for mappings that exist', async () => {
    const index = new InMemorySyncMatchIndex();
    await index.upsertRemoteIdMappingsForSourceDataFolder(SOURCE_FOLDER, [
      { sourceRemoteId: 'src_new', destinationRemoteId: null, destinationFilePath: null },
    ]);

    await index.recordDestinationsOfNewlyCreatedRecords(SOURCE_FOLDER, [
      { sourceRemoteId: 'src_new', filePath: 'Posts/new.json', destinationRecordId: 'pending_1' },
      { sourceRemoteId: 'src_unknown', filePath: 'Posts/unknown.json', destinationRecordId: 'pending_2' },
    ]);

    expect(index.remoteIdMappingRowsForSourceFolder(SOURCE_FOLDER)).toEqual([
      { sourceRemoteId: 'src_new', destinationRemoteId: 'pending_1', destinationFilePath: 'Posts/new.json' },
    ]);
  });
});

describe('RunStoreSyncRecordSource', () => {
  it('reads a folder once and serves the second pass from memory', async () => {
    const client = await storeWithDestinationRecords();
    const source = new RunStoreSyncRecordSource(client, RUN_STORE_KEY, new SyncOutputOverlay(), 1024 * 1024);

    const firstPass = await collectPages(
      source.pageThroughDestinationFolderRecordFiles(DESTINATION_FOLDER, LOG_CONTEXT),
    );
    const readsAfterFirstPass = client.callLog.filter((call) => call.method === 'readEntriesPage').length;
    const secondPass = await collectPages(
      source.pageThroughDestinationFolderRecordFiles(DESTINATION_FOLDER, LOG_CONTEXT),
    );

    expect(secondPass).toEqual(firstPass);
    expect(firstPass.flat().map((file) => file.path)).toEqual(['Posts/1.json', 'Posts/2.json', 'Posts/3.json']);
    expect(client.callLog.filter((call) => call.method === 'readEntriesPage').length).toBe(readsAfterFirstPass);
  });

  it('re-reads a folder that does not fit in the cache budget', async () => {
    const client = await storeWithDestinationRecords();
    const source = new RunStoreSyncRecordSource(client, RUN_STORE_KEY, new SyncOutputOverlay(), 10);

    await collectPages(source.pageThroughSourceFolderRecordFiles(DESTINATION_FOLDER));
    await collectPages(source.pageThroughSourceFolderRecordFiles(DESTINATION_FOLDER));

    expect(client.callLog.filter((call) => call.method === 'readEntriesPage').length).toBe(2);
  });

  it("shows destination reads this run's committed output: rewritten, deleted and created records", async () => {
    const client = await storeWithDestinationRecords();
    const overlay = new SyncOutputOverlay();
    const source = new RunStoreSyncRecordSource(client, RUN_STORE_KEY, overlay, 1024 * 1024);
    await client.putEntries(RUN_STORE_KEY, runStoreSyncOutputCollection(DESTINATION_FOLDER), [
      { key: 'Posts/1.json', meta: { deleted: false }, body: '{"id":"1","title":"one v2"}' },
      { key: 'Posts/new.json', meta: { deleted: false }, body: '{"id":"pending","title":"new"}' },
      { key: 'Posts/3.json', meta: { deleted: true }, body: null },
    ]);
    overlay.recordWrittenPaths(DESTINATION_FOLDER, ['Posts/1.json', 'Posts/new.json']);
    overlay.recordDeletedPaths(DESTINATION_FOLDER, ['Posts/3.json']);

    const destinationFiles = (
      await collectPages(source.pageThroughDestinationFolderRecordFiles(DESTINATION_FOLDER, LOG_CONTEXT))
    ).flat();
    const readByPath = await source.readDestinationRecordFilesByPath(DESTINATION_LOCATION, [
      'Posts/1.json',
      'Posts/2.json',
      'Posts/3.json',
      'Posts/new.json',
      'Posts/missing.json',
    ]);

    expect(destinationFiles.map((file) => [file.path, file.content])).toEqual([
      ['Posts/1.json', '{"id":"1","title":"one v2"}'],
      ['Posts/2.json', '{"id":"2","title":"two"}'],
      ['Posts/new.json', '{"id":"pending","title":"new"}'],
    ]);
    expect(readByPath).toEqual([
      { path: 'Posts/1.json', content: '{"id":"1","title":"one v2"}' },
      { path: 'Posts/2.json', content: '{"id":"2","title":"two"}' },
      { path: 'Posts/3.json', content: null },
      { path: 'Posts/new.json', content: '{"id":"pending","title":"new"}' },
      { path: 'Posts/missing.json', content: null },
    ]);
  });
});

describe('RunStoreSyncOutputSink', () => {
  it("lands a table's writes in sync-output in one merge, then applies deletions", async () => {
    const client = await storeWithDestinationRecords();
    const overlay = new SyncOutputOverlay();
    const sink = new RunStoreSyncOutputSink(client, RUN_STORE_KEY, 'syn_1', DESTINATION_LOCATION, overlay);

    sink.queueRecordFileWrite({ path: 'Posts/1.json', content: '{"id":"1"}' });
    sink.queueRecordFileWrite({ path: 'Posts/new.json', content: '{"id":"n"}' });
    await sink.flushQueuedRecordFileWritesAtPageBoundary();
    expect(
      (
        await client.readEntriesPage(RUN_STORE_KEY, runStoreSyncOutputCollection(DESTINATION_FOLDER), {
          includeBodies: false,
        })
      ).entries,
    ).toEqual([]); // nothing visible before the commit

    await sink.commitQueuedRecordFileWrites();
    await sink.deleteRecordFiles(['Posts/2.json']);

    const output = await client.readEntriesPage(RUN_STORE_KEY, runStoreSyncOutputCollection(DESTINATION_FOLDER), {
      includeBodies: true,
    });
    expect(output.entries).toEqual([
      { key: 'Posts/1.json', meta: { deleted: false }, body: '{"id":"1"}' },
      { key: 'Posts/2.json', meta: { deleted: true }, body: null },
      { key: 'Posts/new.json', meta: { deleted: false }, body: '{"id":"n"}' },
    ]);
    expect(sink.queuedRecordFileWriteCount).toBe(2);
    expect(overlay.stateFor(DESTINATION_FOLDER)).toEqual({
      writtenPaths: new Set(['Posts/1.json', 'Posts/new.json']),
      deletedPaths: new Set(['Posts/2.json']),
    });
  });

  it('leaves nothing behind when the commit fails', async () => {
    const client = await storeWithDestinationRecords();
    jest.spyOn(client, 'mergeCollectionInto').mockRejectedValue(new Error('disk full'));
    const overlay = new SyncOutputOverlay();
    const sink = new RunStoreSyncOutputSink(client, RUN_STORE_KEY, 'syn_1', DESTINATION_LOCATION, overlay);
    sink.queueRecordFileWrite({ path: 'Posts/1.json', content: '{"id":"1"}' });

    await expect(sink.commitQueuedRecordFileWrites()).rejects.toThrow('disk full');

    const summary = await client.getRunStoreSummary(RUN_STORE_KEY);
    expect(summary?.collections.map((collection) => collection.collection)).toEqual([
      runStoreRecordsCollection(DESTINATION_FOLDER),
    ]);
    expect(overlay.stateFor(DESTINATION_FOLDER)).toBeUndefined();
  });
});

describe('RunStoreSyncOutputSink deletions and sync redelivery', () => {
  it('leaves no tombstone behind when a deletion fails part-way', async () => {
    const client = await storeWithDestinationRecords();
    jest.spyOn(client, 'mergeCollectionInto').mockRejectedValue(new Error('disk full'));
    const overlay = new SyncOutputOverlay();
    const sink = new RunStoreSyncOutputSink(client, RUN_STORE_KEY, 'syn_1', DESTINATION_LOCATION, overlay);

    await expect(sink.deleteRecordFiles(['Posts/1.json', 'Posts/2.json'])).rejects.toThrow('disk full');

    const summary = await client.getRunStoreSummary(RUN_STORE_KEY);
    expect(summary?.collections.map((collection) => collection.collection)).toEqual([
      runStoreRecordsCollection(DESTINATION_FOLDER),
    ]);
    expect(overlay.stateFor(DESTINATION_FOLDER)).toBeUndefined();
  });

  it("clears a dead attempt's sync output and staging for the sync's destination folders only", async () => {
    const client = await storeWithDestinationRecords();
    const deadAttemptSink = new RunStoreSyncOutputSink(
      client,
      RUN_STORE_KEY,
      'syn_1',
      DESTINATION_LOCATION,
      new SyncOutputOverlay(),
    );
    deadAttemptSink.queueRecordFileWrite({ path: 'Posts/created-by-dead-attempt.json', content: '{}' });
    await deadAttemptSink.commitQueuedRecordFileWrites();
    // A second table whose staging the dead attempt never merged.
    deadAttemptSink.queueRecordFileWrite({ path: 'Posts/staged.json', content: '{}' });
    await deadAttemptSink.flushQueuedRecordFileWritesAtPageBoundary();
    await client.putEntries(RUN_STORE_KEY, runStoreSyncOutputCollection('dfd_other_sync' as DataFolderId), [
      { key: 'Other/1.json', meta: { deleted: false }, body: '{}' },
    ]);

    await resetRunStoreSyncOutputForDestinationFolders(client, RUN_STORE_KEY, [DESTINATION_FOLDER]);

    const summary = await client.getRunStoreSummary(RUN_STORE_KEY);
    expect(summary?.collections.map((collection) => collection.collection).sort()).toEqual(
      [
        runStoreRecordsCollection(DESTINATION_FOLDER),
        runStoreSyncOutputCollection('dfd_other_sync' as DataFolderId),
      ].sort(),
    );
  });

  it('refuses to sync in a run store the run never created', async () => {
    await expect(
      resetRunStoreSyncOutputForDestinationFolders(new InMemoryRunStoreClient(), RUN_STORE_KEY, [DESTINATION_FOLDER]),
    ).rejects.toThrow('does not exist');
  });
});

describe('createRunStoreSyncStoragePorts', () => {
  it('reads referenced-folder mappings from the run (config from Postgres, mappings from memory)', async () => {
    const client = await storeWithDestinationRecords();
    const tablePair = {
      destinationDataFolderId: DESTINATION_FOLDER,
      sourceDataFolder: { name: 'Authors', connectorService: 'AIRTABLE' },
      destinationDataFolder: { name: 'Posts', connectorAccount: { displayName: 'Webflow' } },
    };
    const db = {
      client: { syncTablePair: { findFirst: jest.fn().mockResolvedValue(tablePair) } },
    } as unknown as DbService;
    const ports = createRunStoreSyncStoragePorts({
      runStoreClient: client,
      runStoreKey: RUN_STORE_KEY,
      db,
      syncId: 'syn_1' as SyncId,
    });
    await ports.matchIndex.upsertRemoteIdMappingsForSourceDataFolder(SOURCE_FOLDER, [
      { sourceRemoteId: 'src_1', destinationRemoteId: 'dst_1', destinationFilePath: 'Posts/1.json' },
    ]);

    const rows = await ports.lookupDataProvider.loadReferencedFolderRemoteIdMappingRows(SOURCE_FOLDER);

    expect(rows).toEqual({
      referencedTablePair: tablePair,
      remoteIdMappingRows: [
        { sourceRemoteId: 'src_1', destinationRemoteId: 'dst_1', destinationFilePath: 'Posts/1.json' },
      ],
    });
    await expect(
      ports.lookupDataProvider.getOrCreateDestinationAssetMapping({
        sourceAssetRemoteId: 'a',
        sourceDataFolderId: SOURCE_FOLDER,
        sourceService: 'AIRTABLE',
        destinationDataFolderId: DESTINATION_FOLDER,
        destinationService: 'WEBFLOW',
      }),
    ).rejects.toThrow('Asset transformers are not supported');
  });
});
