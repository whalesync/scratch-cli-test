/**
 * The column a MySQL table's records are addressed by (`idPath`) — and the column a foreign key into the table
 * references. Both callers must make the SAME choice, so the foreign-key column holds exactly the id values the
 * sync pipeline writes into it.
 *
 * Preference: the single-column primary key → an AUTO_INCREMENT unique column → a NOT NULL unique column → the
 * first unique column (nullable, matching Postgres). One column of a composite primary key never qualifies (it
 * isn't unique on its own; addressing by it would update/delete sibling rows).
 *
 * A unique column whose pulled id can't be bound back to its own row (FLOAT, BLOB, spatial, VECTOR, unknown types —
 * see `isMySqlColumnTypeAddressableById`) never qualifies either: every by-id pull would silently skip the row and
 * every update / delete would miss it. The table then falls back to its next unique column, or to
 * `idPathRequiresUserSelection` when there is none.
 */
import { type MySqlSingleColumnUniqueIndexColumn } from './mysql-catalog-types';
import { isMySqlColumnTypeAddressableById } from './mysql-id-binding';

export function chooseMySqlUniquelyAddressableColumn(
  singleColumnUniqueIndexColumns: readonly MySqlSingleColumnUniqueIndexColumn[],
): MySqlSingleColumnUniqueIndexColumn | null {
  const addressableColumnsInColumnOrder = singleColumnUniqueIndexColumns
    .filter((column) => isMySqlColumnTypeAddressableById(column.nativeType))
    .sort((a, b) => a.ordinalPosition - b.ordinalPosition);
  return (
    addressableColumnsInColumnOrder.find((column) => column.isPrimaryKey) ??
    addressableColumnsInColumnOrder.find((column) => column.isAutoIncrement) ??
    addressableColumnsInColumnOrder.find((column) => !column.isNullable) ??
    addressableColumnsInColumnOrder[0] ??
    null
  );
}
