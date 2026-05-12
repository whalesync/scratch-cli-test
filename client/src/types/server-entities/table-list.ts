import { ConnectorSettingDefinition, EntityId, TableDiscoveryMode } from '@spinner/shared-types';

export interface TablePreview {
  id: EntityId;
  displayName: string;
  disabled?: boolean;
  disabledCreates?: boolean;
  disabledUpdates?: boolean;
  disabledDeletes?: boolean;
  /** Slash-separated path for grouping tables in the UI (e.g. "My Project/public") */
  parentPath?: string;
  /** Human-readable reason why this table is disabled or has writes disabled */
  disabledReason?: string;
  metadata?: Record<string, unknown>;
}

export interface TableList {
  tables: TablePreview[];
  discoveryMode: TableDiscoveryMode;
  supportsFilters: boolean;
  supportsFieldSelection: boolean;
  advancedSettings: ConnectorSettingDefinition[];
}

export interface TableSearchResult {
  tables: TablePreview[];
  hasMore: boolean;
}

export interface TableSchemaPreview {
  id: EntityId;
  slug: string;
  name: string;
  schema: Record<string, unknown>;
  idColumnRemoteId: string;
  titleColumnRemoteId?: string[];
  mainContentColumnRemoteId?: string[];
  slugFieldPath?: string;
  /** @deprecated Use slugFieldPath */
  slugColumnRemoteId?: string;
}

// A table is read-only at the connector level when it disables creates, updates,
// and deletes. In that case the UI forces the per-folder readOnly option ON.
export function isTableFullyLocked(table: TablePreview | undefined): boolean {
  return Boolean(table?.disabledCreates && table?.disabledUpdates && table?.disabledDeletes);
}
