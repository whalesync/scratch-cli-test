/**
 * Types describing the JSON export from Whalesync's bottlenose API.
 * Used as input to the Scratch import/conversion service.
 *
 * Source: GET /rest/core-bases/:id/export (bottlenose)
 * See: spinner/docs/whalesync-to-scratch-migration.md
 */

// ── Whalesync Export Types ──

export type WhalesyncSyncExport = {
  version: 1;
  exportedAt: string;
  sync: {
    id: string;
    name: string;
    syncState: string;
  };
  sources: {
    left: WhalesyncExportSource | null;
    right: WhalesyncExportSource | null;
  };
  tablePairs: WhalesyncExportTablePair[];
};

export type WhalesyncExportSource = {
  connectorType: string;
  displayName: string;
  browserUrl: string | null;
  remoteBaseId: string;
  tables: WhalesyncExportTable[];
};

export type WhalesyncExportTable = {
  id: string;
  name: string;
  remoteId: string;
  connectorType: string;
  supportsWrite: boolean;
  columns: WhalesyncExportColumn[];
};

export type WhalesyncExportColumn = {
  id: string;
  name: string;
  remoteId: string;
  connectorType: string;
  dataType: string;
  typeMetadata: unknown;
};

export type WhalesyncExportTablePair = {
  leftTableId: string;
  rightTableId: string;
  syncDirection: WhalesyncSyncDirection;
  leftDeleteBehavior: WhalesyncDeleteBehavior;
  rightDeleteBehavior: WhalesyncDeleteBehavior;
  leftSelectedConfigExtras: Record<string, unknown> | null;
  rightSelectedConfigExtras: Record<string, unknown> | null;
  filter: WhalesyncFilterConditionGroup | null;
  columnPairs: WhalesyncExportColumnPair[];
};

export type WhalesyncExportColumnPair = {
  leftColumnId: string;
  rightColumnId: string;
  syncDirection: WhalesyncSyncDirection;
  initializeOnMergeWinner: 'left' | 'right' | 'either';
  transforms: {
    leftToCoreTransforms: string[];
    leftToExternalTransforms: string[];
    rightToCoreTransforms: string[];
    rightToExternalTransforms: string[];
  };
};

// ── Supporting Types ──

export type WhalesyncSyncDirection = 'left' | 'right' | 'both' | 'invalid';

export type WhalesyncDeleteBehavior = 'sync' | 'do_nothing';

export type WhalesyncFilterConditionGroup = {
  readonly type: 'group';
  id: string;
  logicalOperator: 'AND' | 'OR';
  conditions: (WhalesyncFilterCondition | WhalesyncFilterConditionGroup)[];
};

export type WhalesyncFilterCondition = {
  readonly type: 'condition';
  id: string;
  columnMappingId: string;
  operator: string;
  value: unknown;
};

// ── Connector Type Mapping ──

/** Maps Whalesync connector types to Scratch Service enum values. */
export const WHALESYNC_TO_SCRATCH_SERVICE: Record<string, string | null> = {
  airtable: 'AIRTABLE',
  webflow: 'WEBFLOW',
  notion: 'NOTION',
  postgres: 'POSTGRES',
  'supabase-oauth': 'SUPABASE',
  wordpressorg: 'WORDPRESS',
  // Not yet supported in Scratch
  hubspot: null,
  salesforce: null,
  stripe: null,
  affinity: null,
  memberstack: null,
  iapp_apollo: null,
  iapp_attio: null,
  iapp_sheets: null,
};
