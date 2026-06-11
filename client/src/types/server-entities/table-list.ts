import type { TablePreview } from '@spinner/shared-types';

// A table is read-only at the connector level when it disables creates, updates,
// and deletes. In that case the UI forces the per-folder readOnly option ON.
export function isTableFullyLocked(table: TablePreview | undefined): boolean {
  return Boolean(table?.disabledCreates && table?.disabledUpdates && table?.disabledDeletes);
}

// settingAppliesToTable lives in @spinner/shared-types so the web and desktop
// share one implementation; re-exported here to preserve existing import paths.
export { settingAppliesToTable } from '@spinner/shared-types';
