import { DataFolderId, SyncId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { Service } from 'src/remote-service/connectors/service-constants';
import { createLookupTools } from '../lookup-tools';

const SYNC_ID = 'sync_1' as SyncId;
const WORKBOOK_ID = 'wkb_1' as WorkbookId;
// referencedDataFolderId is the SOURCE folder of the referenced table pair.
const SOURCE_REFERENCED_FOLDER = 'dfd_source_authors' as DataFolderId;

describe('createLookupTools.getDestinationMappingForSourceFk (DEV-10880)', () => {
  it('derives destinationConnectionFolder from the DESTINATION folder of the table pair, not the source', () => {
    const syncTablePairFindFirst = jest.fn().mockResolvedValue({
      // The DESTINATION folder's connection — this is what must surface, NOT the
      // source folder's connection (whose id is referencedDataFolderId).
      destinationDataFolder: { connectorAccount: { displayName: 'Webflow: Marketing' } },
    });
    const syncRemoteIdMappingFindMany = jest
      .fn()
      .mockResolvedValue([
        { sourceRemoteId: 'src_1', destinationFilePath: 'Authors/alice.json', destinationRemoteId: null },
      ]);

    const db = {
      client: {
        syncTablePair: { findFirst: syncTablePairFindFirst },
        syncRemoteIdMapping: { findMany: syncRemoteIdMappingFindMany },
      },
    } as unknown as DbService;

    const lookupTools = createLookupTools(db, SYNC_ID, WORKBOOK_ID, Service.AIRTABLE, Service.WEBFLOW, () =>
      Promise.resolve(),
    );

    return lookupTools.getDestinationMappingForSourceFk('src_1', SOURCE_REFERENCED_FOLDER).then((resolution) => {
      expect(resolution).toEqual({
        kind: 'mapped',
        mapping: {
          destinationFilePath: 'Authors/alice.json',
          destinationRemoteId: null,
          // `Webflow: Marketing` → `:` is a filesystem-reserved char, sanitized to `-`.
          destinationConnectionFolder: 'Webflow- Marketing',
        },
      });
      // Looked up the table pair by (syncId, sourceDataFolderId = referencedDataFolderId).
      expect(syncTablePairFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { syncId: SYNC_ID, sourceDataFolderId: SOURCE_REFERENCED_FOLDER } }),
      );
    });
  });

  // An unknown destination connection is its own outcome, distinct from "maps nowhere".
  it('reports destination_connection_unresolved when the sync has no table pair for the referenced folder', () => {
    const db = {
      client: {
        syncTablePair: { findFirst: jest.fn().mockResolvedValue(null) },
        syncRemoteIdMapping: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { sourceRemoteId: 'src_1', destinationFilePath: 'Authors/alice.json', destinationRemoteId: null },
            ]),
        },
      },
    } as unknown as DbService;

    const lookupTools = createLookupTools(db, SYNC_ID, WORKBOOK_ID, Service.AIRTABLE, Service.WEBFLOW, () =>
      Promise.resolve(),
    );

    return lookupTools.getDestinationMappingForSourceFk('src_1', SOURCE_REFERENCED_FOLDER).then((resolution) => {
      expect(resolution.kind).toBe('destination_connection_unresolved');
      if (resolution.kind === 'destination_connection_unresolved') {
        expect(resolution.reason).toContain(SOURCE_REFERENCED_FOLDER);
      }
    });
  });

  it('reports destination_connection_unresolved when the destination folder has no connection', () => {
    const db = {
      client: {
        syncTablePair: {
          findFirst: jest.fn().mockResolvedValue({
            destinationDataFolderId: 'dfd_dest_authors',
            destinationDataFolder: { name: 'Authors', connectorAccount: null },
          }),
        },
        syncRemoteIdMapping: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { sourceRemoteId: 'src_1', destinationFilePath: 'Authors/alice.json', destinationRemoteId: null },
            ]),
        },
      },
    } as unknown as DbService;

    const lookupTools = createLookupTools(db, SYNC_ID, WORKBOOK_ID, Service.AIRTABLE, Service.WEBFLOW, () =>
      Promise.resolve(),
    );

    return lookupTools.getDestinationMappingForSourceFk('src_1', SOURCE_REFERENCED_FOLDER).then((resolution) => {
      expect(resolution.kind).toBe('destination_connection_unresolved');
      if (resolution.kind === 'destination_connection_unresolved') {
        expect(resolution.reason).toContain('Authors');
        expect(resolution.reason).toContain('not attached to a connection');
      }
    });
  });

  // A source FK that maps NOWHERE keeps reporting `no_destination_record` even when the
  // folder's connection is unknown, so `onUnresolved: 'ignore'` still skips it as before.
  it('still reports no_destination_record for an FK with no destination row, connection unknown or not', () => {
    const db = {
      client: {
        syncTablePair: { findFirst: jest.fn().mockResolvedValue(null) },
        syncRemoteIdMapping: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { sourceRemoteId: 'src_1', destinationFilePath: 'Authors/alice.json', destinationRemoteId: null },
            ]),
        },
      },
    } as unknown as DbService;

    const lookupTools = createLookupTools(db, SYNC_ID, WORKBOOK_ID, Service.AIRTABLE, Service.WEBFLOW, () =>
      Promise.resolve(),
    );

    return lookupTools
      .getDestinationMappingForSourceFk('src_never_mapped', SOURCE_REFERENCED_FOLDER)
      .then((resolution) => {
        expect(resolution).toEqual({ kind: 'no_destination_record' });
      });
  });
});

/**
 * Non-id foreign-key resolution (DEV-11085) — `resolveForeignKeyValueToTargetRemoteId` maps a
 * reference VALUE to the target's source remote id before the destination lookup runs.
 */
describe('createLookupTools.resolveForeignKeyValueToTargetRemoteId (DEV-11085)', () => {
  const EMPTY_DB = { client: {} } as unknown as DbService;

  const FRAMER_TAGS = [
    { id: 'item_aaa', fields: { id: 'item_aaa', slug: 'engineering' } },
    { id: 'item_bbb', fields: { id: 'item_bbb', slug: 'design' } },
  ];

  /** A paged reader that delivers the given pages in order, one onRecordPage call per page. */
  const pagedReaderOf = (...pages: { id: string; fields: unknown }[][]) =>
    jest.fn((_folderId: DataFolderId, onRecordPage: (recordPage: { id: string; fields: unknown }[]) => void) => {
      for (const page of pages) {
        onRecordPage(page);
      }
      return Promise.resolve();
    });

  it('is the identity function — and reads NO records — when no key path is declared', async () => {
    const readReferencedFolderRecordPages = pagedReaderOf(FRAMER_TAGS);
    const lookupTools = createLookupTools(
      EMPTY_DB,
      SYNC_ID,
      WORKBOOK_ID,
      Service.AIRTABLE,
      Service.WEBFLOW,
      readReferencedFolderRecordPages,
    );

    await expect(
      lookupTools.resolveForeignKeyValueToTargetRemoteId('rec_1', SOURCE_REFERENCED_FOLDER),
    ).resolves.toEqual({ kind: 'resolved', targetSourceRemoteId: 'rec_1' });
    // Every connector whose references carry ids must pay nothing for this feature.
    expect(readReferencedFolderRecordPages).not.toHaveBeenCalled();
  });

  it("resolves a declared key against the referenced folder's records", async () => {
    const lookupTools = createLookupTools(
      EMPTY_DB,
      SYNC_ID,
      WORKBOOK_ID,
      Service.AIRTABLE,
      Service.WEBFLOW,
      pagedReaderOf(FRAMER_TAGS),
    );

    await expect(
      lookupTools.resolveForeignKeyValueToTargetRemoteId('design', SOURCE_REFERENCED_FOLDER, 'slug'),
    ).resolves.toEqual({ kind: 'resolved', targetSourceRemoteId: 'item_bbb' });
  });

  it('folds records delivered across multiple pages into one index', async () => {
    // One record per page — the index must accumulate across onRecordPage calls.
    const lookupTools = createLookupTools(
      EMPTY_DB,
      SYNC_ID,
      WORKBOOK_ID,
      Service.AIRTABLE,
      Service.WEBFLOW,
      pagedReaderOf([FRAMER_TAGS[0]], [FRAMER_TAGS[1]]),
    );

    await expect(
      lookupTools.resolveForeignKeyValueToTargetRemoteId('engineering', SOURCE_REFERENCED_FOLDER, 'slug'),
    ).resolves.toEqual({ kind: 'resolved', targetSourceRemoteId: 'item_aaa' });
    await expect(
      lookupTools.resolveForeignKeyValueToTargetRemoteId('design', SOURCE_REFERENCED_FOLDER, 'slug'),
    ).resolves.toEqual({ kind: 'resolved', targetSourceRemoteId: 'item_bbb' });
  });

  it('reads the referenced folder ONCE however many values are resolved', async () => {
    const readReferencedFolderRecordPages = pagedReaderOf(FRAMER_TAGS);
    const lookupTools = createLookupTools(
      EMPTY_DB,
      SYNC_ID,
      WORKBOOK_ID,
      Service.AIRTABLE,
      Service.WEBFLOW,
      readReferencedFolderRecordPages,
    );

    // Concurrent, so this also pins that the PROMISE is cached, not just the settled result.
    await Promise.all([
      lookupTools.resolveForeignKeyValueToTargetRemoteId('engineering', SOURCE_REFERENCED_FOLDER, 'slug'),
      lookupTools.resolveForeignKeyValueToTargetRemoteId('design', SOURCE_REFERENCED_FOLDER, 'slug'),
      lookupTools.resolveForeignKeyValueToTargetRemoteId('engineering', SOURCE_REFERENCED_FOLDER, 'slug'),
    ]);
    expect(readReferencedFolderRecordPages).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate index per key path, so one does not answer for another', async () => {
    const readReferencedFolderRecordPages = pagedReaderOf([{ id: 'r1', fields: { slug: 'a', code: 'b' } }]);
    const lookupTools = createLookupTools(
      EMPTY_DB,
      SYNC_ID,
      WORKBOOK_ID,
      Service.AIRTABLE,
      Service.WEBFLOW,
      readReferencedFolderRecordPages,
    );

    await expect(
      lookupTools.resolveForeignKeyValueToTargetRemoteId('a', SOURCE_REFERENCED_FOLDER, 'slug'),
    ).resolves.toEqual({ kind: 'resolved', targetSourceRemoteId: 'r1' });
    // Same folder, different key: must NOT be served the slug index.
    await expect(
      lookupTools.resolveForeignKeyValueToTargetRemoteId('a', SOURCE_REFERENCED_FOLDER, 'code'),
    ).resolves.toEqual({ kind: 'no_match' });
    expect(readReferencedFolderRecordPages).toHaveBeenCalledTimes(2);
  });

  it('surfaces an ambiguous key instead of picking a claimant', async () => {
    const lookupTools = createLookupTools(
      EMPTY_DB,
      SYNC_ID,
      WORKBOOK_ID,
      Service.AIRTABLE,
      Service.WEBFLOW,
      pagedReaderOf([
        { id: 'r1', fields: { slug: 'dup' } },
        { id: 'r2', fields: { slug: 'dup' } },
      ]),
    );

    await expect(
      lookupTools.resolveForeignKeyValueToTargetRemoteId('dup', SOURCE_REFERENCED_FOLDER, 'slug'),
    ).resolves.toEqual({ kind: 'ambiguous', matchCount: 2 });
  });

  it('surfaces an ambiguous key when its claimants arrive in different pages', async () => {
    const lookupTools = createLookupTools(
      EMPTY_DB,
      SYNC_ID,
      WORKBOOK_ID,
      Service.AIRTABLE,
      Service.WEBFLOW,
      pagedReaderOf([{ id: 'r1', fields: { slug: 'dup' } }], [{ id: 'r2', fields: { slug: 'dup' } }]),
    );

    await expect(
      lookupTools.resolveForeignKeyValueToTargetRemoteId('dup', SOURCE_REFERENCED_FOLDER, 'slug'),
    ).resolves.toEqual({ kind: 'ambiguous', matchCount: 2 });
  });
});
