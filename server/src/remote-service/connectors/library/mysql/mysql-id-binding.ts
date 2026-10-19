/**
 * How a record id is bound when matching rows by primary key (by-id pulls, updates, deletes, insert re-selects).
 *
 * A string constant compared with an integer column is converted loosely: `'12abc'` matches row 12 and
 * `'9.007199254740993e15'` matches row 9007199254740993 (MySQL's documented rule is a DOUBLE comparison; MySQL 8.4 /
 * MariaDB 11.4 compare all-digit text exactly, but the loose conversion of non-integer text reproduces on both).
 * Integer ids are therefore bound as BigInt (mysql2 renders an unquoted integer literal — verified in the spike), and
 * non-integer text for an integer key is reported unmatchable instead of being sent. Binary keys (BINARY(16) UUIDs)
 * are pulled as base64 and bound back as the exact bytes.
 *
 * Every binding here must invert the READ side's rendering of the id, or the row can never be found again: BIT is
 * pulled as its unsigned integer (bound back as one — the quoted text `'5'` would be the byte 0x35), and a
 * DATE / DATETIME / TIMESTAMP id goes back through the write path's literal converter (a TIMESTAMP is pulled as
 * RFC 3339 `…Z`, which MySQL 8.4 rejects in a DML WHERE (1292) and MariaDB 11.4 silently matches to nothing).
 * FLOAT ids have no such inverse (the 6-digit rendering never equals the stored float32), so they are never chosen
 * as the id column in the first place ({@link isMySqlColumnTypeAddressableById}).
 */
import { type BaseJsonTableSpec } from '../../types';
import {
  classifyMySqlTemporalColumnType,
  isMySqlBinaryCharacterSetEnumOrSetSpelling,
  isMySqlIntegerColumnType,
  mysqlColumnHasNonWritableRepresentation,
  readMySqlNativeColumnType,
  readMySqlNativeColumnTypeBaseName,
  type MySqlTemporalColumnType,
} from './mysql-native-column-type';
import { convertTemporalValueToMySqlLiteral } from './mysql-temporal-literal';

/**
 * A DATE / DATETIME / TIMESTAMP id. It carries the column's temporal type because the literal it binds has the
 * column's own shape (a DATE binds `YYYY-MM-DD`; DATETIME(3) binds exactly three fractional digits).
 */
export interface MySqlTemporalPrimaryKeyBindingKind {
  readonly bindingKindName: 'temporal';
  readonly temporalColumnType: MySqlTemporalColumnType;
}

export type MySqlPrimaryKeyBindingKind =
  | 'integer'
  | 'base64Binary'
  | 'text'
  | 'passthrough'
  | MySqlTemporalPrimaryKeyBindingKind;

const MYSQL_BINARY_KEY_BASE_TYPES: ReadonlySet<string> = new Set(['binary', 'varbinary']);
const MYSQL_TEXT_KEY_BASE_TYPES: ReadonlySet<string> = new Set([
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'enum',
  'set',
  'uuid',
]);

/**
 * Approximate single-precision types. A FLOAT is pulled as mysql2's 6-significant-digit rendering (`1.1`), while
 * the column stores the float32 nearest to it (1.100000023841858); MySQL compares the bound value as a DOUBLE, so
 * the pulled id never matches its own row. (REAL is FLOAT under `REAL_AS_FLOAT`, and `COLUMN_TYPE` then says
 * `float`; otherwise REAL is DOUBLE, which round-trips: its pulled number is the shortest exact rendering.)
 */
const MYSQL_KEY_BASE_TYPES_WITHOUT_AN_EXACT_PULLED_RENDERING: ReadonlySet<string> = new Set(['float']);

/** The binding kind for a table's id column, from its native type annotation. */
export function resolveMySqlPrimaryKeyBindingKind(tableSpec: BaseJsonTableSpec): MySqlPrimaryKeyBindingKind {
  const schemaProperties = (tableSpec.schema as { properties?: Record<string, unknown> }).properties ?? {};
  const idColumnNativeType = readMySqlNativeColumnType(schemaProperties[tableSpec.idPath]);
  return mysqlPrimaryKeyBindingKindForColumnType(idColumnNativeType);
}

/**
 * `decimal`, `decimal(p)` and `decimal(p,0)` hold integers only, and a string constant compared with them is converted
 * just as loosely, so they bind like integer keys. A DECIMAL key with a fractional scale stays text (a known gap:
 * its exact match relies on MySQL's string-to-decimal conversion).
 */
function isMySqlIntegerValuedDecimalColumnType(columnTypeSpelling: string): boolean {
  return /^\s*(?:decimal|numeric)(?:\(\s*\d+\s*(?:,\s*0\s*)?\))?(?:\s+unsigned)?\s*$/i.test(columnTypeSpelling);
}

export function mysqlPrimaryKeyBindingKindForColumnType(
  columnTypeSpelling: string | undefined,
): MySqlPrimaryKeyBindingKind {
  if (columnTypeSpelling === undefined) return 'passthrough';
  if (isMySqlIntegerColumnType(columnTypeSpelling) || isMySqlIntegerValuedDecimalColumnType(columnTypeSpelling)) {
    return 'integer';
  }
  const baseTypeName = readMySqlNativeColumnTypeBaseName(columnTypeSpelling);
  // BIT is pulled as its unsigned integer value (a decimal string above 53 bits), which binds back exactly as one.
  if (baseTypeName === 'bit') return 'integer';
  const temporalColumnType = classifyMySqlTemporalColumnType(columnTypeSpelling);
  if (temporalColumnType !== undefined) return { bindingKindName: 'temporal', temporalColumnType };
  // A binary-charset ENUM / SET is pulled as the base64 of its member's bytes, like BINARY(n).
  if (MYSQL_BINARY_KEY_BASE_TYPES.has(baseTypeName) || isMySqlBinaryCharacterSetEnumOrSetSpelling(columnTypeSpelling)) {
    return 'base64Binary';
  }
  if (MYSQL_TEXT_KEY_BASE_TYPES.has(baseTypeName)) return 'text';
  return mysqlColumnHasNonWritableRepresentation(columnTypeSpelling) ? 'passthrough' : 'text';
}

/**
 * Whether ids pulled from a column of this `COLUMN_TYPE` bind back to exactly the row they came from — the
 * precondition for choosing the column as a table's id (`mysql-uniquely-addressable-column.ts`). False for FLOAT
 * (see {@link MYSQL_KEY_BASE_TYPES_WITHOUT_AN_EXACT_PULLED_RENDERING}) and for every type bound 'passthrough' (BLOB,
 * spatial, VECTOR and unknown types, whose pulled encoding the server would compare as text).
 */
export function isMySqlColumnTypeAddressableById(columnTypeSpelling: string): boolean {
  if (
    MYSQL_KEY_BASE_TYPES_WITHOUT_AN_EXACT_PULLED_RENDERING.has(readMySqlNativeColumnTypeBaseName(columnTypeSpelling))
  ) {
    return false;
  }
  return mysqlPrimaryKeyBindingKindForColumnType(columnTypeSpelling) !== 'passthrough';
}

export type BindableMySqlPrimaryKeyValue =
  | { isMatchable: true; bindableValue: bigint | string | number | Buffer }
  | { isMatchable: false };

const DECIMAL_INTEGER_TEXT_PATTERN = /^-?\d+$/;
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The literal MySQL stores for a temporal id in this column (a pulled TIMESTAMP `2026-01-02T03:04:05.678Z` →
 * `2026-01-02 03:04:05.678`; our session time zone is UTC), or undefined when the id isn't a date / date-time the
 * column could hold (so no row can have it).
 */
function convertTemporalRecordIdToMySqlLiteral(
  recordId: unknown,
  temporalColumnType: MySqlTemporalColumnType,
): string | undefined {
  if (typeof recordId !== 'string') return undefined;
  const temporalLiteralConversion = convertTemporalValueToMySqlLiteral(recordId, temporalColumnType);
  return temporalLiteralConversion.outcome === 'converted' ? temporalLiteralConversion.mySqlLiteral : undefined;
}

export function toBindableMySqlPrimaryKeyValue(
  recordId: unknown,
  bindingKind: MySqlPrimaryKeyBindingKind,
): BindableMySqlPrimaryKeyValue {
  if (typeof bindingKind === 'object') {
    const temporalLiteral = convertTemporalRecordIdToMySqlLiteral(recordId, bindingKind.temporalColumnType);
    return temporalLiteral === undefined
      ? { isMatchable: false }
      : { isMatchable: true, bindableValue: temporalLiteral };
  }
  switch (bindingKind) {
    case 'integer':
      if (typeof recordId === 'number' && Number.isSafeInteger(recordId)) {
        return { isMatchable: true, bindableValue: BigInt(recordId) };
      }
      if (typeof recordId === 'bigint') return { isMatchable: true, bindableValue: recordId };
      if (typeof recordId === 'string' && DECIMAL_INTEGER_TEXT_PATTERN.test(recordId)) {
        return { isMatchable: true, bindableValue: BigInt(recordId) };
      }
      return { isMatchable: false };
    case 'base64Binary':
      if (typeof recordId === 'string' && recordId.length % 4 === 0 && STRICT_BASE64_PATTERN.test(recordId)) {
        return { isMatchable: true, bindableValue: Buffer.from(recordId, 'base64') };
      }
      return { isMatchable: false };
    case 'text':
      if (typeof recordId === 'string' || typeof recordId === 'number') {
        return { isMatchable: true, bindableValue: String(recordId) };
      }
      return { isMatchable: false };
    case 'passthrough':
      if (typeof recordId === 'string' || typeof recordId === 'number' || typeof recordId === 'bigint') {
        return { isMatchable: true, bindableValue: recordId };
      }
      return { isMatchable: false };
  }
}

/**
 * The text used to line up rows MySQL returned with the ids we asked for. Integer ids compare by value
 * (`'007'` and `7` are the same row); temporal ids compare by the literal MySQL stores, so the bound literal
 * (`2026-01-02 03:04:05.678`) and the re-selected, decoded TIMESTAMP (`2026-01-02T03:04:05.678Z`) line up;
 * everything else compares by its string form.
 */
export function canonicalMySqlPrimaryKeyText(
  value: unknown,
  bindingKind: MySqlPrimaryKeyBindingKind,
): string | undefined {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  const valueText =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean'
        ? String(value)
        : undefined;
  if (valueText === undefined) return undefined;
  if (typeof bindingKind === 'object') {
    return convertTemporalRecordIdToMySqlLiteral(valueText, bindingKind.temporalColumnType) ?? valueText;
  }
  if (bindingKind === 'integer' && DECIMAL_INTEGER_TEXT_PATTERN.test(valueText)) {
    return BigInt(valueText).toString();
  }
  return valueText;
}
