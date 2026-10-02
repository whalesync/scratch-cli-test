import { Type } from '@sinclair/typebox';
import { WorkbookId } from '@spinner/shared-types';
import { Connector } from 'src/remote-service/connectors/connector';
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
    /** A stored view per folder whose column display names differ from the column names (Postgres). */
    displayNamesByColumnNameByFolderId?: Record<string, Record<string, string>>;
    /** The destination connector; defaults to one with no parent fold (parents prefix-match tableIds). */
    destinationConnector?: Partial<Connector>;
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
      getStoredView: jest.fn((dataFolderId: string) => {
        const displayNamesByColumnName = opts.displayNamesByColumnNameByFolderId?.[dataFolderId];
        if (!displayNamesByColumnName) return Promise.resolve(null);
        return Promise.resolve({
          name: 'Default',
          cols: Object.entries(displayNamesByColumnName).map(([path, name]) => ({ kind: 'col', path, name })),
        });
      }),
      getStoredSchema: jest.fn((dataFolderId: string) => {
        const columnNames = opts.columnNamesByFolderId[dataFolderId];
        if (!columnNames) return Promise.resolve(null);
        const properties = Object.fromEntries(columnNames.map((name) => [name, Type.String()]));
        return Promise.resolve({ schema: Type.Object(properties) });
      }),
    };
    const connectorAccountService = {
      findOneByIdUnscoped: jest.fn().mockResolvedValue({ id: DESTINATION_CONNECTOR, workbookId: WORKBOOK_ID }),
    };
    const connectorService = { getConnector: jest.fn().mockResolvedValue(opts.destinationConnector ?? {}) };
    const constructorArgs = [
      undefined,
      connectorAccountService,
      connectorService,
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

  // DEV-11903: a same-type-system plan (Supabase → Postgres) names fields by their source COLUMN names, while
  // the Postgres orphan's default view shows humanized display names — the orphan must still be recognized.
  it('adopts an orphan whose column names (not its view display names) match a same-type-system plan', async () => {
    const service = buildService({
      folders: [
        {
          id: 'dfd_orphan',
          name: 'Countries',
          connectorAccountId: DESTINATION_CONNECTOR,
          tableId: ['base1', 'countries'],
        },
      ],
      columnNamesByFolderId: { dfd_orphan: ['slug', 'country_code'] },
      displayNamesByColumnNameByFolderId: { dfd_orphan: { slug: 'Slug', country_code: 'Country Code' } },
    });
    const adopted = await service.findAdoptableOrphanFolder(
      WORKBOOK_ID,
      DESTINATION_CONNECTOR,
      INTENDED_PARENT,
      INTENDED_TABLE_NAME,
      ['slug', 'country_code'],
      ACTOR,
    );
    expect(adopted?.dataFolderId).toBe('dfd_orphan');
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

  // Live Export addresses a Supabase parent as the create-destination id whole (`["ref/public"]`), which no
  // tableId prefix-matches; the connector's fold is what places the orphan under it.
  describe('a parent given as the whole create-destination id', () => {
    const supabaseLikeDestination: Partial<Connector> = {
      createDestinationIdForParent: (remoteParentId: string[]) => {
        const segments = remoteParentId.flatMap((segment) => segment.split('/'));
        return segments[0] ? `${segments[0]}/${segments[1] ?? 'public'}` : undefined;
      },
    };
    const findOrphanUnder = (service: SchemaBuilderService, remoteParentId: string[]) =>
      service.findAdoptableOrphanFolder(
        WORKBOOK_ID,
        DESTINATION_CONNECTOR,
        remoteParentId,
        INTENDED_TABLE_NAME,
        INTENDED_FIELD_NAMES,
        ACTOR,
      );

    it('adopts an orphan in the same project and schema', async () => {
      const service = buildService({
        folders: [
          {
            id: 'dfd_orphan',
            name: 'Countries',
            connectorAccountId: DESTINATION_CONNECTOR,
            tableId: ['ref', 'public', 'countries'],
          },
        ],
        columnNamesByFolderId: { dfd_orphan: ['Slug', 'Country'] },
        destinationConnector: supabaseLikeDestination,
      });
      expect((await findOrphanUnder(service, ['ref/public']))?.dataFolderId).toBe('dfd_orphan');
    });

    it('declines an orphan in another schema', async () => {
      const service = buildService({
        folders: [
          {
            id: 'dfd_orphan',
            name: 'Countries',
            connectorAccountId: DESTINATION_CONNECTOR,
            tableId: ['ref', 'staging', 'countries'],
          },
        ],
        columnNamesByFolderId: { dfd_orphan: ['Slug', 'Country'] },
        destinationConnector: supabaseLikeDestination,
      });
      expect(await findOrphanUnder(service, ['ref/public'])).toBeNull();
    });
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
