import type { ConnectorSettingDefinition, TablePreview } from '@spinner/shared-types';

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
