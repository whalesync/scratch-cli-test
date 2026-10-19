/**
 * The default TableView for a MySQL table: the shared SQL heuristics (`buildPgDefaultView` — priority columns first,
 * the column family decides the cell type, read-only flags pass through), plus one MySQL addition: an ENUM column is
 * a select.
 *
 * An ENUM's schema is a closed union of its members (see `mysql-type-mapping.ts`), so the option set is known.
 * Following the Intercom precedent, only the SEMANTIC `logicalType` says `select`; the render `type` stays
 * `'string'` because the value is a plain string. The create-schema plan generator reads the choices back off the
 * schema's literal union, so a Live Export destination gets a native select field.
 *
 * TINYINT(1) deliberately stays a number cell: the checkbox cell expects a boolean and the column holds 0..255.
 */
import { type TSchema } from '@sinclair/typebox';
import { type TableView, type TableViewCol } from '@spinner/shared-types';
import { buildPgDefaultView } from '../pg-common/pg-default-view';
import { readMySqlNativeColumnType, readMySqlNativeColumnTypeBaseName } from './mysql-native-column-type';

function isMySqlEnumColumnSchema(columnSchema: TSchema | undefined): boolean {
  const nativeColumnType = readMySqlNativeColumnType(columnSchema);
  return nativeColumnType !== undefined && readMySqlNativeColumnTypeBaseName(nativeColumnType) === 'enum';
}

/** Whether the schema declares a closed set of string options (a union of string literals, nullable or not). */
function declaresClosedStringOptionSet(columnSchema: TSchema | undefined): boolean {
  const unionArms = (columnSchema as { anyOf?: TSchema[] } | undefined)?.anyOf;
  if (!unionArms || unionArms.length === 0) return false;
  let optionCount = 0;
  for (const unionArm of unionArms) {
    if ((unionArm as { type?: unknown }).type === 'null') continue;
    if (typeof (unionArm as { const?: unknown }).const === 'string') {
      optionCount++;
      continue;
    }
    // The nullable wrap nests the enum's own union one level down.
    if (!declaresClosedStringOptionSet(unionArm)) return false;
    optionCount++;
  }
  return optionCount > 0;
}

export function buildMySqlDefaultView(schema: TSchema): TableView {
  const pgDefaultView = buildPgDefaultView(schema);
  const columnSchemasByPath: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const viewColumns = pgDefaultView.cols.map((viewColumn) => {
    if (viewColumn.kind !== 'col') return viewColumn;
    const columnSchema = columnSchemasByPath[viewColumn.path];
    // A malformed ENUM spelling maps to a plain string schema; only a real option set becomes a select.
    if (!isMySqlEnumColumnSchema(columnSchema) || !declaresClosedStringOptionSet(columnSchema)) return viewColumn;
    const selectViewColumn: TableViewCol = { ...viewColumn, type: 'string', logicalType: 'select' };
    return selectViewColumn;
  });

  return { ...pgDefaultView, cols: viewColumns };
}
