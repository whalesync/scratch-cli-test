import type {
  ColumnMapping,
  DataFolder,
  SaveSyncBody,
  TableMapping,
  WhalesyncExportColumn,
  WhalesyncExportColumnPair,
  WhalesyncExportSource,
  WhalesyncExportTable,
  WhalesyncExportTablePair,
  WhalesyncSyncExport,
} from '@spinner/shared-types';
import { WHALESYNC_TO_SCRATCH_SERVICE } from '@spinner/shared-types';
import { extractSchemaFields, type SchemaField } from 'src/utils/schema-helpers';
import type { Caveat, UnmatchedFolder, WhalesyncImportResult } from './whalesync-import.types';

type Side = 'left' | 'right';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Resolved mapping from a Whalesync table ID to its Scratch DataFolder. */
interface ResolvedTable {
  whalesyncTable: WhalesyncExportTable;
  dataFolder: DataFolder;
  side: Side;
}

/**
 * Converts a Whalesync export into Scratch SaveSyncBody[] with caveats.
 *
 * Pure function — no database access. Receives DataFolders as input so it's easy to unit test.
 */
export function convertWhalesyncExport(
  dataFolders: DataFolder[],
  wsExport: WhalesyncSyncExport,
): WhalesyncImportResult {
  const caveats: Caveat[] = [];
  const unmatchedFolders: UnmatchedFolder[] = [];

  // A. Build DataFolder lookup map: "${connectorService}:${tableId.join(',')}" → DataFolder
  const folderLookup = buildFolderLookup(dataFolders);

  // B. Resolve tables for each side
  const resolvedTables = new Map<string, ResolvedTable>();

  for (const side of ['left', 'right'] as const) {
    const source = wsExport.sources[side];
    if (!source) continue;

    resolveTables(source, side, folderLookup, resolvedTables, caveats, unmatchedFolders);
  }

  // Generate top-level caveats
  generateSyncLevelCaveats(wsExport, caveats);

  // C–E. Build SaveSyncBody[] from table pairs
  const syncs = buildSyncs(wsExport, resolvedTables, caveats);

  return { syncs, caveats, unmatchedFolders };
}

/** A. Build a lookup map from "${Service}:${tableId}" to the first matching DataFolder. */
function buildFolderLookup(dataFolders: DataFolder[]): Map<string, DataFolder> {
  const lookup = new Map<string, DataFolder>();
  for (const folder of dataFolders) {
    if (!folder.connectorService || folder.tableId.length === 0) continue;
    const key = `${folder.connectorService}:${folder.tableId.join(',')}`;
    // First-match: only store if not already present
    if (!lookup.has(key)) {
      lookup.set(key, folder);
    }
  }
  return lookup;
}

/** B. Resolve Whalesync tables to Scratch DataFolders for one side of the sync. */
function resolveTables(
  source: WhalesyncExportSource,
  side: Side,
  folderLookup: Map<string, DataFolder>,
  resolvedTables: Map<string, ResolvedTable>,
  caveats: Caveat[],
  unmatchedFolders: UnmatchedFolder[],
): void {
  const scratchService = WHALESYNC_TO_SCRATCH_SERVICE[source.connectorType];

  if (scratchService === null || scratchService === undefined) {
    caveats.push({
      severity: 'error',
      message: `Unsupported connector type: ${source.connectorType}`,
      context: `${side} source "${source.displayName}" uses connector "${source.connectorType}" which is not yet supported in Scratch.`,
    });
    return;
  }

  for (const table of source.tables) {
    const lookupKey = `${scratchService}:${source.remoteBaseId},${table.remoteId}`;
    const dataFolder = folderLookup.get(lookupKey);

    if (dataFolder) {
      resolvedTables.set(table.id, { whalesyncTable: table, dataFolder, side });
    } else {
      unmatchedFolders.push({
        whalesyncTableName: table.name,
        connectorType: source.connectorType,
        remoteBaseId: source.remoteBaseId,
        remoteTableId: table.remoteId,
        side,
        message: `No matching DataFolder found for ${source.connectorType} table "${table.name}" (${lookupKey})`,
      });
    }
  }
}

/** C. Build SaveSyncBody[] — one per direction that has table pairs. */
function buildSyncs(
  wsExport: WhalesyncSyncExport,
  resolvedTables: Map<string, ResolvedTable>,
  caveats: Caveat[],
): SaveSyncBody[] {
  // Collect table pairs per direction
  const leftToRight: WhalesyncExportTablePair[] = [];
  const rightToLeft: WhalesyncExportTablePair[] = [];
  let hasBidirectional = false;

  for (const pair of wsExport.tablePairs) {
    generateTablePairCaveats(pair, caveats);

    const leftResolved = resolvedTables.get(pair.leftTableId);
    const rightResolved = resolvedTables.get(pair.rightTableId);
    if (!leftResolved || !rightResolved) continue;

    switch (pair.syncDirection) {
      case 'left':
        leftToRight.push(pair);
        break;
      case 'right':
        rightToLeft.push(pair);
        break;
      case 'both':
        leftToRight.push(pair);
        rightToLeft.push(pair);
        hasBidirectional = true;
        break;
      case 'invalid':
        caveats.push({
          severity: 'warning',
          message: `Table pair has invalid sync direction and will be skipped`,
          context: `Left table: ${leftResolved.whalesyncTable.name}, Right table: ${rightResolved.whalesyncTable.name}`,
        });
        break;
    }
  }

  if (hasBidirectional) {
    caveats.push({
      severity: 'warning',
      message: 'Bidirectional sync has been split into two one-way syncs',
      context:
        'Scratch does not support bidirectional syncs. Each direction has been created as a separate sync that you can run independently.',
    });
  }

  const syncs: SaveSyncBody[] = [];

  if (leftToRight.length > 0) {
    syncs.push(buildOneSyncBody(wsExport, resolvedTables, leftToRight, 'left', caveats));
  }
  if (rightToLeft.length > 0) {
    syncs.push(buildOneSyncBody(wsExport, resolvedTables, rightToLeft, 'right', caveats));
  }

  return syncs;
}

/** Build a single SaveSyncBody for one direction. */
function buildOneSyncBody(
  wsExport: WhalesyncSyncExport,
  resolvedTables: Map<string, ResolvedTable>,
  pairs: WhalesyncExportTablePair[],
  sourceDirection: 'left' | 'right',
  caveats: Caveat[],
): SaveSyncBody {
  const directionLabel = sourceDirection === 'left' ? 'Left \u2192 Right' : 'Right \u2192 Left';

  const tableMappings: TableMapping[] = [];

  for (const pair of pairs) {
    const sourceTableId = sourceDirection === 'left' ? pair.leftTableId : pair.rightTableId;
    const destTableId = sourceDirection === 'left' ? pair.rightTableId : pair.leftTableId;

    const sourceResolved = resolvedTables.get(sourceTableId);
    const destResolved = resolvedTables.get(destTableId);
    if (!sourceResolved || !destResolved) continue;

    // Check read-only destination
    const destTable = destResolved.whalesyncTable;
    if (!destTable.supportsWrite) {
      caveats.push({
        severity: 'info',
        message: `Destination table "${destTable.name}" is read-only in Whalesync`,
        context: 'This table may not support writes. Verify before running the sync.',
      });
    }

    const columnMappings = resolveColumnMappings(pair, sourceDirection, sourceResolved, destResolved, caveats);

    tableMappings.push({
      sourceDataFolderId: sourceResolved.dataFolder.id,
      destinationDataFolderId: destResolved.dataFolder.id,
      columnMappings,
    });
  }

  return {
    displayName: `${wsExport.sync.name} (${directionLabel})`,
    validateMappings: false,
    mappings: {
      version: 1,
      tableMappings,
    },
  };
}

/** D. Resolve column mappings for a table pair in the given direction. */
function resolveColumnMappings(
  pair: WhalesyncExportTablePair,
  sourceDirection: 'left' | 'right',
  sourceResolved: ResolvedTable,
  destResolved: ResolvedTable,
  caveats: Caveat[],
): ColumnMapping[] {
  const sourceSchema = sourceResolved.dataFolder.schema;
  const destSchema = destResolved.dataFolder.schema;

  if (!sourceSchema || !destSchema) return [];

  const sourceFields = extractSchemaFields(sourceSchema as Parameters<typeof extractSchemaFields>[0]);
  const destFields = extractSchemaFields(destSchema as Parameters<typeof extractSchemaFields>[0]);

  const sourceFieldLookup = buildFieldLookup(sourceFields);
  const destFieldLookup = buildFieldLookup(destFields);

  const columnMappings: ColumnMapping[] = [];

  for (const colPair of pair.columnPairs) {
    // Filter by direction: include columns that match sourceDirection or 'both'
    if (!columnPairMatchesDirection(colPair, sourceDirection)) continue;

    // Generate column-level caveats
    generateColumnPairCaveats(colPair, sourceResolved, destResolved, caveats);

    // Resolve source and destination column IDs
    const sourceColId = sourceDirection === 'left' ? colPair.leftColumnId : colPair.rightColumnId;
    const destColId = sourceDirection === 'left' ? colPair.rightColumnId : colPair.leftColumnId;

    const sourceTable = sourceResolved.whalesyncTable;
    const destTable = destResolved.whalesyncTable;

    const sourceWsCol = sourceTable.columns.find((c) => c.id === sourceColId);
    const destWsCol = destTable.columns.find((c) => c.id === destColId);

    if (!sourceWsCol || !destWsCol) continue;

    // Silently skip synthesized columns with no Scratch equivalent (e.g. syntheticStatus)
    if (isUnmappableSynthesizedColumn(sourceWsCol) || isUnmappableSynthesizedColumn(destWsCol)) continue;

    const sourcePath = resolveFieldPath(sourceWsCol, sourceFieldLookup);
    const destPath = resolveFieldPath(destWsCol, destFieldLookup);

    if (!sourcePath) {
      caveats.push({
        severity: 'warning',
        message: `Source column "${sourceWsCol.name}" could not be matched to a Scratch schema field`,
        context: `${capitalize(sourceTable.connectorType)} table "${sourceTable.name}" — column will be skipped`,
      });
      continue;
    }

    if (!destPath) {
      caveats.push({
        severity: 'warning',
        message: `Destination column "${destWsCol.name}" could not be matched to a Scratch schema field`,
        context: `${capitalize(destTable.connectorType)} table "${destTable.name}" — column will be skipped`,
      });
      continue;
    }

    columnMappings.push({
      sourceColumnId: sourcePath,
      destinationColumnId: destPath,
    });
  }

  return columnMappings;
}

/** Check if a column pair applies to the given source direction. */
function columnPairMatchesDirection(colPair: WhalesyncExportColumnPair, sourceDirection: 'left' | 'right'): boolean {
  return colPair.syncDirection === 'both' || colPair.syncDirection === sourceDirection;
}

interface FieldLookup {
  byRemoteId: Map<string, string>;
  bySlug: Map<string, string>;
  byDescription: Map<string, string>;
}

/** Build lookups for matching Whalesync columns to schema fields by remote ID, slug, or description. */
function buildFieldLookup(fields: SchemaField[]): FieldLookup {
  const byRemoteId = new Map<string, string>();
  const bySlug = new Map<string, string>();
  const byDescription = new Map<string, string>();

  for (const field of fields) {
    if (field.remoteFieldId && !byRemoteId.has(field.remoteFieldId)) {
      byRemoteId.set(field.remoteFieldId, field.path);
    }

    const segments = field.path.split('.');
    const lastSegment = segments[segments.length - 1];
    if (!bySlug.has(lastSegment)) {
      bySlug.set(lastSegment, field.path);
    }

    if (field.description && !byDescription.has(field.description)) {
      byDescription.set(field.description, field.path);
    }
  }

  return { byRemoteId, bySlug, byDescription };
}

/** Synthesized columns with no Scratch equivalent (silently skipped). */
function isUnmappableSynthesizedColumn(col: WhalesyncExportColumn): boolean {
  return col.dataType.endsWith('/syntheticStatus');
}

/** Resolve a Whalesync column to a schema field path using cascading lookup: remote ID → slug → display name. */
function resolveFieldPath(wsCol: WhalesyncExportColumn, lookup: FieldLookup): string | undefined {
  // ws-synthesized/remoteRecordId maps to the record's `id` field
  if (wsCol.dataType === 'ws-synthesized/remoteRecordId') {
    return lookup.bySlug.get('id') ?? 'id';
  }
  return lookup.byRemoteId.get(wsCol.remoteId) ?? lookup.bySlug.get(wsCol.name) ?? lookup.byDescription.get(wsCol.name);
}

/** Generate sync-level caveats (continuous mode, etc.). */
function generateSyncLevelCaveats(wsExport: WhalesyncSyncExport, caveats: Caveat[]): void {
  if (wsExport.sync.syncState === 'ACTIVE') {
    caveats.push({
      severity: 'info',
      message: 'Continuous sync will become discrete',
      context:
        'Whalesync ran this sync continuously. Scratch syncs run on-demand or on a schedule. Set up a schedule after import if needed.',
    });
  }
}

/** E. Generate caveats for a table pair's configuration. */
function generateTablePairCaveats(pair: WhalesyncExportTablePair, caveats: Caveat[]): void {
  if (pair.leftDeleteBehavior === 'sync' || pair.rightDeleteBehavior === 'sync') {
    caveats.push({
      severity: 'warning',
      message: 'Delete syncing is not supported in Scratch',
      context:
        'Scratch does not propagate deletes. Records deleted in the source will not be deleted in the destination.',
    });
  }

  if (pair.filter) {
    caveats.push({
      severity: 'warning',
      message: 'Filters cannot be migrated to Scratch',
      context:
        'The Whalesync filter configuration has been dropped. You may need to re-create filtering logic manually.',
    });
  }
}

/** Generate caveats for column-pair-level settings. */
function generateColumnPairCaveats(
  colPair: WhalesyncExportColumnPair,
  sourceResolved: ResolvedTable,
  destResolved: ResolvedTable,
  caveats: Caveat[],
): void {
  const transforms = colPair.transforms;
  const hasTransforms =
    transforms.leftToCoreTransforms.length > 0 ||
    transforms.leftToExternalTransforms.length > 0 ||
    transforms.rightToCoreTransforms.length > 0 ||
    transforms.rightToExternalTransforms.length > 0;

  if (hasTransforms) {
    const sourceCol = sourceResolved.whalesyncTable.columns.find(
      (c) => c.id === colPair.leftColumnId || c.id === colPair.rightColumnId,
    );
    caveats.push({
      severity: 'warning',
      message: 'Column transforms cannot be automatically migrated',
      context: sourceCol
        ? `Column "${sourceCol.name}" has Whalesync transforms that must be recreated manually in Scratch.`
        : 'A column has Whalesync transforms that must be recreated manually in Scratch.',
    });
  }

  if (colPair.initializeOnMergeWinner !== 'either') {
    caveats.push({
      severity: 'info',
      message: 'First-run merge winner preference cannot be migrated',
      context: `Whalesync was configured to prefer "${colPair.initializeOnMergeWinner}" on first merge. Scratch does not have this concept.`,
    });
  }
}
