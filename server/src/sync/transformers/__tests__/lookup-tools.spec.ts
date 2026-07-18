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

    const lookupTools = createLookupTools(db, SYNC_ID, WORKBOOK_ID, Service.AIRTABLE, Service.WEBFLOW);

    return lookupTools.getDestinationMappingForSourceFk('src_1', SOURCE_REFERENCED_FOLDER).then((mapping) => {
      expect(mapping).toEqual({
        destinationFilePath: 'Authors/alice.json',
        destinationRemoteId: null,
        // `Webflow: Marketing` → `:` is a filesystem-reserved char, sanitized to `-`.
        destinationConnectionFolder: 'Webflow- Marketing',
      });
      // Looked up the table pair by (syncId, sourceDataFolderId = referencedDataFolderId).
      expect(syncTablePairFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { syncId: SYNC_ID, sourceDataFolderId: SOURCE_REFERENCED_FOLDER } }),
      );
    });
  });

  it('falls back to a null connection folder when the destination connection is unknown', () => {
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

    const lookupTools = createLookupTools(db, SYNC_ID, WORKBOOK_ID, Service.AIRTABLE, Service.WEBFLOW);

    return lookupTools.getDestinationMappingForSourceFk('src_1', SOURCE_REFERENCED_FOLDER).then((mapping) => {
      expect(mapping?.destinationConnectionFolder).toBeNull();
    });
  });
});
