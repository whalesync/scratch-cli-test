import { isEqual } from 'lodash';
import { type ForeignKeyPathInSchema } from './ref-cleaner.service';

/**
 * Every `targetRemoteTableId` a FileReference row pointing INTO the table `targetTableId` (a DataFolder's
 * `tableId`) can carry.
 *
 * FileReference rows store the foreign-key annotation's `linkedTableId`, a connector-chosen string that isn't
 * always the table's last `tableId` segment: MySQL writes `db.table` for `[db, table]`, Postgres and Supabase write
 * `schema.table` outside `public`. So this returns every `linkedTableId` whose `linkedTableRemoteId` is exactly
 * `targetTableId`, plus the last `tableId` segment — how connectors that don't emit `linkedTableRemoteId` name the
 * target (Postgres `public`, Airtable, Webflow, ...).
 *
 * `foreignKeyPathsInConnectionSchemas` are the annotations found in the schemas of the folders whose records may
 * hold the references.
 */
export function listReferenceTargetTableIdsForTable(
  targetTableId: readonly string[],
  foreignKeyPathsInConnectionSchemas: readonly ForeignKeyPathInSchema[],
): string[] {
  const referenceTargetTableIds = new Set<string>();
  const lastTableIdSegment = targetTableId.at(-1);
  if (lastTableIdSegment !== undefined) {
    referenceTargetTableIds.add(lastTableIdSegment);
  }
  for (const foreignKeyPath of foreignKeyPathsInConnectionSchemas) {
    if (foreignKeyPath.linkedTableRemoteId && isEqual(foreignKeyPath.linkedTableRemoteId, targetTableId)) {
      referenceTargetTableIds.add(foreignKeyPath.targetRemoteTableId);
    }
  }
  return [...referenceTargetTableIds];
}
