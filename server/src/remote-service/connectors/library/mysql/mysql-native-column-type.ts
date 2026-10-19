/**
 * Exact native MySQL column types (`information_schema.COLUMNS.COLUMN_TYPE`, e.g. `int unsigned`,
 * `decimal(10,2)`, `varchar(255)`, `datetime(3)`) and the predicates every other module derives from them.
 *
 * The read side annotates each column with `x-scratch-native-column-type = { typeSystem: 'mysql', type, ... }`.
 * The write side, the DDL builder and the field-value canonicalizer read that annotation back, so the type
 * classification lives here, once.
 *
 * `isRecreatableMySqlNativeColumnType` is also the SAFETY GATE before a type reaches knex `specificType` (raw
 * DDL): a create-schema plan arrives from a client, so only a spelling that matches the grammar AND the allowlist
 * below is ever interpolated. `enum(...)` / `set(...)` are never recreatable (their quoted member lists would need
 * a real literal parser, and a grammar bug there is DDL injection); they fall back to their logical type.
 */
import { X_SCRATCH_NATIVE_COLUMN_TYPE, type NativeColumnTypeAnnotation } from '@spinner/shared-types';

/** The native type system of the MySQL connector (MySQL, MariaDB, TiDB, ... share it). */
export const MYSQL_NATIVE_TYPE_SYSTEM = 'mysql';

/**
 * Base type names whose pulled value writes back into a column of the same type unchanged. Everything else —
 * binary strings and BLOBs (pulled as base64 text), BIT (pulled as a number), spatial types (pulled as base64
 * WKB), VECTOR and any type this connector doesn't recognize — has a NON-WRITABLE representation: writing the
 * pulled text back would store the text's bytes, not the original value.
 */
const MYSQL_BASE_TYPES_WITH_WRITABLE_REPRESENTATION: ReadonlySet<string> = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'bigint',
  'decimal',
  'numeric',
  'float',
  'double',
  'real',
  'year',
  'bool',
  'boolean',
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'enum',
  'set',
  'date',
  'datetime',
  'timestamp',
  'time',
  'json',
  // MariaDB-only string-like types (pulled and written as text).
  'uuid',
  'inet4',
  'inet6',
]);

const MYSQL_INTEGER_BASE_TYPES: ReadonlySet<string> = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'bigint',
]);

/** Column types MySQL can't reference from (or with) a foreign key: TEXT/BLOB need a prefix length, JSON can't be indexed. */
const MYSQL_TEXT_OR_BLOB_OR_JSON_BASE_TYPES: ReadonlySet<string> = new Set([
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'json',
]);

/** The lower-cased leading type word of a `COLUMN_TYPE` spelling: `int unsigned` → `int`, `decimal(10,2)` → `decimal`. */
export function readMySqlNativeColumnTypeBaseName(columnTypeSpelling: string): string {
  const baseTypeNameMatch = /^\s*([a-z0-9_]+)/i.exec(columnTypeSpelling);
  return baseTypeNameMatch ? baseTypeNameMatch[1].toLowerCase() : '';
}

/**
 * The clause the native-type annotation appends to an ENUM / SET declared `CHARACTER SET binary` (on the column, or
 * inherited from a table created with `DEFAULT CHARSET=binary`). `COLUMN_TYPE` never shows a charset, but this one
 * changes what is pulled: the server sends the member as binary bytes (charset 63), mysql2 hands the row decoder a
 * Buffer, and the decoder stores it as base64 — and mysql2's typeCast doesn't expose the charset, so the decoder
 * can't tell it apart from BINARY(n). The annotation therefore spells the full declaration (valid MySQL DDL), and
 * every module that reads the spelling back (the write path, the id binding, the canonicalizer, the DDL gate) sees
 * a binary value with a non-writable representation.
 */
export const MYSQL_BINARY_CHARACTER_SET_CLAUSE = ' character set binary';

const MYSQL_ENUM_OR_SET_BASE_TYPES: ReadonlySet<string> = new Set(['enum', 'set']);

/**
 * Whether a catalog column is an ENUM / SET that stores binary strings. MySQL 8.4 reports `CHARACTER_SET_NAME` NULL
 * for such a column and MariaDB 11.4 reports `binary` (both verified); an ENUM / SET of text always has a charset.
 */
export function isMySqlBinaryCharacterSetEnumOrSetColumn(columnType: string, characterSetName: string | null): boolean {
  if (!MYSQL_ENUM_OR_SET_BASE_TYPES.has(readMySqlNativeColumnTypeBaseName(columnType))) return false;
  return characterSetName === null || characterSetName.toLowerCase() === 'binary';
}

/**
 * Whether an annotation spelling is a binary-charset ENUM / SET (see {@link MYSQL_BINARY_CHARACTER_SET_CLAUSE}). The
 * clause must follow the member list's closing parenthesis, so a member that merely contains the words can't match.
 */
export function isMySqlBinaryCharacterSetEnumOrSetSpelling(columnTypeSpelling: string): boolean {
  return (
    MYSQL_ENUM_OR_SET_BASE_TYPES.has(readMySqlNativeColumnTypeBaseName(columnTypeSpelling)) &&
    /\)\s*character\s+set\s+binary\s*$/i.test(columnTypeSpelling)
  );
}

/**
 * Whether a pulled value of this column can NOT be written back as-is (binary, BIT, spatial, VECTOR, unknown types,
 * and binary-charset ENUM / SET).
 */
export function mysqlColumnHasNonWritableRepresentation(columnTypeSpelling: string): boolean {
  return (
    !MYSQL_BASE_TYPES_WITH_WRITABLE_REPRESENTATION.has(readMySqlNativeColumnTypeBaseName(columnTypeSpelling)) ||
    isMySqlBinaryCharacterSetEnumOrSetSpelling(columnTypeSpelling)
  );
}

export function isMySqlIntegerColumnType(columnTypeSpelling: string): boolean {
  return MYSQL_INTEGER_BASE_TYPES.has(readMySqlNativeColumnTypeBaseName(columnTypeSpelling));
}

export function isMySqlTextOrBlobOrJsonColumnType(columnTypeSpelling: string): boolean {
  return MYSQL_TEXT_OR_BLOB_OR_JSON_BASE_TYPES.has(readMySqlNativeColumnTypeBaseName(columnTypeSpelling));
}

/**
 * A temporal column's kind and (for DATETIME / TIMESTAMP) its fractional-seconds precision, 0-6. `undefined`
 * precision means "unknown" — only when the column type isn't known at all (a schema without the native
 * annotation); a native `datetime` spelling always has a known precision.
 */
export type MySqlTemporalColumnType =
  | { temporalKind: 'date' }
  | { temporalKind: 'datetime' | 'timestamp'; fractionalSecondsPrecision: number | undefined };

/**
 * Classify `date`, `datetime[(fsp)]` and `timestamp[(fsp)]`; undefined for every other type (incl. TIME, YEAR).
 * MySQL and MariaDB report a precision-0 column as plain `datetime` / `timestamp` (never `datetime(0)`), so a bare
 * spelling means precision 0 — values written into it lose their fraction (MySQL rounds, MariaDB truncates).
 */
export function classifyMySqlTemporalColumnType(columnTypeSpelling: string): MySqlTemporalColumnType | undefined {
  const temporalMatch = /^\s*(date|datetime|timestamp)(?:\(([0-6])\))?\s*$/i.exec(columnTypeSpelling);
  if (!temporalMatch) return undefined;
  const temporalKind = temporalMatch[1].toLowerCase() as 'date' | 'datetime' | 'timestamp';
  if (temporalKind === 'date') {
    return temporalMatch[2] === undefined ? { temporalKind } : undefined;
  }
  const fractionalSecondsPrecision = temporalMatch[2] === undefined ? 0 : Number(temporalMatch[2]);
  return { temporalKind, fractionalSecondsPrecision };
}

/**
 * `COLUMN_TYPE` grammar for the recreatable subset: a lower-case base name, an optional `(n)` or `(n,m)`
 * modifier, and an optional ` unsigned`. Quotes, `zerofill`, charset clauses and anything else never match.
 */
const MYSQL_RECREATABLE_COLUMN_TYPE_GRAMMAR =
  /^(?<baseTypeName>[a-z]+)(?:\((?<firstModifier>\d{1,5})(?:,(?<secondModifier>\d{1,2}))?\))?(?<unsignedSuffix> unsigned)?$/;

/**
 * Whether a destination can create a column of exactly this `COLUMN_TYPE` and write the source's pulled values
 * into it unchanged. Also the gate for interpolating the type into DDL. Input is lower-cased first (MySQL already
 * reports lower case; ENUM/SET literals, the only case-carrying part, are never recreatable).
 */
export function isRecreatableMySqlNativeColumnType(columnTypeSpelling: string): boolean {
  const grammarMatch = MYSQL_RECREATABLE_COLUMN_TYPE_GRAMMAR.exec(columnTypeSpelling.trim().toLowerCase());
  if (!grammarMatch?.groups) return false;
  const { baseTypeName, firstModifier, secondModifier, unsignedSuffix } = grammarMatch.groups;
  const firstModifierValue = firstModifier === undefined ? undefined : Number(firstModifier);
  const secondModifierValue = secondModifier === undefined ? undefined : Number(secondModifier);
  const hasUnsigned = unsignedSuffix !== undefined;

  switch (baseTypeName) {
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'bigint':
      // Optional (deprecated) display width, e.g. MariaDB's `int(11)`.
      return secondModifierValue === undefined && (firstModifierValue === undefined || firstModifierValue <= 255);
    case 'decimal':
    case 'numeric':
      if (firstModifierValue === undefined) return secondModifierValue === undefined;
      if (firstModifierValue < 1 || firstModifierValue > 65) return false;
      return (
        secondModifierValue === undefined || (secondModifierValue <= 30 && secondModifierValue <= firstModifierValue)
      );
    case 'float':
    case 'double':
      if (firstModifierValue === undefined) return secondModifierValue === undefined;
      return (
        secondModifierValue !== undefined &&
        firstModifierValue >= 1 &&
        firstModifierValue <= 255 &&
        secondModifierValue <= 30 &&
        secondModifierValue <= firstModifierValue
      );
    case 'char':
      return (
        !hasUnsigned &&
        secondModifierValue === undefined &&
        (firstModifierValue === undefined || firstModifierValue <= 255)
      );
    case 'varchar':
      return (
        !hasUnsigned &&
        secondModifierValue === undefined &&
        firstModifierValue !== undefined &&
        firstModifierValue >= 1 &&
        firstModifierValue <= 16383
      );
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
    case 'json':
    case 'date':
      return !hasUnsigned && firstModifierValue === undefined && secondModifierValue === undefined;
    case 'year':
      return (
        !hasUnsigned &&
        secondModifierValue === undefined &&
        (firstModifierValue === undefined || firstModifierValue === 4)
      );
    case 'datetime':
    case 'timestamp':
    case 'time':
      return (
        !hasUnsigned &&
        secondModifierValue === undefined &&
        (firstModifierValue === undefined || firstModifierValue <= 6)
      );
    default:
      return false;
  }
}

/** The catalog facts that decide a column's declared type spelling and whether it can be recreated verbatim. */
export interface MySqlNativeColumnTypeContext {
  /** MariaDB reports the column as a JSON document (LONGTEXT + `json_valid` CHECK); see `mysql-json-schema.ts`. */
  isMariaDbJsonAlias: boolean;
  /** `information_schema.COLUMNS.CHARACTER_SET_NAME` (null for non-character columns and MySQL binary ENUM / SET). */
  characterSetName: string | null;
}

/**
 * The column's declared type as the rest of the pipeline should read it: `COLUMN_TYPE` verbatim, except a MariaDB
 * JSON alias reports `json` (its declared type, and the one that round-trips — recreating `longtext` would turn
 * documents into text), and a binary-charset ENUM / SET gets {@link MYSQL_BINARY_CHARACTER_SET_CLAUSE}.
 */
export function resolveMySqlDeclaredColumnTypeSpelling(
  columnType: string,
  context: MySqlNativeColumnTypeContext,
): string {
  if (context.isMariaDbJsonAlias) return 'json';
  if (isMySqlBinaryCharacterSetEnumOrSetColumn(columnType, context.characterSetName)) {
    return `${columnType}${MYSQL_BINARY_CHARACTER_SET_CLAUSE}`;
  }
  return columnType;
}

/** Character types whose row-size cost depends on the character set (the destination always creates utf8mb4). */
const MYSQL_INLINE_CHARACTER_BASE_TYPES: ReadonlySet<string> = new Set(['char', 'varchar']);

/**
 * A created table is always `utf8mb4` (`mysql-create-schema.ts`), and a recreated `varchar(n)` / `char(n)` reserves
 * up to 4 bytes per character inside MySQL's 65,535-byte row. The same declaration in latin1 / ascii (1 byte) or
 * utf8mb3 (3 bytes) costs less at the source, so recreating a wide legacy table verbatim can exceed the row size
 * (1118) and fail the whole CREATE TABLE. Such columns fall back to their logical kind (stored off-row).
 */
function characterSetAllowsVerbatimRecreate(declaredColumnType: string, characterSetName: string | null): boolean {
  if (!MYSQL_INLINE_CHARACTER_BASE_TYPES.has(readMySqlNativeColumnTypeBaseName(declaredColumnType))) return true;
  return characterSetName !== null && characterSetName.toLowerCase().startsWith('utf8mb4');
}

/** The `x-scratch-native-column-type` annotation for a MySQL column (see {@link resolveMySqlDeclaredColumnTypeSpelling}). */
export function buildMySqlNativeColumnTypeAnnotation(
  columnType: string,
  context: MySqlNativeColumnTypeContext,
): NativeColumnTypeAnnotation {
  const declaredColumnType = resolveMySqlDeclaredColumnTypeSpelling(columnType, context);
  return {
    typeSystem: MYSQL_NATIVE_TYPE_SYSTEM,
    type: declaredColumnType,
    isRecreatableVerbatim:
      !mysqlColumnHasNonWritableRepresentation(declaredColumnType) &&
      isRecreatableMySqlNativeColumnType(declaredColumnType) &&
      characterSetAllowsVerbatimRecreate(declaredColumnType, context.characterSetName),
  };
}

/** Read a column schema's MySQL native type back (undefined when absent or from another type system). */
export function readMySqlNativeColumnType(columnSchema: unknown): string | undefined {
  if (typeof columnSchema !== 'object' || columnSchema === null) return undefined;
  const annotation = (columnSchema as Record<string, unknown>)[X_SCRATCH_NATIVE_COLUMN_TYPE];
  if (typeof annotation !== 'object' || annotation === null) return undefined;
  const { typeSystem, type } = annotation as Partial<NativeColumnTypeAnnotation>;
  return typeSystem === MYSQL_NATIVE_TYPE_SYSTEM && typeof type === 'string' ? type : undefined;
}
