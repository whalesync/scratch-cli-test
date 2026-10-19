import { Type } from '@sinclair/typebox';
import type { DataFolderId, SyncId, TableMappingV2, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { ScheduleService } from 'src/schedule/schedule.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { SyncService } from '../../sync.service';
import type {
  DestinationMappingForSourceRecord,
  RemoteIdMappingPair,
  SyncDestinationOutputSink,
  SyncLookupDataProvider,
  SyncMatchIndex,
  SyncMatchKeyEntry,
  SyncRecordFile,
  SyncRecordSource,
  SyncStoragePorts,
} from '../sync-storage-ports';

/**
 * Proves the storage seam of `syncTableMapping`: with caller-supplied ports the run reads and writes
 * ONLY through them — no git reads/writes of records, no SyncMatchKeys / SyncRemoteIdMapping rows —
 * while matching, transforming and diffing behave exactly as on the classic storage.
 */

const SYNC_ID = 'syn_custom' as SyncId;
const WORKBOOK_ID = 'wkb_custom' as WorkbookId;
const SOURCE_FOLDER_ID = 'dfd_source' as DataFolderId;
const DESTINATION_FOLDER_ID = 'dfd_destination' as DataFolderId;
const ACTOR: Actor = { userId: 'usr_1', organizationId: 'org_1' };

function recordFile(folderId: DataFolderId, path: string, fields: Record<string, unknown>): SyncRecordFile {
  return { folderId, path, content: JSON.stringify(fields) };
}

class InMemorySyncMatchIndex implements SyncMatchIndex {
  readonly matchKeyEntriesByDataFolderId = new Map<string, SyncMatchKeyEntry[]>();
  readonly destinationMappingBySourceRemoteIdByDataFolderId = new Map<
    string,
    Map<string, DestinationMappingForSourceRecord>
  >();

  clearMatchKeysForDataFolder(dataFolderId: DataFolderId): Promise<void> {
    this.matchKeyEntriesByDataFolderId.delete(dataFolderId);
    return Promise.resolve();
  }
  clearRemoteIdMappingsForSourceDataFolder(sourceDataFolderId: DataFolderId): Promise<void> {
    this.destinationMappingBySourceRemoteIdByDataFolderId.delete(sourceDataFolderId);
    return Promise.resolve();
  }
  addMatchKeysForDataFolder(dataFolderId: DataFolderId, matchKeyEntries: SyncMatchKeyEntry[]): Promise<void> {
    const existingEntries = this.matchKeyEntriesByDataFolderId.get(dataFolderId) ?? [];
    this.matchKeyEntriesByDataFolderId.set(dataFolderId, [...existingEntries, ...matchKeyEntries]);
    return Promise.resolve();
  }
  upsertRemoteIdMappingsForSourceDataFolder(
    sourceDataFolderId: DataFolderId,
    remoteIdMappingPairs: RemoteIdMappingPair[],
  ): Promise<void> {
    const mappings = this.mappingsFor(sourceDataFolderId);
    for (const pair of remoteIdMappingPairs) {
      mappings.set(pair.sourceRemoteId, {
        destinationRemoteId: pair.destinationRemoteId,
        destinationFilePath: pair.destinationFilePath,
      });
    }
    return Promise.resolve();
  }
  joinMatchKeysIntoRemoteIdMappings(folders: {
    sourceDataFolderId: DataFolderId;
    destinationDataFolderId: DataFolderId;
  }): Promise<{ totalSourceRecords: number; matchedRecords: number }> {
    const destinationEntryByMatchId = new Map(
      (this.matchKeyEntriesByDataFolderId.get(folders.destinationDataFolderId) ?? []).map((entry) => [
        entry.matchId,
        entry,
      ]),
    );
    const mappings = this.mappingsFor(folders.sourceDataFolderId);
    let matchedRecords = 0;
    const sourceEntries = this.matchKeyEntriesByDataFolderId.get(folders.sourceDataFolderId) ?? [];
    for (const sourceEntry of sourceEntries) {
      const destinationEntry = destinationEntryByMatchId.get(sourceEntry.matchId);
      if (destinationEntry) matchedRecords++;
      mappings.set(sourceEntry.remoteId, {
        destinationRemoteId: destinationEntry?.remoteId ?? null,
        destinationFilePath: destinationEntry?.filePath ?? null,
      });
    }
    return Promise.resolve({ totalSourceRecords: sourceEntries.length, matchedRecords });
  }
  getDestinationMappingsForSourceRemoteIds(
    sourceDataFolderId: DataFolderId,
    sourceRemoteIds: string[],
  ): Promise<Map<string, DestinationMappingForSourceRecord>> {
    const mappings = this.mappingsFor(sourceDataFolderId);
    const found = new Map<string, DestinationMappingForSourceRecord>();
    for (const sourceRemoteId of sourceRemoteIds) {
      const mapping = mappings.get(sourceRemoteId);
      if (mapping) found.set(sourceRemoteId, mapping);
    }
    return Promise.resolve(found);
  }
  recordDestinationsOfNewlyCreatedRecords(
    sourceDataFolderId: DataFolderId,
    newlyCreatedDestinationRecords: Array<{ sourceRemoteId: string; filePath: string; destinationRecordId: string }>,
  ): Promise<void> {
    const mappings = this.mappingsFor(sourceDataFolderId);
    for (const created of newlyCreatedDestinationRecords) {
      mappings.set(created.sourceRemoteId, {
        destinationRemoteId: created.destinationRecordId,
        destinationFilePath: created.filePath,
      });
    }
    return Promise.resolve();
  }
  loadMatchIdsForDataFolder(dataFolderId: DataFolderId): Promise<Set<string>> {
    return Promise.resolve(
      new Set((this.matchKeyEntriesByDataFolderId.get(dataFolderId) ?? []).map((entry) => entry.matchId)),
    );
  }
  private mappingsFor(sourceDataFolderId: string): Map<string, DestinationMappingForSourceRecord> {
    let mappings = this.destinationMappingBySourceRemoteIdByDataFolderId.get(sourceDataFolderId);
    if (!mappings) {
      mappings = new Map();
      this.destinationMappingBySourceRemoteIdByDataFolderId.set(sourceDataFolderId, mappings);
    }
    return mappings;
  }
}

class InMemoryOutputSink implements SyncDestinationOutputSink {
  readonly queuedWrites: Array<{ path: string; content: string }> = [];
  readonly committedWrites: Array<{ path: string; content: string }> = [];
  readonly deletedPaths: string[] = [];
  get queuedRecordFileWriteCount(): number {
    return this.queuedWrites.length;
  }
  queueRecordFileWrite(recordFile: { path: string; content: string }): void {
    this.queuedWrites.push(recordFile);
  }
  flushQueuedRecordFileWritesAtPageBoundary(): Promise<void> {
    return Promise.resolve();
  }
  commitQueuedRecordFileWrites(): Promise<void> {
    this.committedWrites.push(...this.queuedWrites);
    return Promise.resolve();
  }
  deleteRecordFiles(recordFilePaths: string[]): Promise<void> {
    this.deletedPaths.push(...recordFilePaths);
    return Promise.resolve();
  }
}

/**
 * A SyncService whose run reads and writes only through in-memory ports over the given source and destination
 * record files. Only the folder rows (configuration) remain outside the ports; any git access or sync-table access
 * on these mocks would throw (the methods don't exist).
 */
function buildSyncServiceOverInMemoryStoragePorts(params: {
  sourceFiles: SyncRecordFile[];
  destinationFiles: SyncRecordFile[];
  tableSpec?: BaseJsonTableSpec;
}) {
  const { sourceFiles, destinationFiles } = params;
  const destinationContentByPath = new Map(destinationFiles.map((file) => [file.path, file.content]));

  const recordSource: SyncRecordSource = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *pageThroughSourceFolderRecordFiles() {
      yield sourceFiles;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *pageThroughDestinationFolderRecordFiles() {
      yield destinationFiles;
    },
    readDestinationRecordFilesByPath: (_folder, paths) =>
      Promise.resolve(paths.map((path) => ({ path, content: destinationContentByPath.get(path) ?? null }))),
  };
  const matchIndex = new InMemorySyncMatchIndex();
  const outputSink = new InMemoryOutputSink();
  const unusedLookup = () => Promise.reject(new Error('lookup data is not used by this mapping'));
  const lookupDataProvider: SyncLookupDataProvider = {
    loadReferencedFolderRemoteIdMappingRows: unusedLookup,
    clearForeignKeyRecordCache: unusedLookup,
    addForeignKeyRecordsToCache: unusedLookup,
    findCachedForeignKeyRecordFields: unusedLookup,
    getOrCreateDestinationAssetMapping: unusedLookup,
    loadAssetContentHashIndexForFolderPair: unusedLookup,
  };
  const tableSpec = params.tableSpec ?? ({ idPath: 'id' } as unknown as BaseJsonTableSpec);
  const storagePorts: SyncStoragePorts = {
    recordSource,
    tableSpecStore: { readTableSpec: () => Promise.resolve(tableSpec) },
    matchIndex,
    lookupDataProvider,
    openDestinationOutputSink: () => Promise.resolve(outputSink),
  };

  const db = {
    client: {
      dataFolder: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            where.id === SOURCE_FOLDER_ID
              ? { id: SOURCE_FOLDER_ID, path: '/src', connectorAccountId: 'coa_src', connectorService: 'POSTGRES' }
              : {
                  id: DESTINATION_FOLDER_ID,
                  path: '/dest',
                  connectorAccountId: 'coa_dest',
                  connectorService: 'POSTGRES',
                },
          ),
        ),
      },
    },
  } as unknown as DbService;

  const syncService = new SyncService(
    db,
    {} as DataFolderService,
    {} as PostHogService,
    {} as ScheduleService,
    {} as ScratchGitService,
    {} as WorkbookRepoService,
    {} as WorkbookService,
  );
  return { syncService, storagePorts, matchIndex, outputSink };
}

describe('SyncService.syncTableMapping with caller-supplied storage ports', () => {
  it('matches, creates, updates and skips unchanged records entirely through the ports', async () => {
    const { syncService, storagePorts, matchIndex, outputSink } = buildSyncServiceOverInMemoryStoragePorts({
      sourceFiles: [
        recordFile(SOURCE_FOLDER_ID, 'src/a.json', { id: 'src_a', email: 'a@x.com', name: 'Alice (renamed)' }),
        recordFile(SOURCE_FOLDER_ID, 'src/b.json', { id: 'src_b', email: 'b@x.com', name: 'Bob' }),
        recordFile(SOURCE_FOLDER_ID, 'src/c.json', { id: 'src_c', email: 'c@x.com', name: 'Carol' }),
      ],
      destinationFiles: [
        recordFile(DESTINATION_FOLDER_ID, 'dest/alice.json', { id: 'dst_a', email: 'a@x.com', name: 'Alice' }),
        recordFile(DESTINATION_FOLDER_ID, 'dest/bob.json', { id: 'dst_b', email: 'b@x.com', name: 'Bob' }),
      ],
    });

    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: SOURCE_FOLDER_ID,
      destinationDataFolderId: DESTINATION_FOLDER_ID,
      columnMappings: [
        { source: { kind: 'column', columnId: 'email' }, destinationColumnId: 'email' },
        { source: { kind: 'column', columnId: 'name' }, destinationColumnId: 'name' },
      ],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
    };

    const result = await syncService.syncTableMapping(
      SYNC_ID,
      tableMapping,
      WORKBOOK_ID,
      ACTOR,
      'DATA',
      undefined,
      storagePorts,
    );

    expect(result.errorCount).toBe(0);
    expect(result.recordsUpdated).toBe(1);
    expect(result.recordsCreated).toBe(1);
    expect(result.updatedPaths).toEqual(['dest/alice.json']);
    expect(outputSink.committedWrites.map((write) => write.path)).toEqual(
      expect.arrayContaining(['dest/alice.json', result.createdPaths[0]]),
    );
    expect(outputSink.committedWrites).toHaveLength(2);
    expect(JSON.parse(outputSink.committedWrites[0].content)).toMatchObject({
      id: 'dst_a',
      name: 'Alice (renamed)',
    });
    // The DATA phase left the created record's destination in the match index, for the FK phase.
    expect(
      matchIndex.destinationMappingBySourceRemoteIdByDataFolderId.get(SOURCE_FOLDER_ID)?.get('src_c')
        ?.destinationFilePath,
    ).toBe(result.createdPaths[0]);
  });

  describe('leaving out source records the pull could only partly read', () => {
    // A partly-read source record is missing a mapped field (here `history`, as an Intercom conversation pulled
    // without its conversation_parts). Synced, the missing field would clear the destination's value.
    const sourceFiles = [
      recordFile(SOURCE_FOLDER_ID, 'src/a.json', { id: 'src_a', email: 'a@x.com', history: 'Alice v2' }),
      recordFile(SOURCE_FOLDER_ID, 'src/b.json', { id: 'src_b', email: 'b@x.com' }),
      recordFile(SOURCE_FOLDER_ID, 'src/c.json', { id: 'src_c', email: 'c@x.com' }),
    ];
    const destinationFiles = [
      recordFile(DESTINATION_FOLDER_ID, 'dest/alice.json', { id: 'dst_a', email: 'a@x.com', history: 'Alice v1' }),
      recordFile(DESTINATION_FOLDER_ID, 'dest/bob.json', { id: 'dst_b', email: 'b@x.com', history: 'Bob history' }),
      // No source counterpart at all: the delete policy removes it, proving Pass 3 ran.
      recordFile(DESTINATION_FOLDER_ID, 'dest/orphan.json', { id: 'dst_z', email: 'z@x.com', history: 'Gone' }),
    ];
    // A schema carrying the match-key column, so Pass 3 (the unmatched-destination delete policy) runs.
    const tableSpec = {
      idPath: 'id',
      schema: Type.Object({ id: Type.String(), email: Type.String(), history: Type.String() }),
    } as unknown as BaseJsonTableSpec;
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: SOURCE_FOLDER_ID,
      destinationDataFolderId: DESTINATION_FOLDER_ID,
      columnMappings: [
        { source: { kind: 'column', columnId: 'email' }, destinationColumnId: 'email' },
        { source: { kind: 'column', columnId: 'history' }, destinationColumnId: 'history' },
      ],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'delete' },
    };

    it('neither updates, creates nor deletes their destination records, and warns for each', async () => {
      const { syncService, storagePorts, outputSink } = buildSyncServiceOverInMemoryStoragePorts({
        sourceFiles,
        destinationFiles,
        tableSpec,
      });

      const result = await syncService.syncTableMapping(
        SYNC_ID,
        tableMapping,
        WORKBOOK_ID,
        ACTOR,
        'DATA',
        undefined,
        storagePorts,
        new Set(['src_b', 'src_c']),
      );

      expect(result.errorCount).toBe(0);
      // Only the fully-read record is synced.
      expect(outputSink.committedWrites.map((write) => write.path)).toEqual(['dest/alice.json']);
      expect(result.recordsCreated).toBe(0);
      // Bob's destination record still matches its (partly-read) source record, so the delete policy keeps it
      // and removes only the true orphan.
      expect(outputSink.deletedPaths).toEqual(['dest/orphan.json']);
      expect(result.recordsDeleted).toBe(1);
      expect(result.recordsSkipped).toBe(2);
      expect(result.warningCount).toBe(2);
      expect(result.warnings.map((warning) => warning.sourceRemoteId)).toEqual(['src_b', 'src_c']);
      expect(result.warnings[0].warning).toMatch(/^Not synced: the pull could only partly read this record/);
    });

    it('would otherwise clear the destination value the partly-read record is missing, and create the new one', async () => {
      const { syncService, storagePorts, outputSink } = buildSyncServiceOverInMemoryStoragePorts({
        sourceFiles,
        destinationFiles,
        tableSpec,
      });

      const result = await syncService.syncTableMapping(
        SYNC_ID,
        tableMapping,
        WORKBOOK_ID,
        ACTOR,
        'DATA',
        undefined,
        storagePorts,
      );

      const bobWrite = outputSink.committedWrites.find((write) => write.path === 'dest/bob.json');
      expect(bobWrite && JSON.parse(bobWrite.content)).toMatchObject({ id: 'dst_b', history: null });
      expect(result.recordsCreated).toBe(1);
    });
  });
});
