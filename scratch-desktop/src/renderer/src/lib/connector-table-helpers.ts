import type { TablePreview } from '@spinner/shared-types';

/**
 * A table whose creates, updates, AND deletes are all disabled by the connector — i.e. fully
 * read-only. Pure view helper (no HTTP), kept app-local; it previously lived alongside the desktop
 * `connectorAccountsApi`, which has since moved to the shared client.
 */
export function isTableFullyLocked(table: TablePreview | undefined): boolean {
  return Boolean(table?.disabledCreates && table?.disabledUpdates && table?.disabledDeletes);
}
