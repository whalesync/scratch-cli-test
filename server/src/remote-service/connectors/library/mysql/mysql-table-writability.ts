/**
 * Whether Scratch may write to a MySQL table, and the reasons shown in the table picker.
 *
 * Only InnoDB tables are writable. Our multi-row guards (`UPDATE/DELETE ... LIMIT 2` → roll back) and
 * `STRICT_TRANS_TABLES` (which rejects bad values instead of silently truncating them) both rely on transactions;
 * MyISAM, MEMORY, ARCHIVE, ... can't roll back a partly-applied write, so those tables are pull-only. TiDB and
 * Vitess/PlanetScale report InnoDB. The same rule is enforced again at write time, because a table's engine can
 * change after it was listed.
 */
import { type TablePreview } from '../../types';
import { type MySqlTableReference } from './mysql-types';

export const STORAGE_ENGINES_SAFE_FOR_SCRATCH_WRITES: ReadonlySet<string> = new Set(['innodb']);

export function isStorageEngineSafeForScratchWrites(storageEngine: string | null | undefined): boolean {
  return typeof storageEngine === 'string' && STORAGE_ENGINES_SAFE_FOR_SCRATCH_WRITES.has(storageEngine.toLowerCase());
}

export function unsupportedStorageEngineMessage(storageEngine: string | null | undefined): string {
  const engineDescription = storageEngine ? `the ${storageEngine} storage engine` : 'a storage engine';
  return `This table uses ${engineDescription}, which can't roll back a partly-applied write, so Scratch opens it read-only. Convert it to InnoDB (ALTER TABLE … ENGINE=InnoDB) to edit it from Scratch.`;
}

export function unsupportedStorageEngineWriteMessage(
  table: MySqlTableReference,
  storageEngine: string | null | undefined,
): string {
  const engineDescription = storageEngine ? `the ${storageEngine} storage engine` : 'a storage engine';
  return `Can't write to "${table.databaseName}"."${table.tableName}": it uses ${engineDescription}, which can't roll back a partly-applied write. Convert it to InnoDB to edit it from Scratch.`;
}

export const TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON =
  "This table has no AUTO_INCREMENT id column, so Scratch can't learn the id of a new row. Creates are not supported; existing rows can still be updated and deleted.";

/**
 * Write restrictions for a (readable) table's preview. Precedence: a non-InnoDB engine disables all writes;
 * otherwise a table whose id isn't AUTO_INCREMENT disables creates only.
 */
export function buildMySqlTablePreviewWriteRestrictions(params: {
  storageEngine: string | null | undefined;
  hasAutoIncrementPrimaryKey: boolean;
}): Pick<TablePreview, 'disabledCreates' | 'disabledUpdates' | 'disabledDeletes' | 'disabledReason'> {
  if (!isStorageEngineSafeForScratchWrites(params.storageEngine)) {
    return {
      disabledCreates: true,
      disabledUpdates: true,
      disabledDeletes: true,
      disabledReason: unsupportedStorageEngineMessage(params.storageEngine),
    };
  }
  if (!params.hasAutoIncrementPrimaryKey) {
    return { disabledCreates: true, disabledReason: TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON };
  }
  return {};
}
