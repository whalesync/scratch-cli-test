import { ConnectorSettingDefinition, EntityId, TableDiscoveryMode } from '@spinner/shared-types';

export interface TablePreview {
  id: EntityId;
  displayName: string;
  disabled?: boolean;
  disabledCreates?: boolean;
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
  slugColumnRemoteId?: string;
}
