import type {
  DataFolder,
  DataFolderId,
  WhalesyncExportColumn,
  WhalesyncExportColumnPair,
  WhalesyncExportSource,
  WhalesyncExportTable,
  WhalesyncExportTablePair,
  WhalesyncSyncDirection,
  WhalesyncSyncExport,
  WorkbookId,
} from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${String(++idCounter).padStart(4, '0')}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

// ---------------------------------------------------------------------------
// Whalesync Export Factories
// ---------------------------------------------------------------------------

export function makeWhalesyncExport(overrides?: Partial<WhalesyncSyncExport>): WhalesyncSyncExport {
  return {
    version: 1,
    exportedAt: '2025-01-01T00:00:00Z',
    sync: {
      id: 'ws-sync-1',
      name: 'My Whalesync Sync',
      syncState: 'ACTIVE',
    },
    sources: {
      left: makeWhalesyncSource({ connectorType: 'airtable', remoteBaseId: 'appAAA' }),
      right: makeWhalesyncSource({ connectorType: 'webflow', remoteBaseId: 'site111' }),
    },
    tablePairs: [],
    ...overrides,
  };
}

export function makeWhalesyncSource(overrides?: Partial<WhalesyncExportSource>): WhalesyncExportSource {
  return {
    connectorType: 'airtable',
    displayName: 'My Airtable Base',
    browserUrl: null,
    remoteBaseId: 'appAAA',
    tables: [],
    ...overrides,
  };
}

export function makeWhalesyncTable(overrides?: Partial<WhalesyncExportTable>): WhalesyncExportTable {
  const id = nextId('wst');
  return {
    id,
    name: 'Products',
    remoteId: 'tblPROD',
    connectorType: 'airtable',
    supportsWrite: true,
    columns: [],
    ...overrides,
  };
}

export function makeWhalesyncColumn(overrides?: Partial<WhalesyncExportColumn>): WhalesyncExportColumn {
  const id = nextId('wsc');
  return {
    id,
    name: 'Title',
    remoteId: 'fldTITLE',
    connectorType: 'airtable',
    dataType: 'TEXT',
    typeMetadata: null,
    ...overrides,
  };
}

export function makeWhalesyncTablePair(overrides?: Partial<WhalesyncExportTablePair>): WhalesyncExportTablePair {
  return {
    leftTableId: '',
    rightTableId: '',
    syncDirection: 'right' as WhalesyncSyncDirection,
    leftDeleteBehavior: 'do_nothing',
    rightDeleteBehavior: 'do_nothing',
    leftSelectedConfigExtras: null,
    rightSelectedConfigExtras: null,
    filter: null,
    columnPairs: [],
    ...overrides,
  };
}

export function makeWhalesyncColumnPair(overrides?: Partial<WhalesyncExportColumnPair>): WhalesyncExportColumnPair {
  return {
    leftColumnId: '',
    rightColumnId: '',
    syncDirection: 'right' as WhalesyncSyncDirection,
    initializeOnMergeWinner: 'left',
    transforms: {
      leftToCoreTransforms: [],
      leftToExternalTransforms: [],
      rightToCoreTransforms: [],
      rightToExternalTransforms: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DataFolder / Schema Factories
// ---------------------------------------------------------------------------

/** Build a realistic Airtable-style JSON schema with named fields under "fields". */
export function makeAirtableSchema(fieldNames: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of fieldNames) {
    properties[name] = { type: 'string' };
  }
  return {
    type: 'object',
    properties: {
      fields: {
        type: 'object',
        properties,
      },
    },
  };
}

/** Build a realistic Webflow-style JSON schema with named fields under "fieldData". */
export function makeWebflowSchema(fieldNames: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of fieldNames) {
    properties[name] = { type: 'string' };
  }
  return {
    type: 'object',
    properties: {
      fieldData: {
        type: 'object',
        properties,
      },
    },
  };
}

interface SchemaFieldDef {
  name: string;
  remoteFieldId?: string;
  description?: string;
}

/** Build an Airtable-style schema with optional x-scratch-remote-field-id and description annotations. */
export function makeAnnotatedAirtableSchema(fields: SchemaFieldDef[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    const prop: Record<string, unknown> = { type: 'string' };
    if (f.remoteFieldId) prop['x-scratch-remote-field-id'] = f.remoteFieldId;
    if (f.description) prop.description = f.description;
    properties[f.name] = prop;
  }
  return {
    type: 'object',
    properties: {
      fields: { type: 'object', properties },
    },
  };
}

/** Build a Webflow-style schema with optional x-scratch-remote-field-id and description annotations. */
export function makeAnnotatedWebflowSchema(fields: SchemaFieldDef[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    const prop: Record<string, unknown> = { type: 'string' };
    if (f.remoteFieldId) prop['x-scratch-remote-field-id'] = f.remoteFieldId;
    if (f.description) prop.description = f.description;
    properties[f.name] = prop;
  }
  return {
    type: 'object',
    properties: {
      fieldData: { type: 'object', properties },
    },
  };
}

export function makeDataFolder(overrides?: Partial<DataFolder>): DataFolder {
  const id = nextId('dfd') as DataFolderId;
  return {
    id,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    name: 'Products',
    workbookId: 'wkb_test00001' as WorkbookId,
    connectorAccountId: null,
    connectorDisplayName: null,
    connectorService: Service.AIRTABLE,
    lastSchemaRefreshAt: null,
    parentId: null,
    path: '/products',
    lock: null,
    lastSyncTime: null,
    version: 1,
    tableId: ['appAAA', 'tblPROD'],
    isAssetTable: false,
    options: null,
    schedules: [],
    ...overrides,
  };
}

/** Build a schemas map from [folder, schema] pairs for use with convertWhalesyncExport. */
export function buildSchemasMap(
  ...pairs: [DataFolder, Record<string, unknown>][]
): Map<string, Record<string, unknown>> {
  return new Map(pairs.map(([folder, schema]) => [folder.id, schema]));
}
