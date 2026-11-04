/**
 * Pure DDL building for the create-schema API on MySQL-protocol servers (Live Export destinations, DEV-12035).
 *
 * Maps the connector-agnostic logical field types (`CreateFieldType`) to MySQL columns and builds the statements.
 * Nothing here connects to a database: the caller passes a knex instance (the live one in `KnexMySqlClient`, a
 * connection-less one in unit tests), so every statement is assertable without a server. The executors live in
 * `mysql-schema-creation-queries.ts`.
 *
 * How this differs from `pg-create-schema.ts`, and why:
 * - Foreign keys are NEVER part of the CREATE TABLE. knex's MySQL dialect emits an inline `foreign()` as a separate
 *   `ALTER TABLE … ADD CONSTRAINT` after the CREATE, and DDL commits implicitly — so a failing constraint would leave
 *   a table without it. Instead each foreign key is added later as ONE hand-assembled
 *   `ALTER TABLE … ADD COLUMN …, ADD CONSTRAINT …` statement, which MySQL and MariaDB apply atomically
 *   (spike-verified: when the constraint fails, the column is not left behind).
 * - A table created for a Live Export carries a comment naming the source table it was created for
 *   ({@link buildMySqlCreatedTableComment}). DDL can't be rolled back, so a save interrupted after the CREATE leaves
 *   the table behind; the retry's CREATE then hits "table exists" (1050) and reuses the table only if it carries that
 *   comment, has the planned columns and is empty ({@link findMySqlLeftoverTableOwnershipMismatch}, then
 *   {@link findMySqlLeftoverTableColumnsMismatch}, then a row check). Tables created for any other request get no
 *   comment and are never reused.
 * - Text-like fields become MEDIUMTEXT, never VARCHAR or TEXT. MySQL's 65,535-byte row limit counts a utf8mb4
 *   VARCHAR(n) as 4·n bytes (about 64 × VARCHAR(255) already fails with 1118), and TEXT caps a VALUE at 65,535
 *   bytes (strict mode rejects longer ones with 1406). MEDIUMTEXT costs the same ~40 in-row bytes as TEXT.
 * - `ENGINE=InnoDB` and `CHARSET utf8mb4` are explicit: InnoDB is the only engine our write guards support, and
 *   knex would otherwise fall back to the connection's `charset` option — a collation name in mysql2, which would
 *   produce invalid DDL.
 * - Every identifier segment (database, table, column) is sentinel-encoded, so `.`, ` as ` and `?` in a name reach
 *   MySQL verbatim inside backticks (Connector Prime Directive: names are never folded or renamed here). Characters
 *   MySQL can't hold in a name are removed earlier, by plan generation, from `nameCharacterRules` (DEV-12413).
 */
import { CREATE_FIELD_KINDS, isDataFolderId, type SchemaCreationCapabilities } from '@spinner/shared-types';
import { createHash } from 'crypto';
import { type Knex } from 'knex';
import { assertUnreachable } from 'src/utils/asserts';
import { type ResolvedCreateFieldSpec } from '../../schema-creation.types';
import { MySqlClientError, MySqlClientProblem } from './mysql-client-error';
import { encodeMySqlIdentifierForKnex, qualifiedMySqlTableReferenceForKnex } from './mysql-identifier-quoting';
import {
  isMySqlTextOrBlobOrJsonColumnType,
  isRecreatableMySqlNativeColumnType,
  MYSQL_NATIVE_TYPE_SYSTEM,
  mysqlColumnHasNonWritableRepresentation,
} from './mysql-native-column-type';
import { type MySqlTableReference } from './mysql-types';

/**
 * The auto-generated primary key injected into every created table: `bigint unsigned auto_increment`. It must be
 * AUTO_INCREMENT — MySQL has no `INSERT … RETURNING`, so the connector learns a new row's id only from `insertId`,
 * and `listTables` offers creates only on tables whose primary key is AUTO_INCREMENT. (A `DEFAULT (uuid())` id
 * would report `insertId = 0`, making the new row unfindable.) UNSIGNED BIGINT never runs out; it reads back as a
 * decimal string, like Postgres `bigint`.
 */
export const MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME = 'id';

/** MySQL's identifier length limit (database, table, column, constraint and index names), in characters. */
export const MYSQL_MAX_IDENTIFIER_LENGTH = 64;

/**
 * Created-table field cap. InnoDB's DYNAMIC row format keeps ~40 bytes in-row per off-page TEXT/JSON column,
 * against a ~8,126-byte in-page row limit: spike-verified, MySQL 8.4 creates and fills 190 MEDIUMTEXT columns but
 * not 200 (1118); MariaDB 11.4 handles 200. 180 leaves headroom for the injected id and wider numeric columns.
 */
export const MYSQL_MAX_FIELDS_PER_CREATED_TABLE = 180;

/** Integer headroom added to a requested decimal scale: `decimal(scale + 8, scale)` (Postgres parity). */
const MYSQL_DECIMAL_PRECISION_HEADROOM = 8;

/** Default scale of a `currency` field without a requested precision (money-style 4 decimal places). */
const MYSQL_DEFAULT_CURRENCY_SCALE = 4;

/**
 * MySQL has no unbounded DECIMAL (a bare `DECIMAL` means `DECIMAL(10,0)` and would round every fraction away), so a
 * decimal field without a requested precision gets the widest column MySQL allows.
 */
const MYSQL_WIDEST_DECIMAL_COLUMN_TYPE = 'decimal(65,30)';

/** Columns created for logical kinds. Constants only: nothing from a plan is ever interpolated into these. */
const MYSQL_TEXT_COLUMN_TYPE = 'mediumtext';
const MYSQL_LONG_TEXT_COLUMN_TYPE = 'longtext';
const MYSQL_BOOLEAN_COLUMN_TYPE = 'tinyint(1)';
const MYSQL_INTEGER_COLUMN_TYPE = 'int';
const MYSQL_FLOATING_POINT_COLUMN_TYPE = 'double';
const MYSQL_JSON_COLUMN_TYPE = 'json';
const MYSQL_DATE_COLUMN_TYPE = 'date';
/** DATETIME, not TIMESTAMP: TIMESTAMP only covers 1970–2038. Millisecond precision matches JS / ISO 8601 values. */
const MYSQL_DATE_TIME_COLUMN_TYPE = 'datetime(3)';

/**
 * Connector-declared capabilities consumed by the generic create-schema validator and plan generator.
 * - multiSelect is unsupported: MySQL has no list column (SET needs its members baked into the DDL). A raw
 *   list-shaped source gets a JSON column instead (a list a codec emits still flattens to text).
 * - `supportedArrayElementKinds` is omitted on purpose (= no array fields): arrays land in a JSON column, which reads
 *   back marked `jsonb`, so the transform picker copies the array in whole (`acceptsAnyJsonValue`).
 */
export const MYSQL_SCHEMA_CREATION_CAPABILITIES: SchemaCreationCapabilities = {
  supportedFieldKinds: CREATE_FIELD_KINDS.filter((fieldKind) => fieldKind !== 'multiSelect'),
  primaryField: null,
  maxTableNameLength: MYSQL_MAX_IDENTIFIER_LENGTH,
  maxFieldNameLength: MYSQL_MAX_IDENTIFIER_LENGTH,
  maxFieldsPerTable: MYSQL_MAX_FIELDS_PER_CREATED_TABLE,
  // The injected AUTO_INCREMENT primary key owns this name; the plan generator renames a colliding source field.
  reservedFieldNames: [MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME],
  // A foreign key becomes one scalar column referencing the target's id: the one-side of a 1→N link only.
  supportsManyToManyForeignKeys: false,
  // Table names are unique per database (1050).
  requiresUniqueTableNames: true,
  // A source column annotated with its exact MySQL type (MySQL, MariaDB, TiDB, ...) is recreated with that type.
  nativeTypeSystem: MYSQL_NATIVE_TYPE_SYSTEM,
  // The character rules of findMySqlIdentifierProblem, so plan generation removes what MySQL would refuse (DEV-12413).
  nameCharacterRules: { basicMultilingualPlaneOnly: true, noControlCharacters: true, noTrailingSpace: true },
};

/**
 * Why MySQL can't use `identifier` as a table or column name, or `undefined` when it can. Checked up front so the
 * user gets a precise reason instead of an opaque server error — and because the connector never renames a column
 * (`findCreatedDestinationField` resolves created fields by the requested name, so a silent rename would break the
 * sync draft). Plan generation already removes the characters these rules forbid
 * (`MYSQL_SCHEMA_CREATION_CAPABILITIES.nameCharacterRules`), so this mostly catches a name a person typed. Rules
 * (MySQL "Schema Object Names"):
 * - at most 64 characters;
 * - no control characters (U+0000 is illegal in MySQL; U+0000/U+0001 are also our knex identifier sentinels, so a
 *   raw one would be decoded into a different name);
 * - nothing outside the Basic Multilingual Plane (emoji): MySQL identifiers are BMP-only;
 * - no trailing space.
 */
export function findMySqlIdentifierProblem(identifier: string, identifierRole: 'table' | 'column'): string | undefined {
  const identifierRoleLabel = identifierRole === 'table' ? 'table name' : 'field name';
  if (identifier.trim().length === 0) {
    return `the ${identifierRoleLabel} is empty — give it a name in the plan`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(identifier)) {
    return `the ${identifierRoleLabel} ${JSON.stringify(identifier)} contains a control character, which MySQL can't use in a name — rename it in the plan`;
  }
  const identifierCodePoints = [...identifier];
  if (identifierCodePoints.some((character) => (character.codePointAt(0) ?? 0) > 0xffff)) {
    return `the ${identifierRoleLabel} "${identifier}" contains a character MySQL can't use in a name (emoji and other characters outside the Basic Multilingual Plane) — rename it in the plan`;
  }
  if (identifier.endsWith(' ')) {
    return `the ${identifierRoleLabel} "${identifier}" ends with a space, which MySQL doesn't allow in a name — remove the trailing space in the plan`;
  }
  if (identifierCodePoints.length > MYSQL_MAX_IDENTIFIER_LENGTH) {
    return `the ${identifierRoleLabel} "${identifier}" is ${identifierCodePoints.length} characters long; MySQL allows at most ${MYSQL_MAX_IDENTIFIER_LENGTH} — shorten it in the plan`;
  }
  return undefined;
}

/** Everything {@link buildMySqlCreatedTableComment} can produce, re-checked before the comment reaches DDL. */
const MYSQL_CREATED_TABLE_COMMENT_PATTERN = /^live_export:dfd_[0-9A-Za-z]{10}$/;

/**
 * The comment written on a table created for a Live Export: `live_export:<ref>`, where `<ref>` is the create
 * request's ref, the Live Export's source data folder id. It is the same on every attempt of a save, so a retry can
 * tell its own leftover table from a table someone else made. `undefined` for any other ref: other callers choose
 * their own refs (the dev tools send `table_1`, `table_2`, ...), which repeat across requests, so their tables get no
 * comment and are never reused. knex writes a table comment into the DDL without escaping it, so only a ref in the
 * data folder id alphabet is used.
 */
export function buildMySqlCreatedTableComment(createRef: string): string | undefined {
  if (!isDataFolderId(createRef)) return undefined;
  const tableComment = `live_export:${createRef}`;
  return MYSQL_CREATED_TABLE_COMMENT_PATTERN.test(tableComment) ? tableComment : undefined;
}

/** The lower-cased `[a-z0-9_]` rendering of a name, cut to `maximumLength`, for a readable constraint name. */
function foldNameIntoConstraintNameSegment(name: string, maximumLength: number): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maximumLength)
    .replace(/_+$/, '');
}

const MYSQL_FOREIGN_KEY_CONSTRAINT_NAME_SEGMENT_MAX_LENGTH = 24;
const MYSQL_FOREIGN_KEY_CONSTRAINT_NAME_HASH_LENGTH = 8;

/**
 * The name of the foreign-key constraint Scratch creates for `columnName` on `tableName`:
 * `fk_<table slice>_<column slice>_<8 hex of sha256(table NUL column)>` — at most 3 + 24 + 1 + 24 + 1 + 8 = 61
 * characters. knex's default `<table>_<column>_foreign` exceeds MySQL's 64-character limit for long names (1059),
 * and constraint names must be unique per DATABASE in InnoDB (1826), which the (table, column) hash guarantees in
 * practice. Deterministic, so a retry targets the same name. Only `[a-z0-9_]` reaches the DDL.
 */
export function buildMySqlForeignKeyConstraintName(tableName: string, columnName: string): string {
  const tableNameSegment = foldNameIntoConstraintNameSegment(
    tableName,
    MYSQL_FOREIGN_KEY_CONSTRAINT_NAME_SEGMENT_MAX_LENGTH,
  );
  const columnNameSegment = foldNameIntoConstraintNameSegment(
    columnName,
    MYSQL_FOREIGN_KEY_CONSTRAINT_NAME_SEGMENT_MAX_LENGTH,
  );
  const tableAndColumnHash = createHash('sha256')
    .update(`${tableName}\u0000${columnName}`, 'utf8')
    .digest('hex')
    .slice(0, MYSQL_FOREIGN_KEY_CONSTRAINT_NAME_HASH_LENGTH);
  return `fk_${tableNameSegment}_${columnNameSegment}_${tableAndColumnHash}`;
}

/** A foreign key whose target table and referenced column were introspected and can be created. */
export type ResolvedMySqlForeignKey = {
  kind: 'resolved';
  /** The target table as MySQL stores it (catalog spelling). */
  targetTable: MySqlTableReference;
  /** The target's uniquely addressable column (the same one the read side uses as the table's `idPath`). */
  targetColumnName: string;
  /** The FK column's type: the target column's exact type plus its character set / collation, e.g. `varchar(2) CHARACTER SET latin1 COLLATE latin1_swedish_ci`. */
  foreignKeyColumnTypeDefinition: string;
};

/** A foreign key the connector can't create, with a user-facing reason (reported as a per-field skip). */
export type MySqlForeignKeyResolution = ResolvedMySqlForeignKey | { kind: 'unresolvable'; reason: string };

/** Character-set and collation names only ever consist of these characters; anything else never reaches DDL. */
const MYSQL_CHARACTER_SET_OR_COLLATION_NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * The column type a foreign key referencing a column of `target` must have. MySQL requires the same type (incl.
 * `unsigned`) and, for character columns, the same character set and collation (else 3780 / MariaDB 1005), so both
 * are carried over explicitly. Returns a reason when the target can't be referenced:
 * - TEXT / BLOB / JSON: MySQL can't reference them (they need a prefix index);
 * - a type pulled in a non-writable representation (BINARY as base64, BIT as a number): the FK column would store
 *   the pulled text, not the target's bytes, so no reference would ever match;
 * - a type outside the recreatable grammar/allowlist (ENUM, SET, ZEROFILL, MariaDB UUID, ...);
 * - a character set or collation name that isn't plain `[a-z0-9_]`.
 * The result is interpolated into DDL, so it is assembled ONLY from values that passed those checks.
 */
export function buildMySqlForeignKeyColumnTypeDefinition(target: {
  columnType: string;
  characterSetName: string | null;
  collationName: string | null;
}): { foreignKeyColumnTypeDefinition: string } | { unreferenceableReason: string } {
  const targetColumnType = target.columnType.trim().toLowerCase();
  if (isMySqlTextOrBlobOrJsonColumnType(targetColumnType)) {
    return {
      unreferenceableReason: `has type ${targetColumnType}, which a MySQL foreign key can't reference (TEXT, BLOB and JSON columns can't be foreign-key targets)`,
    };
  }
  if (mysqlColumnHasNonWritableRepresentation(targetColumnType)) {
    return {
      unreferenceableReason: `has type ${targetColumnType}, whose values Scratch reads as encoded text, so a foreign key column couldn't hold matching values`,
    };
  }
  if (!isRecreatableMySqlNativeColumnType(targetColumnType)) {
    return {
      unreferenceableReason: `has type ${targetColumnType}, which Scratch can't recreate for a foreign key column`,
    };
  }
  const characterSetAndCollationNames = [target.characterSetName, target.collationName].filter(
    (name): name is string => name !== null,
  );
  if (!characterSetAndCollationNames.every((name) => MYSQL_CHARACTER_SET_OR_COLLATION_NAME_PATTERN.test(name))) {
    return {
      unreferenceableReason: `uses a character set or collation (${characterSetAndCollationNames.join(' / ')}) Scratch can't copy onto a foreign key column`,
    };
  }
  const characterSetClause = target.characterSetName !== null ? ` CHARACTER SET ${target.characterSetName}` : '';
  const collationClause = target.collationName !== null ? ` COLLATE ${target.collationName}` : '';
  return { foreignKeyColumnTypeDefinition: `${targetColumnType}${characterSetClause}${collationClause}` };
}

/**
 * Re-validate a foreign-key column type definition right before it is interpolated into DDL: the exact shape
 * {@link buildMySqlForeignKeyColumnTypeDefinition} produces, and nothing else.
 */
function isSafeMySqlForeignKeyColumnTypeDefinition(foreignKeyColumnTypeDefinition: string): boolean {
  const definitionMatch =
    /^(?<columnType>.+?)(?: CHARACTER SET (?<characterSetName>[a-z0-9_]+))?(?: COLLATE (?<collationName>[a-z0-9_]+))?$/.exec(
      foreignKeyColumnTypeDefinition,
    );
  const columnType = definitionMatch?.groups?.columnType;
  return (
    columnType !== undefined &&
    columnType === columnType.toLowerCase() &&
    isRecreatableMySqlNativeColumnType(columnType) &&
    !isMySqlTextOrBlobOrJsonColumnType(columnType) &&
    !mysqlColumnHasNonWritableRepresentation(columnType)
  );
}

/** How one field becomes a column, or why it can't. */
export type MySqlCreateFieldColumnDefinition =
  | { outcome: 'column'; columnTypeSpelling: string; isNullable: boolean }
  | { outcome: 'skipped'; skipReason: string };

function mysqlColumnTypeForNumberField(
  fieldType: Extract<ResolvedCreateFieldSpec['fieldType'], { kind: 'number' }>,
): string {
  const numberFormat = fieldType.format ?? 'plain';
  switch (numberFormat) {
    case 'integer':
      // Postgres `integer` parity: reads back as a JS number, so an "adopted" existing column keeps matching.
      // Strict mode fails an out-of-range value loudly (1264) instead of clamping it.
      return MYSQL_INTEGER_COLUMN_TYPE;
    case 'decimal':
      return fieldType.precision !== undefined
        ? `decimal(${fieldType.precision + MYSQL_DECIMAL_PRECISION_HEADROOM},${fieldType.precision})`
        : MYSQL_WIDEST_DECIMAL_COLUMN_TYPE;
    case 'plain':
    case 'percent':
      return MYSQL_FLOATING_POINT_COLUMN_TYPE;
    default:
      return assertUnreachable(numberFormat);
  }
}

/** The MySQL column type for a field's logical kind, or why the kind has no MySQL column. */
function resolveMySqlColumnTypeForLogicalFieldType(
  field: ResolvedCreateFieldSpec,
): { columnTypeSpelling: string } | { skipReason: string } {
  const fieldType = field.fieldType;
  switch (fieldType.kind) {
    // Select options are not enforced (no ENUM/CHECK), matching Postgres: the column accepts any option name.
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
    case 'select':
      return { columnTypeSpelling: MYSQL_TEXT_COLUMN_TYPE };
    case 'longText':
      return { columnTypeSpelling: MYSQL_LONG_TEXT_COLUMN_TYPE };
    case 'boolean':
      // MySQL's BOOLEAN is TINYINT(1); it reads back as 0/1 and the transform picker coerces true → 1.
      return { columnTypeSpelling: MYSQL_BOOLEAN_COLUMN_TYPE };
    case 'number':
      return { columnTypeSpelling: mysqlColumnTypeForNumberField(fieldType) };
    case 'currency': {
      // currencyCode is metadata only; the amount is a scaled DECIMAL.
      const currencyScale = fieldType.precision ?? MYSQL_DEFAULT_CURRENCY_SCALE;
      return { columnTypeSpelling: `decimal(${currencyScale + MYSQL_DECIMAL_PRECISION_HEADROOM},${currencyScale})` };
    }
    case 'json':
      // On MariaDB this is an alias for LONGTEXT + a json_valid CHECK, which the read side still reports as JSON.
      return { columnTypeSpelling: MYSQL_JSON_COLUMN_TYPE };
    case 'date':
      return { columnTypeSpelling: fieldType.includesTime ? MYSQL_DATE_TIME_COLUMN_TYPE : MYSQL_DATE_COLUMN_TYPE };
    case 'multiSelect':
      return {
        skipReason: `field "${field.name}" is a multi-select, but MySQL has no list column — send it as text or JSON instead`,
      };
    case 'foreignKey':
      // Only reachable through a caller bug: foreign keys are added by their own atomic ALTER TABLE statement.
      return {
        skipReason: `foreign key "${field.name}" can't be created as a plain column — the MySQL connector adds foreign keys in a separate step`,
      };
    default:
      return assertUnreachable(fieldType);
  }
}

/**
 * Decide how `field` becomes a column (type + NULL / NOT NULL), or why it is skipped. Skip checks, in order:
 * the reserved `id` name (only when creating a table: an existing table has no injected key, and a real clash
 * surfaces as 1060), an identifier MySQL can't use, a list field (`isArray`, defensive: the capabilities declare no
 * array kinds, so the validator should have rejected it), a multi-select (likewise).
 *
 * A same-type-system native type (`nativeFieldType.typeSystem === 'mysql'`, e.g. MySQL → MySQL) is recreated
 * exactly — but the plan arrives from a client, so the type is re-checked against the recreatable grammar and
 * allowlist before it can reach raw DDL; a type outside it skips the field rather than being interpolated.
 * A native type from another type system is ignored in favour of the logical kind.
 */
export function resolveMySqlColumnDefinitionForCreateField(
  field: ResolvedCreateFieldSpec,
  context: { isCreatingTable: boolean },
): MySqlCreateFieldColumnDefinition {
  if (context.isCreatingTable && field.name.trim().toLowerCase() === MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME) {
    return {
      outcome: 'skipped',
      skipReason: `field name "${field.name}" is reserved — the MySQL connector injects an auto-generated "${MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME}" primary key column`,
    };
  }
  const identifierProblem = findMySqlIdentifierProblem(field.name, 'column');
  if (identifierProblem !== undefined) {
    return { outcome: 'skipped', skipReason: identifierProblem };
  }
  const fieldType = field.fieldType;
  if ('isArray' in fieldType && fieldType.isArray === true) {
    return {
      outcome: 'skipped',
      skipReason: `field "${field.name}" is a list, but MySQL has no list column — send it as text or JSON instead`,
    };
  }
  const isNullable = field.required !== true;

  if (field.nativeFieldType?.typeSystem === MYSQL_NATIVE_TYPE_SYSTEM && fieldType.kind !== 'foreignKey') {
    const nativeColumnTypeSpelling = field.nativeFieldType.type.trim().toLowerCase();
    if (!isRecreatableMySqlNativeColumnType(nativeColumnTypeSpelling)) {
      return {
        outcome: 'skipped',
        skipReason: `field "${field.name}" asks for native MySQL type "${field.nativeFieldType.type}", which the MySQL connector can't create — remove the native type to create it from its logical type instead`,
      };
    }
    // An explicit NULL matters for TIMESTAMP: with explicit_defaults_for_timestamp=OFF (MySQL 5.7, MariaDB
    // < 10.10) the first TIMESTAMP column otherwise silently becomes NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE.
    return { outcome: 'column', columnTypeSpelling: nativeColumnTypeSpelling, isNullable };
  }

  const logicalColumnType = resolveMySqlColumnTypeForLogicalFieldType(field);
  if ('skipReason' in logicalColumnType) {
    return { outcome: 'skipped', skipReason: logicalColumnType.skipReason };
  }
  return { outcome: 'column', columnTypeSpelling: logicalColumnType.columnTypeSpelling, isNullable };
}

/** Add a resolved column to a CREATE / ALTER table builder, with an explicit NULL or NOT NULL. */
function addColumnDefinitionToTableBuilder(
  tableBuilder: Knex.CreateTableBuilder | Knex.AlterTableBuilder,
  columnName: string,
  columnDefinition: Extract<MySqlCreateFieldColumnDefinition, { outcome: 'column' }>,
): void {
  const columnBuilder = tableBuilder.specificType(
    encodeMySqlIdentifierForKnex(columnName),
    columnDefinition.columnTypeSpelling,
  );
  if (columnDefinition.isNullable) {
    columnBuilder.nullable();
  } else {
    columnBuilder.notNullable();
  }
}

/**
 * Refuse a table address whose names can't be emitted verbatim: the table name must pass
 * {@link findMySqlIdentifierProblem}, and neither name may contain a control character (U+0000/U+0001 are the
 * knex identifier sentinels — a raw one would be decoded into a DIFFERENT name, creating or altering the wrong
 * table). The connector validates the table name up front; this is the last line of defence before DDL.
 */
function assertMySqlTableReferenceCanBeUsedInDdl(table: MySqlTableReference): void {
  const tableNameProblem = findMySqlIdentifierProblem(table.tableName, 'table');
  if (tableNameProblem !== undefined) {
    throw new MySqlClientError(
      MySqlClientProblem.InvalidSchemaCreationRequest,
      `Can't create "${table.tableName}": ${tableNameProblem}.`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(table.databaseName)) {
    throw new MySqlClientError(
      MySqlClientProblem.InvalidSchemaCreationRequest,
      `The database name ${JSON.stringify(table.databaseName)} contains a control character Scratch can't address.`,
    );
  }
}

/**
 * `CREATE TABLE \`db\`.\`table\` (id bigint unsigned not null auto_increment primary key, …) DEFAULT CHARACTER SET
 * utf8mb4 ENGINE = InnoDB [COMMENT = '<tableComment>']`. Fields that can't become a column are recorded in
 * `skipReasonByFieldName` (keyed by field name) instead of failing the statement; the map is filled when knex
 * compiles the builder (on `.toSQL()` or when it is awaited). Foreign-key fields must not be passed: they are added
 * afterwards with {@link buildAddMySqlForeignKeyColumnStatement} (one reaching here is skipped, never silently
 * dropped). `tableComment` must come from {@link buildMySqlCreatedTableComment} (knex doesn't escape it); without
 * one the table gets no comment.
 */
export function buildCreateMySqlTableQuery(
  knex: Knex,
  table: MySqlTableReference,
  nonForeignKeyFields: ResolvedCreateFieldSpec[],
  skipReasonByFieldName: Map<string, string>,
  tableComment: string | undefined,
): Knex.SchemaBuilder {
  assertMySqlTableReferenceCanBeUsedInDdl(table);
  if (tableComment !== undefined && !MYSQL_CREATED_TABLE_COMMENT_PATTERN.test(tableComment)) {
    throw new MySqlClientError(
      MySqlClientProblem.InvalidSchemaCreationRequest,
      `Can't create "${table.tableName}": its table comment isn't one Scratch builds.`,
    );
  }
  return knex.schema
    .withSchema(encodeMySqlIdentifierForKnex(table.databaseName))
    .createTable(encodeMySqlIdentifierForKnex(table.tableName), (tableBuilder) => {
      tableBuilder.bigIncrements(encodeMySqlIdentifierForKnex(MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME), {
        primaryKey: true,
      });
      for (const field of nonForeignKeyFields) {
        const columnDefinition = resolveMySqlColumnDefinitionForCreateField(field, { isCreatingTable: true });
        if (columnDefinition.outcome === 'skipped') {
          skipReasonByFieldName.set(field.name, columnDefinition.skipReason);
          continue;
        }
        addColumnDefinitionToTableBuilder(tableBuilder, field.name, columnDefinition);
      }
      tableBuilder.engine('InnoDB');
      tableBuilder.charset('utf8mb4');
      if (tableComment !== undefined) tableBuilder.comment(tableComment);
    });
}

/**
 * `ALTER TABLE \`db\`.\`table\` ADD \`column\` <type> NULL|NOT NULL` for one non-foreign-key field (createFields
 * runs one statement per field, so a bad field fails alone). A skipped field is recorded in `skipReasonByFieldName`
 * and adds no column; the caller must not execute a builder whose field was skipped (it would be an empty ALTER).
 */
export function buildAddMySqlColumnQuery(
  knex: Knex,
  table: MySqlTableReference,
  field: ResolvedCreateFieldSpec,
  skipReasonByFieldName: Map<string, string>,
): Knex.SchemaBuilder {
  assertMySqlTableReferenceCanBeUsedInDdl(table);
  return knex.schema
    .withSchema(encodeMySqlIdentifierForKnex(table.databaseName))
    .alterTable(encodeMySqlIdentifierForKnex(table.tableName), (tableBuilder) => {
      const columnDefinition = resolveMySqlColumnDefinitionForCreateField(field, { isCreatingTable: false });
      if (columnDefinition.outcome === 'skipped') {
        skipReasonByFieldName.set(field.name, columnDefinition.skipReason);
        return;
      }
      addColumnDefinitionToTableBuilder(tableBuilder, field.name, columnDefinition);
    });
}

/**
 * One atomic statement that adds a foreign-key column AND its constraint:
 * `ALTER TABLE ?? ADD COLUMN ?? <type> NULL, ADD CONSTRAINT ?? FOREIGN KEY (??) REFERENCES ?? (??) ON DELETE SET NULL`.
 * knex's builder would split the constraint into a second statement, so a failing constraint would leave the column
 * behind; hand-assembled, MySQL applies both or neither (spike-verified on MySQL 8.4 and MariaDB 11.4). The `??`
 * identifiers are inlined by knex (no value bindings), each segment sentinel-encoded. The column is always nullable
 * (so ON DELETE SET NULL is valid; `required` is ignored, Postgres parity) and typed like the referenced column.
 *
 * Throws `MySqlClientError(InvalidSchemaCreationRequest)` — never emits DDL — for a field that isn't a single-valued
 * foreign key, a column name MySQL can't use, or a type definition / target name that isn't exactly what the
 * resolver produces. No `foreign_key_checks = 0`: the new column is all-NULL, and managed services (Vitess /
 * PlanetScale) may refuse the session variable.
 */
export function buildAddMySqlForeignKeyColumnStatement(
  knex: Knex,
  table: MySqlTableReference,
  field: ResolvedCreateFieldSpec,
  resolution: ResolvedMySqlForeignKey,
): Knex.Raw {
  assertMySqlTableReferenceCanBeUsedInDdl(table);
  if (field.fieldType.kind !== 'foreignKey' || field.fieldType.allowMultiple === true) {
    throw new MySqlClientError(
      MySqlClientProblem.InvalidSchemaCreationRequest,
      `Field "${field.name}" isn't a single-valued foreign key, so it can't be added as a MySQL foreign key column.`,
    );
  }
  const columnNameProblem = findMySqlIdentifierProblem(field.name, 'column');
  if (columnNameProblem !== undefined) {
    throw new MySqlClientError(MySqlClientProblem.InvalidSchemaCreationRequest, `Can't create ${columnNameProblem}.`);
  }
  const targetNames = [
    resolution.targetTable.databaseName,
    resolution.targetTable.tableName,
    resolution.targetColumnName,
  ];
  if (
    // eslint-disable-next-line no-control-regex
    targetNames.some((targetName) => targetName.length === 0 || /[\u0000-\u001f\u007f]/.test(targetName)) ||
    !isSafeMySqlForeignKeyColumnTypeDefinition(resolution.foreignKeyColumnTypeDefinition)
  ) {
    throw new MySqlClientError(
      MySqlClientProblem.InvalidSchemaCreationRequest,
      `Couldn't create foreign key "${field.name}": the linked table's id column couldn't be described safely.`,
    );
  }
  const encodedForeignKeyColumnName = encodeMySqlIdentifierForKnex(field.name);
  return knex.raw(
    `ALTER TABLE ?? ADD COLUMN ?? ${resolution.foreignKeyColumnTypeDefinition} NULL, ` +
      `ADD CONSTRAINT ?? FOREIGN KEY (??) REFERENCES ?? (??) ON DELETE SET NULL`,
    [
      qualifiedMySqlTableReferenceForKnex(table),
      encodedForeignKeyColumnName,
      encodeMySqlIdentifierForKnex(buildMySqlForeignKeyConstraintName(table.tableName, field.name)),
      encodedForeignKeyColumnName,
      qualifiedMySqlTableReferenceForKnex(resolution.targetTable),
      encodeMySqlIdentifierForKnex(resolution.targetColumnName),
    ],
  );
}

/**
 * MySQL server error numbers the schema-creation path turns into specific messages. Keyed by `errno` (stable
 * across MySQL / MariaDB / TiDB), never by message text.
 */
const MYSQL_SCHEMA_CREATION_ERROR_NUMBERS = {
  databaseAccessDenied: 1044, // ER_DBACCESS_DENIED_ERROR
  cannotCreateTable: 1005, // ER_CANT_CREATE_TABLE (MariaDB's foreign-key failure, errno 150)
  unknownDatabase: 1049, // ER_BAD_DB_ERROR
  tableExists: 1050, // ER_TABLE_EXISTS_ERROR
  identifierTooLong: 1059, // ER_TOO_LONG_IDENT
  duplicateColumnName: 1060, // ER_DUP_FIELDNAME
  incorrectTableName: 1103, // ER_WRONG_TABLE_NAME
  unknownError: 1105, // ER_UNKNOWN_ERROR (Vitess / PlanetScale report refused foreign keys with it)
  tooManyColumns: 1117, // ER_TOO_MANY_FIELDS
  rowTooLarge: 1118, // ER_TOO_BIG_ROWSIZE
  tableCommandDenied: 1142, // ER_TABLEACCESS_DENIED_ERROR
  noSuchTable: 1146, // ER_NO_SUCH_TABLE
  incorrectColumnName: 1166, // ER_WRONG_COLUMN_NAME
  lockWaitTimeout: 1205, // ER_LOCK_WAIT_TIMEOUT (also a metadata-lock wait over lock_wait_timeout)
  cannotAddForeignKey: 1215, // ER_CANNOT_ADD_FOREIGN
  specificAccessDenied: 1227, // ER_SPECIFIC_ACCESS_DENIED_ERROR
  optionPreventsStatement: 1290, // ER_OPTION_PREVENTS_STATEMENT (--read-only / --super-read-only)
  readOnlyTransaction: 1792, // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
  foreignKeyMissingParentIndex: 1822, // ER_FK_NO_INDEX_PARENT
  foreignKeyCannotOpenParent: 1824, // ER_FK_CANNOT_OPEN_PARENT
  foreignKeyDuplicateName: 1826, // ER_FK_DUP_NAME
  readOnlyMode: 1836, // ER_READ_ONLY_MODE
  foreignKeyIncompatibleColumns: 3780, // ER_FK_INCOMPATIBLE_COLUMNS (MySQL 8)
  foreignKeyMissingUniqueKey: 6125, // ER_FK_NO_UNIQUE_INDEX_PARENT (MySQL 8.4 restrict_fk_on_non_standard_key)
  foreignKeyOnPartitionedTable: 1506, // ER_FOREIGN_KEY_ON_PARTITIONED
  foreignKeyOnVirtualColumn: 3733, // ER_FK_CANNOT_USE_VIRTUAL_COLUMN
} as const;

const MYSQL_FOREIGN_KEY_REJECTION_ERROR_NUMBERS: ReadonlySet<number> = new Set([
  MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.cannotAddForeignKey,
  MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.foreignKeyMissingParentIndex,
  MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.foreignKeyCannotOpenParent,
  MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.foreignKeyIncompatibleColumns,
  MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.foreignKeyMissingUniqueKey,
  MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.foreignKeyOnPartitionedTable,
  MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.foreignKeyOnVirtualColumn,
]);

/**
 * `<VERB> command denied to user …` (1142): the verbs Scratch's DDL can be denied, mapped to what the user was
 * trying to do. Only a verb from this allowlist is ever used; nothing else from the server message is shown (it
 * carries `'user'@'client-ip'`).
 */
const MYSQL_DENIED_SCHEMA_COMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  CREATE: 'create tables',
  ALTER: 'change tables',
  REFERENCES: 'create foreign keys',
  INDEX: 'create indexes',
};

function readMySqlServerErrorNumber(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const errorNumber = (error as { errno?: unknown }).errno;
  return typeof errorNumber === 'number' ? errorNumber : undefined;
}

/** The server's own message, read ONLY for fixed-pattern tests (never shown to the user). */
function readMySqlServerErrorMessageForPatternTests(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const serverErrorMessage = (error as { sqlMessage?: unknown }).sqlMessage;
  return typeof serverErrorMessage === 'string' ? serverErrorMessage : '';
}

/** True when `error` is MySQL's "table already exists" (1050) — raised only by CREATE TABLE / RENAME. */
export function isMySqlDuplicateTableError(error: unknown): boolean {
  return readMySqlServerErrorNumber(error) === MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.tableExists;
}

/** True when `error` is MySQL's "duplicate column name" (1060) — an ALTER adding a column that already exists. */
export function isMySqlDuplicateColumnError(error: unknown): boolean {
  return readMySqlServerErrorNumber(error) === MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.duplicateColumnName;
}

/**
 * A `COLUMN_TYPE` spelling reduced to what matters when comparing a column with the one Scratch would create:
 * lower-cased, single-spaced, and without integer display widths. MariaDB (and MySQL before 8.0.19) report
 * `int(11)` and `bigint(20) unsigned` where MySQL 8 reports `int` and `bigint unsigned`; the width changes nothing
 * about the column. `tinyint(1)` keeps its width: it is the boolean spelling on every server.
 */
export function normalizeMySqlColumnTypeForComparison(columnType: string): string {
  const normalizedColumnType = columnType.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^tinyint\(1\)(?: |$)/.test(normalizedColumnType)) return normalizedColumnType;
  return normalizedColumnType.replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/, '$1');
}

/** A column as the catalog reports it, for comparing with the column Scratch would create. */
export interface MySqlExistingColumnShape {
  readonly columnName: string;
  /** `COLUMN_TYPE` verbatim. */
  readonly columnType: string;
  readonly isNullable: boolean;
}

/**
 * Whether an existing column is the one {@link resolveMySqlColumnDefinitionForCreateField} would create: the same
 * type (see {@link normalizeMySqlColumnTypeForComparison}) and nullability. MariaDB stores a JSON column as LONGTEXT
 * (with a `json_valid` check), so `longtext` matches a planned `json`.
 */
export function doesMySqlColumnMatchCreateDefinition(
  existingColumn: Pick<MySqlExistingColumnShape, 'columnType' | 'isNullable'>,
  columnDefinition: Extract<MySqlCreateFieldColumnDefinition, { outcome: 'column' }>,
): boolean {
  const existingColumnType = normalizeMySqlColumnTypeForComparison(existingColumn.columnType);
  const plannedColumnType = normalizeMySqlColumnTypeForComparison(columnDefinition.columnTypeSpelling);
  const typesMatch =
    existingColumnType === plannedColumnType ||
    (plannedColumnType === MYSQL_JSON_COLUMN_TYPE && existingColumnType === MYSQL_LONG_TEXT_COLUMN_TYPE);
  return typesMatch && existingColumn.isNullable === columnDefinition.isNullable;
}

/** What the catalog's TABLES row says about a table that blocked a CREATE TABLE with 1050. */
export interface MySqlLeftoverTableRow {
  /** `TABLE_TYPE`: `BASE TABLE`, `VIEW`, `SYSTEM VERSIONED`, ... */
  readonly tableType: string;
  readonly storageEngine: string | null;
  readonly tableComment: string;
}

/** A column of that table, as the catalog reports it. */
export type MySqlLeftoverTableColumn = MySqlExistingColumnShape & {
  readonly columnKey: string;
  readonly extra: string;
};

/**
 * Why a table that blocked a CREATE TABLE (1050) is NOT one this request created, judged from its TABLES row alone,
 * or `undefined` when it is: an InnoDB base table carrying exactly `expectedTableComment`
 * ({@link buildMySqlCreatedTableComment}), so a table the user made, or another export's table, is never taken
 * over. The first check, so nothing else about a table that isn't ours is ever read.
 */
export function findMySqlLeftoverTableOwnershipMismatch(
  tableRow: MySqlLeftoverTableRow,
  expectedTableComment: string,
): string | undefined {
  if (tableRow.tableType.toUpperCase() !== 'BASE TABLE') return `it is a ${tableRow.tableType}, not a base table`;
  if ((tableRow.storageEngine ?? '').toLowerCase() !== 'innodb') {
    return `it uses the ${tableRow.storageEngine ?? 'unknown'} storage engine`;
  }
  if (tableRow.tableComment !== expectedTableComment) return "its comment doesn't name this request";
  return undefined;
}

/**
 * Why the columns of a table this request created ({@link findMySqlLeftoverTableOwnershipMismatch}) are NOT the
 * ones it would create now, or `undefined` when they are: the injected `id` key, every planned column with the
 * planned type and nullability, and otherwise only columns named after the plan's foreign-key fields (added by an
 * ALTER that may have run before the interruption; the foreign-key path checks their constraints). The planned
 * columns can differ from the leftover's when the plan was edited between attempts; such a table is refused like
 * any other existing table.
 */
export function findMySqlLeftoverTableColumnsMismatch(
  columns: readonly MySqlLeftoverTableColumn[],
  expected: {
    plannedColumns: ReadonlyMap<string, Extract<MySqlCreateFieldColumnDefinition, { outcome: 'column' }>>;
    foreignKeyFieldNames: ReadonlySet<string>;
  },
): string | undefined {
  const primaryKeyColumns = columns.filter((column) => column.columnKey === 'PRI');
  const idColumn = primaryKeyColumns.length === 1 ? primaryKeyColumns[0] : undefined;
  if (
    idColumn?.columnName !== MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME ||
    normalizeMySqlColumnTypeForComparison(idColumn.columnType) !== 'bigint unsigned' ||
    !/\bauto_increment\b/i.test(idColumn.extra)
  ) {
    return `its primary key isn't the injected "${MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME}" column`;
  }

  const existingColumnByName = new Map(columns.map((column) => [column.columnName, column]));
  for (const [plannedColumnName, plannedColumn] of expected.plannedColumns) {
    const existingColumn = existingColumnByName.get(plannedColumnName);
    if (existingColumn === undefined) return `it has no column "${plannedColumnName}"`;
    if (!doesMySqlColumnMatchCreateDefinition(existingColumn, plannedColumn)) {
      return `its column "${plannedColumnName}" is ${existingColumn.columnType}${existingColumn.isNullable ? '' : ' NOT NULL'}, not the planned ${plannedColumn.columnTypeSpelling}${plannedColumn.isNullable ? '' : ' NOT NULL'}`;
    }
  }
  const unplannedColumn = columns.find(
    (column) =>
      column.columnName !== MYSQL_AUTO_PRIMARY_KEY_COLUMN_NAME &&
      !expected.plannedColumns.has(column.columnName) &&
      !expected.foreignKeyFieldNames.has(column.columnName),
  );
  if (unplannedColumn !== undefined) return `it has a column "${unplannedColumn.columnName}" the plan doesn't have`;
  return undefined;
}

/**
 * A user-facing message for a MySQL error raised by CREATE TABLE / ALTER TABLE, naming the object Scratch was
 * creating; `undefined` for errors this table doesn't cover (the caller falls back to the connector's general error
 * mapping). Keyed by `errno`. Never echoes the server's message: privilege errors carry `'user'@'client-ip'`, and a
 * fixed message is clearer anyway. `context.columnName` is set when a single field was being added.
 */
export function mySqlSchemaCreationErrorMessage(
  error: unknown,
  context: { databaseName: string; tableName: string; columnName?: string },
): string | undefined {
  const errorNumber = readMySqlServerErrorNumber(error);
  if (errorNumber === undefined) return undefined;
  const qualifiedTableDescription = `"${context.databaseName}"."${context.tableName}"`;
  const foreignKeyRejectionMessage = (detail: string): string =>
    context.columnName !== undefined
      ? `Couldn't create foreign key "${context.columnName}" on ${qualifiedTableDescription}: ${detail}`
      : `Couldn't create a foreign key on ${qualifiedTableDescription}: ${detail}`;

  if (MYSQL_FOREIGN_KEY_REJECTION_ERROR_NUMBERS.has(errorNumber)) {
    return foreignKeyRejectionMessage(
      "MySQL rejected the reference to the linked table. Check that the linked table's id column still exists, is unique, and has the same type and character set.",
    );
  }
  switch (errorNumber) {
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.tableExists:
      return `A table named "${context.tableName}" already exists in the "${context.databaseName}" database. Rename the new table, or map to the existing table instead.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.tableCommandDenied: {
      const deniedCommandMatch = /^(\w+) command denied/i.exec(readMySqlServerErrorMessageForPatternTests(error));
      const deniedCommandDescription =
        deniedCommandMatch !== null
          ? MYSQL_DENIED_SCHEMA_COMMAND_DESCRIPTIONS[deniedCommandMatch[1].toUpperCase()]
          : undefined;
      return `This connection's MySQL user isn't allowed to ${deniedCommandDescription ?? 'make schema changes'} in "${context.databaseName}". Grant it CREATE, ALTER and REFERENCES on \`${context.databaseName}\`.*, or choose another database.`;
    }
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.databaseAccessDenied:
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.specificAccessDenied:
      return `This connection's MySQL user isn't allowed to create tables in "${context.databaseName}". Grant it CREATE, ALTER and REFERENCES on \`${context.databaseName}\`.*, or choose another database.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.unknownDatabase:
      return `Database "${context.databaseName}" doesn't exist. Choose another database, or create it in MySQL first.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.noSuchTable:
      return `Table ${qualifiedTableDescription} doesn't exist (was it renamed or dropped?).`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.rowTooLarge:
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.tooManyColumns:
      return `${qualifiedTableDescription} would have more (or wider) columns than fit in one MySQL row. Deselect some fields and try again.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.duplicateColumnName:
      return context.columnName !== undefined
        ? `A column named "${context.columnName}" already exists on ${qualifiedTableDescription}.`
        : `Two fields of ${qualifiedTableDescription} map to the same MySQL column name (MySQL column names are case-insensitive). Rename one of them.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.foreignKeyDuplicateName:
      return foreignKeyRejectionMessage(
        context.columnName !== undefined
          ? `a constraint named "${buildMySqlForeignKeyConstraintName(context.tableName, context.columnName)}" already exists in the "${context.databaseName}" database. Drop the old constraint, or rename the field.`
          : `a constraint with the same name already exists in the "${context.databaseName}" database.`,
      );
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.cannotCreateTable:
      // MariaDB reports every foreign-key failure as 1005 (errno 150); without a field it's a generic CREATE failure.
      return context.columnName !== undefined
        ? foreignKeyRejectionMessage(
            "MySQL rejected the reference to the linked table. Check that the linked table's id column still exists, is unique, and has the same type and character set.",
          )
        : `MySQL couldn't create ${qualifiedTableDescription} (error 1005).`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.identifierTooLong:
      return `A name in this request is longer than MySQL's ${MYSQL_MAX_IDENTIFIER_LENGTH}-character limit. Shorten it and try again.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.incorrectTableName:
      return `MySQL doesn't accept "${context.tableName}" as a table name. Rename the table and try again.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.incorrectColumnName:
      return context.columnName !== undefined
        ? `MySQL doesn't accept "${context.columnName}" as a column name. Rename the field and try again.`
        : `MySQL doesn't accept one of the field names of ${qualifiedTableDescription} as a column name. Rename it and try again.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.lockWaitTimeout:
      return `Timed out waiting for a lock on ${qualifiedTableDescription} — another session is using it. Try again when it's idle.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.optionPreventsStatement:
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.readOnlyTransaction:
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.readOnlyMode:
      return `This MySQL server is read-only (it may be a replica), so Scratch can't create tables on it. Connect Scratch to the primary server instead.`;
    case MYSQL_SCHEMA_CREATION_ERROR_NUMBERS.unknownError:
      // Vitess / PlanetScale refuse foreign keys with a generic error ("VT10001: foreign key constraints are not
      // allowed"); recognize only that fixed pattern, anything else stays with the general error mapping.
      return /\bVT10001\b|foreign key constraints are not allowed/i.test(
        readMySqlServerErrorMessageForPatternTests(error),
      )
        ? foreignKeyRejectionMessage("this MySQL server doesn't allow foreign keys.")
        : undefined;
    default:
      return undefined;
  }
}
