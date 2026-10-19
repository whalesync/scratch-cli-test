/**
 * MySQL column → TypeBox value schema + the shared `x-scratch-connector-data-type` family, and the column-level
 * predicates the spec builder needs (read-only, omittable on insert, invisible, title column).
 *
 * Every schema here describes the value exactly as the row decoder (`mysql-row-value-decoder.ts`) puts it on disk
 * (Connector Prime Directive: the schema adapts to the data, never the other way round). The family reuses the
 * Postgres vocabulary (`PostgresColumnType`) on purpose: `buildPgDefaultView`, the empty-string coercion and the
 * JSON-column handling key on it and work unchanged for MySQL.
 *
 * Mapping is by `DATA_TYPE`; `COLUMN_TYPE` supplies ENUM/SET members and the BIT width.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import { JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT, PostgresColumnType } from '@spinner/shared-types';
import { dotPath, type DotPath } from '../../types';
import { TITLE_COLUMN_CANDIDATES } from '../pg-common/pg-type-mapping';
import { type MySqlCatalogColumn } from './mysql-catalog-types';
import {
  isMySqlBinaryCharacterSetEnumOrSetColumn,
  mysqlColumnHasNonWritableRepresentation,
  resolveMySqlDeclaredColumnTypeSpelling,
} from './mysql-native-column-type';

export interface MySqlColumnTypeMapping {
  /** The schema of a non-null value (the spec builder adds the nullable wrap). */
  valueSchema: TSchema;
  columnFamily: PostgresColumnType;
  /** The pulled value can't be written back as-is (binary, BIT, spatial, VECTOR, unknown types) → read-only. */
  hasNonWritableRepresentation: boolean;
  agentInstructions?: string;
}

/** Integer and floating-point types mysql2 returns as a JS number (all fit a double exactly, except FLOAT/DOUBLE themselves). */
const MYSQL_NUMBER_DATA_TYPES: ReadonlySet<string> = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'year',
  'float',
  'double',
  'real',
]);

/** Arbitrary-precision types mysql2 returns as a verbatim string (`bigNumberStrings`, `decimalNumbers: false`). */
const MYSQL_NUMBER_STRING_DATA_TYPES: ReadonlySet<string> = new Set(['bigint', 'decimal', 'numeric']);

/** Character types whose value is plain text. `char`/`varchar` also carry a max length (added by the spec builder). */
export const MYSQL_TEXT_DATA_TYPES: ReadonlySet<string> = new Set([
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
]);

/** Other types pulled as text: TIME (`-838:59:59`…), MariaDB's UUID / INET4 / INET6. */
const MYSQL_OTHER_STRING_DATA_TYPES: ReadonlySet<string> = new Set(['time', 'uuid', 'inet4', 'inet6']);

const MYSQL_BINARY_DATA_TYPES: ReadonlySet<string> = new Set([
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
]);

const MYSQL_SPATIAL_DATA_TYPES: ReadonlySet<string> = new Set([
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'geomcollection',
]);

/** Above 53 bits a BIT value no longer fits a double exactly, so the decoder returns its decimal string. */
const MYSQL_BIT_WIDTH_REPRESENTABLE_AS_NUMBER = 53;

const BINARY_VALUE_AGENT_INSTRUCTIONS =
  'Binary data, stored as the base64 encoding of the exact bytes. Read-only in Scratch: editing the text would store the text itself, not the decoded bytes.';
const SPATIAL_VALUE_AGENT_INSTRUCTIONS =
  "Spatial value, stored as base64 of MySQL's internal format (a 4-byte little-endian SRID followed by the WKB geometry). Read-only in Scratch.";
const BIT_VALUE_AGENT_INSTRUCTIONS =
  'BIT column, stored as its unsigned integer value (a decimal string above 53 bits). Read-only in Scratch.';
const VECTOR_VALUE_AGENT_INSTRUCTIONS = 'VECTOR column, stored as an array of numbers. Read-only in Scratch.';

/**
 * Schema for an arbitrary-precision numeric the driver hands over as a verbatim string. A number is accepted too
 * (same union as the Postgres mapping, whose helper is module-private) so a value typed in by hand still validates.
 */
function arbitraryPrecisionNumericValueSchema(): TSchema {
  return Type.Union([Type.String(), Type.Number()]);
}

/** Map of the single-character escapes MySQL uses when it prints a string literal (e.g. ENUM members in COLUMN_TYPE). */
const MYSQL_STRING_LITERAL_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  b: '\b',
  n: '\n',
  r: '\r',
  t: '\t',
  Z: '\x1a',
};

/**
 * The member list of an `enum(...)` / `set(...)` `COLUMN_TYPE`, unescaped: MySQL and MariaDB print each member as a
 * single-quoted literal with `'` doubled (`'it''s'`) and backslash escapes (`'b\\c'`, `'nl\nx'`; verified on 8.4 and
 * 11.4). Returns undefined for anything that isn't a well-formed ENUM/SET spelling, so callers fall back to a plain
 * string schema instead of a wrong option set.
 */
export function parseMySqlEnumOrSetMembers(columnType: string): string[] | undefined {
  const memberListMatch = /^\s*(?:enum|set)\s*\(([\s\S]*)\)\s*$/i.exec(columnType);
  if (!memberListMatch) return undefined;
  const memberListText = memberListMatch[1];
  const members: string[] = [];
  let characterIndex = 0;
  // Each pass reads one quoted member; a comma must be followed by another member (`enum('a',)` is malformed).
  for (;;) {
    if (memberListText[characterIndex] !== "'") return undefined;
    characterIndex++;
    let member = '';
    let memberIsTerminated = false;
    while (characterIndex < memberListText.length) {
      const character = memberListText[characterIndex];
      if (character === "'") {
        if (memberListText[characterIndex + 1] === "'") {
          member += "'";
          characterIndex += 2;
          continue;
        }
        characterIndex++;
        memberIsTerminated = true;
        break;
      }
      if (character === '\\' && characterIndex + 1 < memberListText.length) {
        const escapedCharacter = memberListText[characterIndex + 1];
        member += MYSQL_STRING_LITERAL_ESCAPES[escapedCharacter] ?? escapedCharacter;
        characterIndex += 2;
        continue;
      }
      member += character;
      characterIndex++;
    }
    if (!memberIsTerminated) return undefined;
    members.push(member);
    if (characterIndex === memberListText.length) return members;
    if (memberListText[characterIndex] !== ',') return undefined;
    characterIndex++;
  }
}

/** BIT(n)'s width: from COLUMN_TYPE `bit(n)`, else NUMERIC_PRECISION, else 1 (`BIT` means `BIT(1)`). */
function readMySqlBitColumnWidth(column: MySqlCatalogColumn): number {
  const bitWidthMatch = /^\s*bit\s*\(\s*(\d+)\s*\)/i.exec(column.columnType);
  if (bitWidthMatch) return Number(bitWidthMatch[1]);
  return column.numericPrecision ?? 1;
}

/**
 * The value schema and family of a column, exactly as the row decoder stores it:
 *
 * | DATA_TYPE | on disk | schema / family |
 * |---|---|---|
 * | tinyint (incl. `tinyint(1)`), smallint, mediumint, int, year, float, double | number | Number / NUMERIC |
 * | bigint, decimal | verbatim string | string∪number / NUMERIC_STRING |
 * | bit(n) | number (n ≤ 53) or decimal string | Number or string∪number, read-only |
 * | char, varchar, *text, time, MariaDB uuid/inet4/inet6 | string | String / TEXT |
 * | enum | string | closed union of the members plus `''` / TEXT |
 * | set | comma-separated members | String + agent instructions / TEXT |
 * | date / datetime | verbatim | `date` / `date-time-local` / TIMESTAMP |
 * | timestamp | `YYYY-MM-DDTHH:MM:SS[.f]Z` | `date-time` / TIMESTAMP |
 * | json, MariaDB JSON (any column MariaDB flags as JSON) | parsed document | Unknown / JSONB |
 * | binary, varbinary, *blob, spatial types | base64 | String `contentEncoding: base64` / TEXT, read-only |
 * | enum / set declared `CHARACTER SET binary` | base64 | String `contentEncoding: base64` / TEXT, read-only |
 * | vector | number[] | Array(Number) / NUMERIC_ARRAY, read-only |
 * | anything else | as the driver returns it | Unknown / TEXT, read-only |
 *
 * TINYINT(1) stays a number (no boolean coercion: the column can hold 0..255 / -128..127, and 2 is not `true`).
 */
export function mapMySqlColumnType(
  column: MySqlCatalogColumn,
  context: { isMariaDbJsonAlias: boolean },
): MySqlColumnTypeMapping {
  // Single source of truth for "can the pulled value be written back as-is" (shared with the write path and the
  // native-type annotation), judged by the same declared spelling the annotation carries: a MariaDB JSON alias by
  // `json`, a binary-charset ENUM / SET by its `character set binary` spelling.
  const hasNonWritableRepresentation = mysqlColumnHasNonWritableRepresentation(
    resolveMySqlDeclaredColumnTypeSpelling(column.columnType, {
      isMariaDbJsonAlias: context.isMariaDbJsonAlias,
      characterSetName: column.characterSetName,
    }),
  );
  const withFamily = (
    valueSchema: TSchema,
    columnFamily: PostgresColumnType,
    agentInstructions?: string,
  ): MySqlColumnTypeMapping => ({
    valueSchema,
    columnFamily,
    hasNonWritableRepresentation,
    ...(agentInstructions !== undefined ? { agentInstructions } : {}),
  });

  // MariaDB reports its JSON alias as LONGTEXT (or whatever type the json_valid CHECK sits on); the decoder parses it.
  if (context.isMariaDbJsonAlias) return withFamily(Type.Unknown(), PostgresColumnType.JSONB);

  const dataType = column.dataType.toLowerCase();
  if (MYSQL_NUMBER_DATA_TYPES.has(dataType)) return withFamily(Type.Number(), PostgresColumnType.NUMERIC);
  if (MYSQL_NUMBER_STRING_DATA_TYPES.has(dataType)) {
    return withFamily(arbitraryPrecisionNumericValueSchema(), PostgresColumnType.NUMERIC_STRING);
  }
  if (dataType === 'bit') {
    return readMySqlBitColumnWidth(column) <= MYSQL_BIT_WIDTH_REPRESENTABLE_AS_NUMBER
      ? withFamily(Type.Number(), PostgresColumnType.NUMERIC, BIT_VALUE_AGENT_INSTRUCTIONS)
      : withFamily(
          arbitraryPrecisionNumericValueSchema(),
          PostgresColumnType.NUMERIC_STRING,
          BIT_VALUE_AGENT_INSTRUCTIONS,
        );
  }
  if (MYSQL_TEXT_DATA_TYPES.has(dataType) || MYSQL_OTHER_STRING_DATA_TYPES.has(dataType)) {
    return withFamily(Type.String(), PostgresColumnType.TEXT);
  }
  // Must precede the ENUM / SET branches: the server sends a binary-charset member as bytes and the decoder stores
  // their base64 (mysql2's typeCast can't see the charset), so the member-literal union would reject every value.
  if (isMySqlBinaryCharacterSetEnumOrSetColumn(column.columnType, column.characterSetName)) {
    return withFamily(
      Type.String({ contentEncoding: 'base64' }),
      PostgresColumnType.TEXT,
      BINARY_VALUE_AGENT_INSTRUCTIONS,
    );
  }
  if (dataType === 'enum') {
    const enumMembers = parseMySqlEnumOrSetMembers(column.columnType);
    if (!enumMembers) return withFamily(Type.String(), PostgresColumnType.TEXT);
    // `''` is MySQL's documented "invalid value" (enum index 0) that non-strict writes store; including it keeps
    // such legacy rows valid. Select-choice builders drop the empty option.
    const enumMembersWithEmptyErrorValue = [...new Set([...enumMembers, ''])];
    return withFamily(
      Type.Union(enumMembersWithEmptyErrorValue.map((enumMember) => Type.Literal(enumMember))),
      PostgresColumnType.TEXT,
    );
  }
  if (dataType === 'set') {
    const setMembers = parseMySqlEnumOrSetMembers(column.columnType);
    const setAgentInstructions = setMembers
      ? `MySQL SET column: a comma-separated subset (no spaces) of: ${setMembers.map((setMember) => JSON.stringify(setMember)).join(', ')}. Empty string = no members.`
      : 'MySQL SET column: a comma-separated subset (no spaces) of its declared members. Empty string = no members.';
    return withFamily(Type.String(), PostgresColumnType.TEXT, setAgentInstructions);
  }
  if (dataType === 'date') return withFamily(Type.String({ format: 'date' }), PostgresColumnType.TIMESTAMP);
  if (dataType === 'datetime') {
    // DATETIME has no time zone; the non-asserting local format keeps verbatim values warning-free.
    return withFamily(Type.String({ format: JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT }), PostgresColumnType.TIMESTAMP);
  }
  if (dataType === 'timestamp') return withFamily(Type.String({ format: 'date-time' }), PostgresColumnType.TIMESTAMP);
  if (dataType === 'json') return withFamily(Type.Unknown(), PostgresColumnType.JSONB);
  if (MYSQL_BINARY_DATA_TYPES.has(dataType)) {
    return withFamily(
      Type.String({ contentEncoding: 'base64' }),
      PostgresColumnType.TEXT,
      BINARY_VALUE_AGENT_INSTRUCTIONS,
    );
  }
  if (MYSQL_SPATIAL_DATA_TYPES.has(dataType)) {
    return withFamily(
      Type.String({ contentEncoding: 'base64' }),
      PostgresColumnType.TEXT,
      SPATIAL_VALUE_AGENT_INSTRUCTIONS,
    );
  }
  if (dataType === 'vector') {
    return withFamily(Type.Array(Type.Number()), PostgresColumnType.NUMERIC_ARRAY, VECTOR_VALUE_AGENT_INSTRUCTIONS);
  }
  return withFamily(Type.Unknown(), PostgresColumnType.TEXT);
}

export function isMySqlAutoIncrementColumn(column: MySqlCatalogColumn): boolean {
  return /\bauto_increment\b/i.test(column.extra);
}

/**
 * Columns whose value the server computes: generated columns (`VIRTUAL GENERATED`, `STORED GENERATED`, MariaDB's
 * `PERSISTENT GENERATED`) and MariaDB system-versioning period columns (`ROW START` / `ROW END`, which MariaDB 11.4
 * reports as `STORED GENERATED`). NOT `DEFAULT_GENERATED`: that is MySQL's marker for an expression default such as
 * `DEFAULT CURRENT_TIMESTAMP`, and those columns are freely writable.
 */
export function isMySqlGeneratedColumn(column: MySqlCatalogColumn): boolean {
  return /\b(?:VIRTUAL|STORED|PERSISTENT) GENERATED\b|\bROW (?:START|END)\b/i.test(column.extra);
}

/** INVISIBLE columns (MySQL 8.0.23+, MariaDB 10.3+) — skipped by `SELECT *`; GIPK's `my_row_id` is one. */
export function isMySqlInvisibleColumn(column: MySqlCatalogColumn): boolean {
  return /\bINVISIBLE\b/i.test(column.extra);
}

/**
 * The account's column privileges allow UPDATE. An empty PRIVILEGES value (some proxies / MySQL-compatible servers
 * leave it blank) is treated as unknown rather than "no privileges": the server still enforces the real grants and
 * its rejection is surfaced.
 */
function accountMayUpdateColumn(column: MySqlCatalogColumn): boolean {
  const grantedColumnPrivileges = column.privileges
    .split(',')
    .map((privilege) => privilege.trim().toLowerCase())
    .filter((privilege) => privilege.length > 0);
  return grantedColumnPrivileges.length === 0 || grantedColumnPrivileges.includes('update');
}

/**
 * Read-only in Scratch: AUTO_INCREMENT ids (as Postgres serial/identity), generated and system-versioning columns,
 * columns the account can't UPDATE, and values whose pulled representation can't be written back. A
 * `DEFAULT CURRENT_TIMESTAMP` / `ON UPDATE CURRENT_TIMESTAMP` column stays writable (Live Export maps into
 * existing `created_at` / `updated_at` columns).
 */
export function isMySqlReadOnlyColumn(column: MySqlCatalogColumn, mapping: MySqlColumnTypeMapping): boolean {
  return (
    isMySqlAutoIncrementColumn(column) ||
    isMySqlGeneratedColumn(column) ||
    !accountMayUpdateColumn(column) ||
    mapping.hasNonWritableRepresentation
  );
}

/**
 * Whether a new row may leave the column out: nullable, has a default, or is filled in by the server
 * (AUTO_INCREMENT / generated). AUTO_INCREMENT and generated columns report `COLUMN_DEFAULT NULL` and `NOT NULL`,
 * so the Postgres rule ("has a default") alone would make every locally created row without an id invalid.
 */
export function columnValueMayBeOmittedOnInsert(column: MySqlCatalogColumn): boolean {
  return (
    column.isNullable ||
    column.columnDefault !== null ||
    isMySqlAutoIncrementColumn(column) ||
    isMySqlGeneratedColumn(column)
  );
}

/**
 * The record title column, by the shared SQL convention: the first text column (in table order) named one of
 * `name`, `title`, `display_name`, `label`.
 */
export function pickMySqlTitleColumnPath(columns: readonly MySqlCatalogColumn[]): DotPath | undefined {
  const titleColumn = columns.find(
    (column) =>
      TITLE_COLUMN_CANDIDATES.includes(column.columnName) && MYSQL_TEXT_DATA_TYPES.has(column.dataType.toLowerCase()),
  );
  return titleColumn ? dotPath(titleColumn.columnName) : undefined;
}
