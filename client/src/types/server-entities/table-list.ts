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

// A connector setting applies to a table when it declares no `forTableWsIds`
// whitelist, or the table's wsId is in that whitelist. A scoped setting whose
// table wsId can't be resolved is hidden (we can't confirm it applies).
export function settingAppliesToTable(setting: ConnectorSettingDefinition, tableWsId: string | undefined): boolean {
  if (!setting.forTableWsIds || setting.forTableWsIds.length === 0) return true;
  if (!tableWsId) return false;
  return setting.forTableWsIds.includes(tableWsId);
}
