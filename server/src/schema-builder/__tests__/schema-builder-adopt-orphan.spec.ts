import { Type } from '@sinclair/typebox';
import { WorkbookId } from '@spinner/shared-types';
import { Actor } from 'src/users/types';
import { SchemaBuilderService } from '../schema-builder.service';

/**
 * Unit coverage for the adoption SAFETY RULE — the guard that decides whether materialize may
 * reuse an existing unmapped folder instead of creating a duplicate table. A wrong adoption binds
 * the sync to the wrong table (a bare name match once grabbed an unrelated Webflow table), so these
 * cases pin down exactly when adoption fires and, more importantly, when it declines.
 */
describe('SchemaBuilderService.findAdoptableOrphanFolder', () => {
  const WORKBOOK_ID = 'wkb_1' as WorkbookId;
  const ACTOR = { userId: 'u_1' } as unknown as Actor;
  const DESTINATION_CONNECTOR = 'coa_dest';
  const INTENDED_TABLE_NAME = 'Countries';
  const INTENDED_FIELD_NAMES = ['Slug', 'Country'];
  const INTENDED_PARENT = ['base1'];

  type FolderRow = { id: string; name: string; connectorAccountId: string; tableId: string[] };

  function buildService(opts: {
    folders: FolderRow[];
    mappedDestinationFolderIds?: string[];
    columnNamesByFolderId: Record<string, string[] | null>;
  }): SchemaBuilderService {
    const mappedDestinationFolderIds = new Set(opts.mappedDestinationFolderIds ?? []);
    const db = {
      client: {
        dataFolder: { findMany: jest.fn().mockResolvedValue(opts.folders) },
        syncTablePair: {
          findFirst: jest.fn((args: { where: { destinationDataFolderId: string } }) =>
            Promise.resolve(
              mappedDestinationFolderIds.has(args.where.destinationDataFolderId) ? { id: 'pair_1' } : null,
            ),
          ),
        },
      },
    };
    const dataFolderService = {
      // View absent → derivation falls back to raw schema flattening; the crafted schemas below are
      // flat top-level properties, so each property name IS the meaningful column name.
      getStoredView: jest.fn().mockResolvedValue(null),
      getStoredSchema: jest.fn((dataFolderId: string) => {
        const columnNames = opts.columnNamesByFolderId[dataFolderId];
        if (!columnNames) return Promise.resolve(null);
        const properties = Object.fromEntries(columnNames.map((name) => [name, Type.String()]));
        return Promise.resolve({ schema: Type.Object(properties) });
      }),
    };
    const constructorArgs = [
      undefined,
      undefined,
      undefined,
      dataFolderService,
      db,
      undefined,
    ] as unknown as ConstructorParameters<typeof SchemaBuilderService>;
    return new SchemaBuilderService(...constructorArgs);
  }

  const findOrphan = (service: SchemaBuilderService) =>
    service.findAdoptableOrphanFolder(
      WORKBOOK_ID,
      DESTINATION_CONNECTOR,
      INTENDED_PARENT,
      INTENDED_TABLE_NAME,
      INTENDED_FIELD_NAMES,
      ACTOR,
    );

  it('adopts an unmapped folder whose columns exactly match the table to create', async () => {
    const service = buildService({
      folders: [
        {
          id: 'dfd_orphan',
          name: 'Countries',
          connectorAccountId: DESTINATION_CONNECTOR,
          tableId: ['base1', 'tbl_orphan'],
        },
      ],
      columnNamesByFolderId: { dfd_orphan: ['Slug', 'Country'] },
    });
    expect(await findOrphan(service)).toEqual({
      dataFolderId: 'dfd_orphan',
      remoteTableId: ['base1', 'tbl_orphan'],
      actualName: 'Countries',
    });
  });

  it('declines a same-named folder with an extra column (a foreign table, not our orphan)', async () => {
    const service = buildService({
      folders: [
        {
          id: 'dfd_webflow',
          name: 'Countries',
          connectorAccountId: DESTINATION_CONNECTOR,
          tableId: ['base1', 'tbl_wf'],
        },
      ],
      // The Webflow "Countries" table: our columns PLUS its own — not a subset, so it is not ours.
      columnNamesByFolderId: { dfd_webflow: ['Slug', 'Country', 'webflow_record_id'] },
    });
    expect(await findOrphan(service)).toBeNull();
  });

  it('declines a partial orphan that is missing a column', async () => {
    const service = buildService({
      folders: [
        {
          id: 'dfd_partial',
          name: 'Countries',
          connectorAccountId: DESTINATION_CONNECTOR,
          tableId: ['base1', 'tbl_p'],
        },
      ],
      columnNamesByFolderId: { dfd_partial: ['Slug'] },
    });
    expect(await findOrphan(service)).toBeNull();
  });

  it('declines a folder already mapped as a destination in a live sync', async () => {
    const service = buildService({
      folders: [
        { id: 'dfd_mapped', name: 'Countries', connectorAccountId: DESTINATION_CONNECTOR, tableId: ['base1', 'tbl_m'] },
      ],
      mappedDestinationFolderIds: ['dfd_mapped'],
      columnNamesByFolderId: { dfd_mapped: ['Slug', 'Country'] },
    });
    expect(await findOrphan(service)).toBeNull();
  });

  it('declines when two folders both match — never guesses', async () => {
    const service = buildService({
      folders: [
        { id: 'dfd_a', name: 'Countries', connectorAccountId: DESTINATION_CONNECTOR, tableId: ['base1', 'tbl_a'] },
        { id: 'dfd_b', name: 'Countries', connectorAccountId: DESTINATION_CONNECTOR, tableId: ['base1', 'tbl_b'] },
      ],
      columnNamesByFolderId: { dfd_a: ['Slug', 'Country'], dfd_b: ['Slug', 'Country'] },
    });
    expect(await findOrphan(service)).toBeNull();
  });

  it('declines a same-named, same-column folder under a different parent (base)', async () => {
    const service = buildService({
      folders: [
        {
          id: 'dfd_otherbase',
          name: 'Countries',
          connectorAccountId: DESTINATION_CONNECTOR,
          tableId: ['base2', 'tbl_x'],
        },
      ],
      columnNamesByFolderId: { dfd_otherbase: ['Slug', 'Country'] },
    });
    expect(await findOrphan(service)).toBeNull();
  });

  it('declines when no folder name matches the table to create', async () => {
    const service = buildService({
      folders: [
        { id: 'dfd_other', name: 'Regions', connectorAccountId: DESTINATION_CONNECTOR, tableId: ['base1', 'tbl_r'] },
      ],
      columnNamesByFolderId: { dfd_other: ['Slug', 'Country'] },
    });
    expect(await findOrphan(service)).toBeNull();
  });
});
