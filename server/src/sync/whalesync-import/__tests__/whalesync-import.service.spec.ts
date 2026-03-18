import type { DataFolder, DataFolderId, Service } from '@spinner/shared-types';
import { Service as ServiceConst } from 'src/remote-service/connectors/service-constants';
import { convertWhalesyncExport } from '../whalesync-import.service';
import {
  buildSchemasMap,
  makeAirtableSchema,
  makeAnnotatedAirtableSchema,
  makeAnnotatedWebflowSchema,
  makeDataFolder,
  makeWebflowSchema,
  makeWhalesyncColumn,
  makeWhalesyncColumnPair,
  makeWhalesyncExport,
  makeWhalesyncSource,
  makeWhalesyncTable,
  makeWhalesyncTablePair,
  resetIdCounter,
} from './fixtures';

beforeEach(() => {
  resetIdCounter();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a left-Airtable / right-Webflow scenario with column pairs. */
function buildAirtableToWebflowScenario(opts?: { syncDirection?: 'left' | 'right' | 'both' }) {
  const direction = opts?.syncDirection ?? 'right';

  const leftCol = makeWhalesyncColumn({ name: 'Title' });
  const rightCol = makeWhalesyncColumn({ name: 'name', connectorType: 'webflow' });

  const leftTable = makeWhalesyncTable({
    remoteId: 'tblPROD',
    connectorType: 'airtable',
    columns: [leftCol],
  });
  const rightTable = makeWhalesyncTable({
    remoteId: 'col111',
    connectorType: 'webflow',
    columns: [rightCol],
  });

  const wsExport = makeWhalesyncExport({
    sources: {
      left: makeWhalesyncSource({
        connectorType: 'airtable',
        remoteBaseId: 'appAAA',
        tables: [leftTable],
      }),
      right: makeWhalesyncSource({
        connectorType: 'webflow',
        remoteBaseId: 'site111',
        tables: [rightTable],
      }),
    },
    tablePairs: [
      makeWhalesyncTablePair({
        leftTableId: leftTable.id,
        rightTableId: rightTable.id,
        syncDirection: direction,
        columnPairs: [
          makeWhalesyncColumnPair({
            leftColumnId: leftCol.id,
            rightColumnId: rightCol.id,
            syncDirection: direction,
          }),
        ],
      }),
    ],
  });

  const leftFolder = makeDataFolder({
    connectorService: ServiceConst.AIRTABLE,
    tableId: ['appAAA', 'tblPROD'],
  });

  const rightFolder = makeDataFolder({
    connectorService: ServiceConst.WEBFLOW,
    tableId: ['site111', 'col111'],
  });

  const schemas = buildSchemasMap(
    [leftFolder, makeAirtableSchema(['Title', 'Price'])],
    [rightFolder, makeWebflowSchema(['name', 'slug'])],
  );

  return { wsExport, leftFolder, rightFolder, schemas, leftTable, rightTable, leftCol, rightCol };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('convertWhalesyncExport', () => {
  describe('one-way left→right', () => {
    it('produces one SaveSyncBody with correct source/dest mapping', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildAirtableToWebflowScenario({
        syncDirection: 'right',
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      expect(result.syncs).toHaveLength(1);
      expect(result.unmatchedFolders).toHaveLength(0);

      const sync = result.syncs[0];
      expect(sync.displayName).toContain('Left \u2192 Right');
      expect(sync.validateMappings).toBe(false);
      expect(sync.mappings.version).toBe(1);
      expect(sync.mappings.tableMappings).toHaveLength(1);

      const tm = sync.mappings.tableMappings[0];
      expect(tm.sourceDataFolderId).toBe(leftFolder.id);
      expect(tm.destinationDataFolderId).toBe(rightFolder.id);
    });
  });

  describe('one-way right→left', () => {
    it('swaps source and destination', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildAirtableToWebflowScenario({
        syncDirection: 'left',
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      expect(result.syncs).toHaveLength(1);

      const sync = result.syncs[0];
      expect(sync.displayName).toContain('Right \u2192 Left');

      const tm = sync.mappings.tableMappings[0];
      expect(tm.sourceDataFolderId).toBe(rightFolder.id);
      expect(tm.destinationDataFolderId).toBe(leftFolder.id);
    });
  });

  describe('bidirectional', () => {
    it('produces two SaveSyncBody entries', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildAirtableToWebflowScenario({
        syncDirection: 'both',
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      expect(result.syncs).toHaveLength(2);
      expect(result.syncs[0].displayName).toContain('Left \u2192 Right');
      expect(result.syncs[1].displayName).toContain('Right \u2192 Left');

      // Left→Right sync has left as source
      expect(result.syncs[0].mappings.tableMappings[0].sourceDataFolderId).toBe(leftFolder.id);
      expect(result.syncs[0].mappings.tableMappings[0].destinationDataFolderId).toBe(rightFolder.id);

      // Right→Left sync has right as source
      expect(result.syncs[1].mappings.tableMappings[0].sourceDataFolderId).toBe(rightFolder.id);
      expect(result.syncs[1].mappings.tableMappings[0].destinationDataFolderId).toBe(leftFolder.id);
    });

    it('adds a bidirectional split caveat', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildAirtableToWebflowScenario({
        syncDirection: 'both',
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const biCaveat = result.caveats.find((c) => c.message.includes('Bidirectional'));
      expect(biCaveat).toBeDefined();
      expect(biCaveat!.severity).toBe('warning');
    });
  });

  describe('mixed directions', () => {
    it('distributes table pairs to the correct direction syncs', () => {
      const leftCol1 = makeWhalesyncColumn({ name: 'Title' });
      const rightCol1 = makeWhalesyncColumn({ name: 'name', connectorType: 'webflow' });
      const leftCol2 = makeWhalesyncColumn({ name: 'Status' });
      const rightCol2 = makeWhalesyncColumn({ name: 'status', connectorType: 'webflow' });

      const leftTable1 = makeWhalesyncTable({ remoteId: 'tblA', columns: [leftCol1] });
      const leftTable2 = makeWhalesyncTable({ remoteId: 'tblB', columns: [leftCol2] });
      const rightTable1 = makeWhalesyncTable({ remoteId: 'colA', connectorType: 'webflow', columns: [rightCol1] });
      const rightTable2 = makeWhalesyncTable({ remoteId: 'colB', connectorType: 'webflow', columns: [rightCol2] });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'airtable',
            remoteBaseId: 'appAAA',
            tables: [leftTable1, leftTable2],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable1, rightTable2],
          }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable1.id,
            rightTableId: rightTable1.id,
            syncDirection: 'right',
            columnPairs: [
              makeWhalesyncColumnPair({
                leftColumnId: leftCol1.id,
                rightColumnId: rightCol1.id,
                syncDirection: 'right',
              }),
            ],
          }),
          makeWhalesyncTablePair({
            leftTableId: leftTable2.id,
            rightTableId: rightTable2.id,
            syncDirection: 'left',
            columnPairs: [
              makeWhalesyncColumnPair({
                leftColumnId: leftCol2.id,
                rightColumnId: rightCol2.id,
                syncDirection: 'left',
              }),
            ],
          }),
        ],
      });

      const folder1 = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblA'],
      });
      const folder2 = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblB'],
      });
      const folder3 = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'colA'],
      });
      const folder4 = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'colB'],
      });
      const folders: DataFolder[] = [folder1, folder2, folder3, folder4];
      const schemas = buildSchemasMap(
        [folder1, makeAirtableSchema(['Title'])],
        [folder2, makeAirtableSchema(['Status'])],
        [folder3, makeWebflowSchema(['name'])],
        [folder4, makeWebflowSchema(['status'])],
      );

      const result = convertWhalesyncExport(folders, wsExport, schemas);

      expect(result.syncs).toHaveLength(2);
      // Left→Right sync: only table pair 1
      expect(result.syncs[0].mappings.tableMappings).toHaveLength(1);
      // Right→Left sync: only table pair 2
      expect(result.syncs[1].mappings.tableMappings).toHaveLength(1);
    });
  });

  describe('unmatched table', () => {
    it('adds to unmatchedFolders when DataFolder is missing', () => {
      const leftTable = makeWhalesyncTable({ remoteId: 'tblPROD' });
      const rightTable = makeWhalesyncTable({ remoteId: 'col111', connectorType: 'webflow' });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'airtable',
            remoteBaseId: 'appAAA',
            tables: [leftTable],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable],
          }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'right',
          }),
        ],
      });

      // Only provide left folder — right is missing
      const leftFolder = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });

      const result = convertWhalesyncExport([leftFolder], wsExport);

      expect(result.unmatchedFolders).toHaveLength(1);
      expect(result.unmatchedFolders[0].side).toBe('right');
      expect(result.unmatchedFolders[0].whalesyncTableName).toBe(rightTable.name);
      expect(result.unmatchedFolders[0].remoteTableId).toBe('col111');

      // Table pair is skipped since right table is unmatched
      expect(result.syncs).toHaveLength(0);
    });
  });

  describe('unsupported connector', () => {
    it('adds error caveat and skips tables for unsupported connectors', () => {
      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'hubspot',
            remoteBaseId: 'hub123',
            displayName: 'My HubSpot',
            tables: [makeWhalesyncTable({ connectorType: 'hubspot' })],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [makeWhalesyncTable({ connectorType: 'webflow', remoteId: 'col111' })],
          }),
        },
      });

      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });

      const result = convertWhalesyncExport([rightFolder], wsExport);

      const errorCaveat = result.caveats.find((c) => c.severity === 'error');
      expect(errorCaveat).toBeDefined();
      expect(errorCaveat!.message).toContain('hubspot');
    });
  });

  describe('caveats', () => {
    it('flags delete behavior "sync" as warning', () => {
      const { wsExport, leftFolder, rightFolder, schemas, leftTable, rightTable, leftCol, rightCol } =
        buildAirtableToWebflowScenario();

      wsExport.tablePairs = [
        makeWhalesyncTablePair({
          leftTableId: leftTable.id,
          rightTableId: rightTable.id,
          syncDirection: 'right',
          leftDeleteBehavior: 'sync',
          columnPairs: [
            makeWhalesyncColumnPair({ leftColumnId: leftCol.id, rightColumnId: rightCol.id, syncDirection: 'right' }),
          ],
        }),
      ];

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const deleteCaveat = result.caveats.find((c) => c.message.includes('Delete syncing'));
      expect(deleteCaveat).toBeDefined();
      expect(deleteCaveat!.severity).toBe('warning');
    });

    it('flags filters as warning', () => {
      const { wsExport, leftFolder, rightFolder, schemas, leftTable, rightTable, leftCol, rightCol } =
        buildAirtableToWebflowScenario();

      wsExport.tablePairs = [
        makeWhalesyncTablePair({
          leftTableId: leftTable.id,
          rightTableId: rightTable.id,
          syncDirection: 'right',
          filter: {
            type: 'group',
            id: 'filter-1',
            logicalOperator: 'AND',
            conditions: [],
          },
          columnPairs: [
            makeWhalesyncColumnPair({ leftColumnId: leftCol.id, rightColumnId: rightCol.id, syncDirection: 'right' }),
          ],
        }),
      ];

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const filterCaveat = result.caveats.find((c) => c.message.includes('Filter'));
      expect(filterCaveat).toBeDefined();
      expect(filterCaveat!.severity).toBe('warning');
    });

    it('flags invalid syncDirection as warning', () => {
      const { wsExport, leftFolder, rightFolder, schemas, leftTable, rightTable } = buildAirtableToWebflowScenario();

      wsExport.tablePairs = [
        makeWhalesyncTablePair({
          leftTableId: leftTable.id,
          rightTableId: rightTable.id,
          syncDirection: 'invalid',
        }),
      ];

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const invalidCaveat = result.caveats.find((c) => c.message.includes('invalid sync direction'));
      expect(invalidCaveat).toBeDefined();
      expect(invalidCaveat!.severity).toBe('warning');
    });

    it('flags non-empty transforms as warning', () => {
      const { wsExport, leftFolder, rightFolder, schemas, leftTable, rightTable, leftCol, rightCol } =
        buildAirtableToWebflowScenario();

      wsExport.tablePairs = [
        makeWhalesyncTablePair({
          leftTableId: leftTable.id,
          rightTableId: rightTable.id,
          syncDirection: 'right',
          columnPairs: [
            makeWhalesyncColumnPair({
              leftColumnId: leftCol.id,
              rightColumnId: rightCol.id,
              syncDirection: 'right',
              transforms: {
                leftToCoreTransforms: ['UPPERCASE'],
                leftToExternalTransforms: [],
                rightToCoreTransforms: [],
                rightToExternalTransforms: [],
              },
            }),
          ],
        }),
      ];

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const transformCaveat = result.caveats.find((c) => c.message.includes('transforms'));
      expect(transformCaveat).toBeDefined();
      expect(transformCaveat!.severity).toBe('warning');
    });

    it('flags read-only destination table as info', () => {
      const leftCol = makeWhalesyncColumn({ name: 'Title' });
      const rightCol = makeWhalesyncColumn({ name: 'name', connectorType: 'webflow' });
      const leftTable = makeWhalesyncTable({ remoteId: 'tblPROD', columns: [leftCol] });
      const rightTable = makeWhalesyncTable({
        remoteId: 'col111',
        connectorType: 'webflow',
        supportsWrite: false,
        columns: [rightCol],
      });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'airtable',
            remoteBaseId: 'appAAA',
            tables: [leftTable],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable],
          }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'right',
            columnPairs: [
              makeWhalesyncColumnPair({ leftColumnId: leftCol.id, rightColumnId: rightCol.id, syncDirection: 'right' }),
            ],
          }),
        ],
      });

      const leftFolder = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });
      const schemas = buildSchemasMap(
        [leftFolder, makeAirtableSchema(['Title'])],
        [rightFolder, makeWebflowSchema(['name'])],
      );

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const readOnlyCaveat = result.caveats.find((c) => c.message.includes('read-only'));
      expect(readOnlyCaveat).toBeDefined();
      expect(readOnlyCaveat!.severity).toBe('info');
    });
  });

  describe('column matching', () => {
    it('matches columns by last path segment name', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildAirtableToWebflowScenario({
        syncDirection: 'right',
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const tm = result.syncs[0].mappings.tableMappings[0];
      expect(tm.columnMappings).toHaveLength(1);
      expect(tm.columnMappings[0].sourceColumnId).toBe('fields.Title');
      expect(tm.columnMappings[0].destinationColumnId).toBe('fieldData.name');
    });

    it('correctly splits column directions for bidirectional', () => {
      const leftCol1 = makeWhalesyncColumn({ name: 'Title' });
      const leftCol2 = makeWhalesyncColumn({ name: 'Price' });
      const rightCol1 = makeWhalesyncColumn({ name: 'name', connectorType: 'webflow' });
      const rightCol2 = makeWhalesyncColumn({ name: 'slug', connectorType: 'webflow' });

      const leftTable = makeWhalesyncTable({
        remoteId: 'tblPROD',
        connectorType: 'airtable',
        columns: [leftCol1, leftCol2],
      });
      const rightTable = makeWhalesyncTable({
        remoteId: 'col111',
        connectorType: 'webflow',
        columns: [rightCol1, rightCol2],
      });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'airtable',
            remoteBaseId: 'appAAA',
            tables: [leftTable],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable],
          }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'both',
            columnPairs: [
              // Title→name goes left only
              makeWhalesyncColumnPair({
                leftColumnId: leftCol1.id,
                rightColumnId: rightCol1.id,
                syncDirection: 'right',
              }),
              // Price→slug goes both ways
              makeWhalesyncColumnPair({
                leftColumnId: leftCol2.id,
                rightColumnId: rightCol2.id,
                syncDirection: 'both',
              }),
            ],
          }),
        ],
      });

      const leftFolder = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });
      const schemas = buildSchemasMap(
        [leftFolder, makeAirtableSchema(['Title', 'Price'])],
        [rightFolder, makeWebflowSchema(['name', 'slug'])],
      );

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      expect(result.syncs).toHaveLength(2);

      // Left→Right: Title→name (left) + Price→slug (both) = 2 columns
      expect(result.syncs[0].mappings.tableMappings[0].columnMappings).toHaveLength(2);

      // Right→Left: only Price→slug (both) = 1 column
      expect(result.syncs[1].mappings.tableMappings[0].columnMappings).toHaveLength(1);
      expect(result.syncs[1].mappings.tableMappings[0].columnMappings[0].sourceColumnId).toBe('fieldData.slug');
    });
  });

  describe('unmatched column', () => {
    it('skips unmatched columns and adds warning caveat', () => {
      const leftCol = makeWhalesyncColumn({ name: 'NonExistent' });
      const rightCol = makeWhalesyncColumn({ name: 'name', connectorType: 'webflow' });

      const leftTable = makeWhalesyncTable({
        remoteId: 'tblPROD',
        connectorType: 'airtable',
        columns: [leftCol],
      });
      const rightTable = makeWhalesyncTable({
        remoteId: 'col111',
        connectorType: 'webflow',
        columns: [rightCol],
      });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'airtable',
            remoteBaseId: 'appAAA',
            tables: [leftTable],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable],
          }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'right',
            columnPairs: [
              makeWhalesyncColumnPair({
                leftColumnId: leftCol.id,
                rightColumnId: rightCol.id,
                syncDirection: 'right',
              }),
            ],
          }),
        ],
      });

      const leftFolder = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });
      const schemas = buildSchemasMap(
        [leftFolder, makeAirtableSchema(['Title', 'Price'])], // No "NonExistent"
        [rightFolder, makeWebflowSchema(['name'])],
      );

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      // Column skipped
      expect(result.syncs[0].mappings.tableMappings[0].columnMappings).toHaveLength(0);

      // Warning generated
      const colCaveat = result.caveats.find((c) => c.message.includes('NonExistent'));
      expect(colCaveat).toBeDefined();
      expect(colCaveat!.severity).toBe('warning');
    });
  });

  describe('empty export', () => {
    it('handles export with no sources', () => {
      const wsExport = makeWhalesyncExport({
        sources: { left: null, right: null },
        tablePairs: [],
        sync: { id: 'ws-sync-1', name: 'Empty', syncState: 'PAUSED' },
      });

      const result = convertWhalesyncExport([], wsExport);

      expect(result.syncs).toHaveLength(0);
      expect(result.caveats).toHaveLength(0);
      expect(result.unmatchedFolders).toHaveLength(0);
    });

    it('handles one null source gracefully', () => {
      const rightTable = makeWhalesyncTable({ remoteId: 'col111', connectorType: 'webflow' });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: null,
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable],
          }),
        },
        tablePairs: [],
      });

      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });

      const result = convertWhalesyncExport([rightFolder], wsExport);

      expect(result.syncs).toHaveLength(0);
      expect(result.unmatchedFolders).toHaveLength(0);
    });
  });

  describe('first-match DataFolder deduplication', () => {
    it('uses the first DataFolder when multiple match the same key', () => {
      const {
        wsExport,
        rightFolder,
        schemas: baseSchemas,
      } = buildAirtableToWebflowScenario({
        syncDirection: 'right',
      });

      const firstFolder = makeDataFolder({
        id: 'dfd_first00001' as DataFolderId,
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const secondFolder = makeDataFolder({
        id: 'dfd_second0001' as DataFolderId,
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const schemas = new Map([
        ...baseSchemas,
        ...buildSchemasMap([firstFolder, makeAirtableSchema(['Title'])], [secondFolder, makeAirtableSchema(['Title'])]),
      ]);

      const result = convertWhalesyncExport([firstFolder, secondFolder, rightFolder], wsExport, schemas);

      expect(result.syncs).toHaveLength(1);
      expect(result.syncs[0].mappings.tableMappings[0].sourceDataFolderId).toBe('dfd_first00001');
    });

    it('skips DataFolders with null connectorService or empty tableId', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildAirtableToWebflowScenario({
        syncDirection: 'right',
      });

      const badFolder1 = makeDataFolder({ connectorService: null, tableId: ['appAAA', 'tblPROD'] });
      const badFolder2 = makeDataFolder({ connectorService: ServiceConst.AIRTABLE, tableId: [] });

      // Bad folders come first but should be skipped; real folders should be used
      const result = convertWhalesyncExport([badFolder1, badFolder2, leftFolder, rightFolder], wsExport, schemas);

      expect(result.syncs).toHaveLength(1);
      expect(result.syncs[0].mappings.tableMappings[0].sourceDataFolderId).toBe(leftFolder.id);
    });
  });

  describe('null schema', () => {
    it('returns empty column mappings when source schema is null', () => {
      const { wsExport, rightFolder, schemas } = buildAirtableToWebflowScenario({ syncDirection: 'right' });

      // Override leftFolder without schema in the map
      const leftFolder = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      // Only rightFolder has a schema — leftFolder has none
      const overriddenSchemas = new Map([...schemas].filter(([key]) => key !== leftFolder.id));

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, overriddenSchemas);

      expect(result.syncs).toHaveLength(1);
      expect(result.syncs[0].mappings.tableMappings[0].columnMappings).toHaveLength(0);
    });

    it('returns empty column mappings when destination schema is null', () => {
      const { wsExport, leftFolder, schemas } = buildAirtableToWebflowScenario({ syncDirection: 'right' });

      // Override rightFolder without schema in the map
      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });
      // Only leftFolder has a schema — rightFolder has none
      const overriddenSchemas = new Map([...schemas].filter(([key]) => key !== rightFolder.id));

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, overriddenSchemas);

      expect(result.syncs).toHaveLength(1);
      expect(result.syncs[0].mappings.tableMappings[0].columnMappings).toHaveLength(0);
    });
  });

  describe('column matching edge cases', () => {
    it('is case-sensitive when matching column names', () => {
      // Whalesync column name is "title" (lowercase) but schema has "Title" (capitalized)
      const leftCol = makeWhalesyncColumn({ name: 'title' });
      const rightCol = makeWhalesyncColumn({ name: 'name', connectorType: 'webflow' });

      const leftTable = makeWhalesyncTable({
        remoteId: 'tblPROD',
        connectorType: 'airtable',
        columns: [leftCol],
      });
      const rightTable = makeWhalesyncTable({
        remoteId: 'col111',
        connectorType: 'webflow',
        columns: [rightCol],
      });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'airtable',
            remoteBaseId: 'appAAA',
            tables: [leftTable],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable],
          }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'right',
            columnPairs: [
              makeWhalesyncColumnPair({
                leftColumnId: leftCol.id,
                rightColumnId: rightCol.id,
                syncDirection: 'right',
              }),
            ],
          }),
        ],
      });

      const leftFolder = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });
      const schemas = buildSchemasMap(
        [leftFolder, makeAirtableSchema(['Title'])], // Capital T — does NOT match "title"
        [rightFolder, makeWebflowSchema(['name'])],
      );

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      // "title" does not match "Title" — column is skipped
      expect(result.syncs[0].mappings.tableMappings[0].columnMappings).toHaveLength(0);

      const caveat = result.caveats.find((c) => c.message.includes('"title"'));
      expect(caveat).toBeDefined();
    });

    it('warns when destination column cannot be matched', () => {
      const leftCol = makeWhalesyncColumn({ name: 'Title' });
      const rightCol = makeWhalesyncColumn({ name: 'nonexistent_field', connectorType: 'webflow' });

      const leftTable = makeWhalesyncTable({
        remoteId: 'tblPROD',
        connectorType: 'airtable',
        columns: [leftCol],
      });
      const rightTable = makeWhalesyncTable({
        remoteId: 'col111',
        connectorType: 'webflow',
        columns: [rightCol],
      });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'airtable',
            remoteBaseId: 'appAAA',
            tables: [leftTable],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable],
          }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'right',
            columnPairs: [
              makeWhalesyncColumnPair({
                leftColumnId: leftCol.id,
                rightColumnId: rightCol.id,
                syncDirection: 'right',
              }),
            ],
          }),
        ],
      });

      const leftFolder = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });
      const schemas = buildSchemasMap(
        [leftFolder, makeAirtableSchema(['Title'])],
        [rightFolder, makeWebflowSchema(['name', 'slug'])], // No "nonexistent_field"
      );

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      expect(result.syncs[0].mappings.tableMappings[0].columnMappings).toHaveLength(0);

      const destCaveat = result.caveats.find((c) => c.message.includes('Destination column'));
      expect(destCaveat).toBeDefined();
      expect(destCaveat!.severity).toBe('warning');
      expect(destCaveat!.message).toContain('nonexistent_field');
    });

    it('handles right-only column in bidirectional table pair', () => {
      const leftCol = makeWhalesyncColumn({ name: 'Title' });
      const rightCol = makeWhalesyncColumn({ name: 'name', connectorType: 'webflow' });

      const leftTable = makeWhalesyncTable({
        remoteId: 'tblPROD',
        connectorType: 'airtable',
        columns: [leftCol],
      });
      const rightTable = makeWhalesyncTable({
        remoteId: 'col111',
        connectorType: 'webflow',
        columns: [rightCol],
      });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'airtable',
            remoteBaseId: 'appAAA',
            tables: [leftTable],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable],
          }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'both',
            columnPairs: [
              // Column is right-only — should only appear in right→left sync
              makeWhalesyncColumnPair({
                leftColumnId: leftCol.id,
                rightColumnId: rightCol.id,
                syncDirection: 'left',
              }),
            ],
          }),
        ],
      });

      const leftFolder = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });
      const schemas = buildSchemasMap(
        [leftFolder, makeAirtableSchema(['Title'])],
        [rightFolder, makeWebflowSchema(['name'])],
      );

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      expect(result.syncs).toHaveLength(2);

      // Left→Right sync: no columns (column is right-only)
      expect(result.syncs[0].mappings.tableMappings[0].columnMappings).toHaveLength(0);

      // Right→Left sync: 1 column
      expect(result.syncs[1].mappings.tableMappings[0].columnMappings).toHaveLength(1);
      expect(result.syncs[1].mappings.tableMappings[0].columnMappings[0].sourceColumnId).toBe('fieldData.name');
      expect(result.syncs[1].mappings.tableMappings[0].columnMappings[0].destinationColumnId).toBe('fields.Title');
    });

    it('maps multiple columns correctly in a single table pair', () => {
      const leftCol1 = makeWhalesyncColumn({ name: 'Title' });
      const leftCol2 = makeWhalesyncColumn({ name: 'Price' });
      const rightCol1 = makeWhalesyncColumn({ name: 'name', connectorType: 'webflow' });
      const rightCol2 = makeWhalesyncColumn({ name: 'slug', connectorType: 'webflow' });

      const leftTable = makeWhalesyncTable({
        remoteId: 'tblPROD',
        connectorType: 'airtable',
        columns: [leftCol1, leftCol2],
      });
      const rightTable = makeWhalesyncTable({
        remoteId: 'col111',
        connectorType: 'webflow',
        columns: [rightCol1, rightCol2],
      });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({
            connectorType: 'airtable',
            remoteBaseId: 'appAAA',
            tables: [leftTable],
          }),
          right: makeWhalesyncSource({
            connectorType: 'webflow',
            remoteBaseId: 'site111',
            tables: [rightTable],
          }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'right',
            columnPairs: [
              makeWhalesyncColumnPair({
                leftColumnId: leftCol1.id,
                rightColumnId: rightCol1.id,
                syncDirection: 'right',
              }),
              makeWhalesyncColumnPair({
                leftColumnId: leftCol2.id,
                rightColumnId: rightCol2.id,
                syncDirection: 'right',
              }),
            ],
          }),
        ],
      });

      const leftFolder = makeDataFolder({
        connectorService: ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const rightFolder = makeDataFolder({
        connectorService: ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });
      const schemas = buildSchemasMap(
        [leftFolder, makeAirtableSchema(['Title', 'Price'])],
        [rightFolder, makeWebflowSchema(['name', 'slug'])],
      );

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const mappings = result.syncs[0].mappings.tableMappings[0].columnMappings;
      expect(mappings).toHaveLength(2);
      expect(mappings[0]).toEqual({ sourceColumnId: 'fields.Title', destinationColumnId: 'fieldData.name' });
      expect(mappings[1]).toEqual({ sourceColumnId: 'fields.Price', destinationColumnId: 'fieldData.slug' });
    });
  });

  describe('displayName format', () => {
    it('includes the Whalesync sync name and direction', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildAirtableToWebflowScenario({
        syncDirection: 'right',
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      expect(result.syncs[0].displayName).toBe('My Whalesync Sync (Left \u2192 Right)');
    });
  });

  describe('sync-level caveats', () => {
    it('flags active (continuous) sync as info caveat', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildAirtableToWebflowScenario();

      // Default fixture has syncState: 'ACTIVE'
      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const continuousCaveat = result.caveats.find((c) => c.message.includes('Continuous'));
      expect(continuousCaveat).toBeDefined();
      expect(continuousCaveat!.severity).toBe('info');
    });

    it('does not flag paused sync', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildAirtableToWebflowScenario();
      wsExport.sync.syncState = 'PAUSED';

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const continuousCaveat = result.caveats.find((c) => c.message.includes('Continuous'));
      expect(continuousCaveat).toBeUndefined();
    });

    it('flags first-run merge winner preference as info caveat', () => {
      const { wsExport, leftFolder, rightFolder, schemas, leftTable, rightTable, leftCol, rightCol } =
        buildAirtableToWebflowScenario();

      wsExport.tablePairs = [
        makeWhalesyncTablePair({
          leftTableId: leftTable.id,
          rightTableId: rightTable.id,
          syncDirection: 'right',
          columnPairs: [
            makeWhalesyncColumnPair({
              leftColumnId: leftCol.id,
              rightColumnId: rightCol.id,
              syncDirection: 'right',
              initializeOnMergeWinner: 'left',
            }),
          ],
        }),
      ];

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const mergeCaveat = result.caveats.find((c) => c.message.includes('merge winner'));
      expect(mergeCaveat).toBeDefined();
      expect(mergeCaveat!.severity).toBe('info');
      expect(mergeCaveat!.context).toContain('left');
    });

    it('does not flag initializeOnMergeWinner "either"', () => {
      const { wsExport, leftFolder, rightFolder, schemas, leftTable, rightTable, leftCol, rightCol } =
        buildAirtableToWebflowScenario();

      wsExport.sync.syncState = 'PAUSED';
      wsExport.tablePairs = [
        makeWhalesyncTablePair({
          leftTableId: leftTable.id,
          rightTableId: rightTable.id,
          syncDirection: 'right',
          columnPairs: [
            makeWhalesyncColumnPair({
              leftColumnId: leftCol.id,
              rightColumnId: rightCol.id,
              syncDirection: 'right',
              initializeOnMergeWinner: 'either',
            }),
          ],
        }),
      ];

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const mergeCaveat = result.caveats.find((c) => c.message.includes('merge winner'));
      expect(mergeCaveat).toBeUndefined();
    });
  });

  describe('column matching cascade', () => {
    /** Helper to build a one-way left→right scenario with custom schemas and columns. */
    function buildCascadeScenario(opts: {
      leftCol: { name: string; remoteId: string };
      rightCol: { name: string; remoteId: string };
      leftSchema: Record<string, unknown>;
      rightSchema: Record<string, unknown>;
      leftService?: Service;
      rightService?: Service;
    }) {
      const leftCol = makeWhalesyncColumn({ name: opts.leftCol.name, remoteId: opts.leftCol.remoteId });
      const rightCol = makeWhalesyncColumn({
        name: opts.rightCol.name,
        remoteId: opts.rightCol.remoteId,
        connectorType: 'webflow',
      });

      const leftTable = makeWhalesyncTable({ remoteId: 'tblPROD', columns: [leftCol] });
      const rightTable = makeWhalesyncTable({ remoteId: 'col111', connectorType: 'webflow', columns: [rightCol] });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({ connectorType: 'airtable', remoteBaseId: 'appAAA', tables: [leftTable] }),
          right: makeWhalesyncSource({ connectorType: 'webflow', remoteBaseId: 'site111', tables: [rightTable] }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'right',
            columnPairs: [
              makeWhalesyncColumnPair({ leftColumnId: leftCol.id, rightColumnId: rightCol.id, syncDirection: 'right' }),
            ],
          }),
        ],
      });

      const leftFolder = makeDataFolder({
        connectorService: opts.leftService ?? ServiceConst.AIRTABLE,
        tableId: ['appAAA', 'tblPROD'],
      });
      const rightFolder = makeDataFolder({
        connectorService: opts.rightService ?? ServiceConst.WEBFLOW,
        tableId: ['site111', 'col111'],
      });
      const schemas = buildSchemasMap([leftFolder, opts.leftSchema], [rightFolder, opts.rightSchema]);

      return { wsExport, leftFolder, rightFolder, schemas };
    }

    it('matches by remote field ID even when names differ', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildCascadeScenario({
        leftCol: { name: 'Renamed Title', remoteId: 'fldABC' },
        rightCol: { name: 'Renamed Name', remoteId: 'wf_abc123' },
        leftSchema: makeAnnotatedAirtableSchema([{ name: 'Title', remoteFieldId: 'fldABC' }]),
        rightSchema: makeAnnotatedWebflowSchema([{ name: 'name', remoteFieldId: 'wf_abc123' }]),
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const mappings = result.syncs[0].mappings.tableMappings[0].columnMappings;
      expect(mappings).toHaveLength(1);
      expect(mappings[0].sourceColumnId).toBe('fields.Title');
      expect(mappings[0].destinationColumnId).toBe('fieldData.name');
    });

    it('falls back to slug when no remote field ID annotation exists', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildCascadeScenario({
        leftCol: { name: 'Title', remoteId: 'fldABC' },
        rightCol: { name: 'name', remoteId: 'wf_abc123' },
        // Plain schemas without annotations — slug matching only
        leftSchema: makeAirtableSchema(['Title']),
        rightSchema: makeWebflowSchema(['name']),
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const mappings = result.syncs[0].mappings.tableMappings[0].columnMappings;
      expect(mappings).toHaveLength(1);
      expect(mappings[0].sourceColumnId).toBe('fields.Title');
      expect(mappings[0].destinationColumnId).toBe('fieldData.name');
    });

    it('falls back to description when slug does not match', () => {
      // Webflow case: WS column name is "Adoption Price", schema key is "adoption-price"
      // Slug match fails, but description "Adoption Price" matches
      const { wsExport, leftFolder, rightFolder, schemas } = buildCascadeScenario({
        leftCol: { name: 'Adoption Price', remoteId: 'fldABC' },
        rightCol: { name: 'Adoption Price', remoteId: 'nomatch' },
        leftSchema: makeAnnotatedAirtableSchema([{ name: 'Adoption Price', remoteFieldId: 'fldABC' }]),
        rightSchema: makeAnnotatedWebflowSchema([{ name: 'adoption-price', description: 'Adoption Price' }]),
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const mappings = result.syncs[0].mappings.tableMappings[0].columnMappings;
      expect(mappings).toHaveLength(1);
      expect(mappings[0].sourceColumnId).toBe('fields.Adoption Price');
      expect(mappings[0].destinationColumnId).toBe('fieldData.adoption-price');
    });

    it('prefers remote ID over slug match', () => {
      // WS column name is "FieldA" and remoteId is "fldB"
      // Schema has FieldA (remoteId fldA) and FieldB (remoteId fldB)
      // Should match FieldB by remote ID, not FieldA by name
      const { wsExport, leftFolder, rightFolder, schemas } = buildCascadeScenario({
        leftCol: { name: 'FieldA', remoteId: 'fldB' },
        rightCol: { name: 'name', remoteId: 'wf_name' },
        leftSchema: makeAnnotatedAirtableSchema([
          { name: 'FieldA', remoteFieldId: 'fldA' },
          { name: 'FieldB', remoteFieldId: 'fldB' },
        ]),
        rightSchema: makeAnnotatedWebflowSchema([{ name: 'name', remoteFieldId: 'wf_name' }]),
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const mappings = result.syncs[0].mappings.tableMappings[0].columnMappings;
      expect(mappings).toHaveLength(1);
      // Matched FieldB by remote ID, not FieldA by name
      expect(mappings[0].sourceColumnId).toBe('fields.FieldB');
    });

    it('skips column with caveat when no cascade level matches', () => {
      const { wsExport, leftFolder, rightFolder, schemas } = buildCascadeScenario({
        leftCol: { name: 'NoMatch', remoteId: 'fldNOPE' },
        rightCol: { name: 'name', remoteId: 'wf_name' },
        leftSchema: makeAnnotatedAirtableSchema([{ name: 'Title', remoteFieldId: 'fldTITLE', description: 'Title' }]),
        rightSchema: makeAnnotatedWebflowSchema([{ name: 'name', remoteFieldId: 'wf_name' }]),
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      expect(result.syncs[0].mappings.tableMappings[0].columnMappings).toHaveLength(0);

      const caveat = result.caveats.find((c) => c.message.includes('NoMatch'));
      expect(caveat).toBeDefined();
      expect(caveat!.severity).toBe('warning');
    });

    it('matches both sides independently through different cascade levels', () => {
      // Source matches by remote ID, destination matches by description
      const { wsExport, leftFolder, rightFolder, schemas } = buildCascadeScenario({
        leftCol: { name: 'Old Name', remoteId: 'fldABC' },
        rightCol: { name: 'Adoption Price', remoteId: 'nomatch' },
        leftSchema: makeAnnotatedAirtableSchema([{ name: 'Title', remoteFieldId: 'fldABC' }]),
        rightSchema: makeAnnotatedWebflowSchema([{ name: 'adoption-price', description: 'Adoption Price' }]),
      });

      const result = convertWhalesyncExport([leftFolder, rightFolder], wsExport, schemas);

      const mappings = result.syncs[0].mappings.tableMappings[0].columnMappings;
      expect(mappings).toHaveLength(1);
      expect(mappings[0].sourceColumnId).toBe('fields.Title');
      expect(mappings[0].destinationColumnId).toBe('fieldData.adoption-price');
    });
  });
});
