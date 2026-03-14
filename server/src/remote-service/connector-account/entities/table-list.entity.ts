import { ConnectorSettingDefinition, TableDiscoveryMode } from '@spinner/shared-types';
import { TablePreview } from '../../connectors/types';

export type TableList = {
  tables: TablePreview[];
  discoveryMode: TableDiscoveryMode;
  supportsFilters: boolean;
  supportsFieldSelection: boolean;
  advancedSettings: ConnectorSettingDefinition[];
};

export type TableSearchResult = {
  tables: TablePreview[];
  hasMore: boolean;
};
