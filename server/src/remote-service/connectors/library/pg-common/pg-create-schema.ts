/**
 * Pure DDL building for the create-schema API (DEV-10381).
 *
 * Maps the connector-agnostic logical field types (`CreateFieldType`) to native
 * PostgreSQL columns and builds the `CREATE TABLE` / `ALTER TABLE ADD COLUMN`
 * statements with Knex's schema builder. Nothing here connects to a database —
 * the caller passes in a Knex instance (a live one in `KnexPGClient`, a
 * connection-less `knex({ client: 'pg' })` in unit tests) so the generated SQL
 * is fully assertable without a server.
 *
 * Mirrors the proven Whalesync Postgres connector (`pg-client.ts`): inject an
 * auto-generated primary key, reference the FK target's real primary-key column,
 * make FK columns nullable for `ON DELETE SET NULL`, and surface a per-field skip
 * reason rather than silently dropping a column.
 */
import { CREATE_FIELD_KINDS, type SchemaCreationCapabilities } from '@spinner/shared-types';
import { type Knex } from 'knex';
import { assertUnreachable } from 'src/utils/asserts';
import { type ResolvedCreateFieldSpec } from '../../schema-creation.types';
import { escapeKnexColumnIdentifierSpecialCharacters } from './knex-column-identifier-dot-encoding';
import { isRecreatablePostgresNativeColumnType, POSTGRES_NATIVE_TYPE_SYSTEM } from './pg-native-column-type';

/**
 * Name of the auto-generated primary-key column injected into every created
 * table. The read side's `pickPrimaryKey` already falls back to `id`, and
 * `listTables` requires an auto-generated PK for a table to support record
 * creates — so `createTable` must inject one. A user field named `id` collides
 * and is rejected with a per-field error.
 */
export const AUTO_PK_COLUMN = 'id';

/** Postgres identifier length limit (NAMEDATALEN - 1). Over-long names are truncated silently by PG, so we fail fast. */
export const POSTGRES_MAX_IDENTIFIER_LENGTH = 63;

/**
 * Postgres SQLSTATE `42P07` (`duplicate_table`): a `CREATE TABLE` collided with an
 * existing relation of the same name in the target schema. Raised only by table
 * creation (never by ALTER / insert / select), so the create path can safely turn
 * it into a message that names the table we were trying to create.
 */
export const PG_DUPLICATE_TABLE_SQLSTATE = '42P07';

/** True when `error` is a Postgres `duplicate_table` (42P07) error. */
export function isDuplicateTableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_DUPLICATE_TABLE_SQLSTATE
  );
}

/** User-facing message for a create-table name collision, naming the table we tried to create. */
export function duplicateTableCreateErrorMessage(tableName: string): string {
  return `A table named "${tableName}" already exists in the target schema. Rename the new table, or map to the existing table instead.`;
}

/**
 * Postgres SQLSTATE `42501` (`insufficient_privilege`): the connected role is not
 * allowed to perform the statement. The create-schema path turns this one into a
 * message that names the missing grant, since "permission denied for database
 * postgres" tells a user nothing about what to change.
 */
export const PG_INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';

/** True when `error` is a Postgres `insufficient_privilege` (42501) error. */
export function isInsufficientPrivilegeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_INSUFFICIENT_PRIVILEGE_SQLSTATE
  );
}

/**
 * Fold a human-chosen container name ("Airtable export") into a Postgres schema
 * identifier we can create and then address unquoted (`airtable_export`).
 *
 * A schema Scratch provisions for a Live Export is one a person will go on to
 * query by hand, so it gets the shape hand-written SQL expects: lower case,
 * `snake_case`, nothing that would force every future reference to be
 * double-quoted. Postgres would happily accept `"Airtable export"` as a quoted
 * identifier — it just makes the schema permanently awkward to use.
 *
 * The fold is deliberately lossy but DETERMINISTIC: the same requested name
 * always yields the same schema name, which is what lets a retried create
 * converge on the schema the first attempt made instead of provisioning a second
 * one. Callers report the name actually used back to the user (via the created
 * table's remote parent), so the rename is visible rather than silent.
 *
 * @param requestedName The name the user typed, or the server's suggestion.
 * @param fallbackSchemaName Used when the fold leaves nothing usable (a name made
 *   entirely of punctuation, or no name at all).
 */
export function foldNameToPostgresSchemaIdentifier(
  requestedName: string | undefined,
  fallbackSchemaName: string,
): string {
  const foldedName = (requestedName ?? '')
    .normalize('NFKD')
    // Drop combining marks so "Café" folds to "cafe" rather than losing the é entirely.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (foldedName === '') return fallbackSchemaName;
  // A leading digit makes the identifier unusable unquoted (`2026_export` is a
  // syntax error), so prefix rather than drop the digits. Prefix BEFORE truncating
  // so the length limit is respected either way.
  const prefixedName = /^[0-9]/.test(foldedName) ? `s_${foldedName}` : foldedName;
  // Postgres silently truncates over-long identifiers, so truncate deliberately
  // here — and re-trim, since the cut can land on a separator.
  return prefixedName.slice(0, POSTGRES_MAX_IDENTIFIER_LENGTH).replace(/_+$/, '') || fallbackSchemaName;
}

/**
 * The first of `baseSchemaName`, `baseSchemaName_2`, `baseSchemaName_3`, … that
 * no existing schema uses — so a "new schema" destination really is new rather
 * than landing beside another export's tables. The base is truncated (and
 * re-trimmed) before the suffix so the result stays within Postgres' identifier
 * limit, which would otherwise silently cut the suffix off.
 */
export function pickUnusedPostgresSchemaName(baseSchemaName: string, existingSchemaNames: ReadonlySet<string>): string {
  if (!existingSchemaNames.has(baseSchemaName)) return baseSchemaName;
  for (let suffixNumber = 2; ; suffixNumber++) {
    const suffix = `_${suffixNumber}`;
    const candidateSchemaName = `${baseSchemaName.slice(0, POSTGRES_MAX_IDENTIFIER_LENGTH - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!existingSchemaNames.has(candidateSchemaName)) return candidateSchemaName;
  }
}

/** Generous integer headroom added to a requested decimal scale to form `numeric(scale + headroom, scale)`. */
const NUMERIC_PRECISION_HEADROOM = 8;

/** Default scale for a `currency` field when the caller does not request a precision (money-style 4 dp). */
const DEFAULT_CURRENCY_SCALE = 4;

/**
 * Connector-declared capabilities consumed by the generic create-schema
 * validator. Postgres can represent every logical kind as a column and has no
 * mandatory title field (the read side derives the title column from name
 * heuristics, not a DDL marker — so `primaryField` is null and the `isPrimary`
 * flag is ignored for DDL).
 */
export const POSTGRES_SCHEMA_CREATION_CAPABILITIES: SchemaCreationCapabilities = {
  supportedFieldKinds: [...CREATE_FIELD_KINDS],
  primaryField: null,
  maxTableNameLength: POSTGRES_MAX_IDENTIFIER_LENGTH,
  maxFieldNameLength: POSTGRES_MAX_IDENTIFIER_LENGTH,
  // The auto-injected primary key (`addAutoPrimaryKey`) owns this name; a source field that folds to it
  // is renamed by the plan generator so it isn't silently dropped at create (see `validateCreateField`).
  reservedFieldNames: [AUTO_PK_COLUMN],
  // A foreign key becomes a single scalar column referencing the target's primary key, so Postgres can
  // represent the one-side of a 1→N relationship but not a two-way N→N link. The plan generator drops
  // both sides of a reciprocal N→N pair from a symmetric source rather than suggesting an unusable one.
  supportsManyToManyForeignKeys: false,
  // Postgres and Supabase share one type system: a source column annotated with its exact Postgres type
  // is recreated with that type (`applyNativeColumnType`) instead of its logical approximation.
  nativeTypeSystem: POSTGRES_NATIVE_TYPE_SYSTEM,
  // `text[]`, `integer[]` / `double precision[]` / `numeric[]`, and `boolean[]`.
  supportedArrayElementKinds: ['text', 'number', 'boolean'],
};

/**
 * The server resolves every foreignKey `target` to a concrete existing table
 * before dispatch, but the *referenced primary-key column + its native type*
 * only the connector knows (it introspects the live target table). The connector
 * computes one of these per foreignKey field and hands it to the pure builder.
 */
export type ForeignKeyResolution =
  | { kind: 'resolved'; targetTableQualified: string; targetPkColumn: string; targetPkType: string }
  | { kind: 'unresolvable'; reason: string };

/** foreignKey resolutions keyed by `CreateFieldSpec.name`. */
export type ForeignKeyResolutions = Map<string, ForeignKeyResolution>;

/**
 * Add the auto-generated primary key: a `uuid` column defaulting to
 * `gen_random_uuid()`. The `gen` default is detected by
 * `findTablesWithAutoGeneratedPK`, so the created table supports record creates,
 * and `uuid` round-trips cleanly as a string (the read side maps it through
 * `PG_TEXT_TYPES`). `gen_random_uuid()` is built into Postgres 13+ (older servers
 * need the `pgcrypto` extension). Needs the Knex instance for `knex.raw`.
 */
function addAutoPrimaryKey(knexInstance: Knex, table: Knex.CreateTableBuilder): void {
  table.uuid(AUTO_PK_COLUMN).notNullable().defaultTo(knexInstance.raw('gen_random_uuid()')).primary();
}

/** Apply `NOT NULL` when the field requested it. Columns are nullable by default otherwise. */
function applyRequired(column: Knex.ColumnBuilder, field: ResolvedCreateFieldSpec): void {
  if (field.required) {
    column.notNullable();
  }
}

/** The native Postgres type of a `number` field's values (the element type, for an `isArray` list). */
function postgresNativeTypeForNumberField(
  fieldType: Extract<ResolvedCreateFieldSpec['fieldType'], { kind: 'number' }>,
): string {
  const format = fieldType.format ?? 'plain';
  switch (format) {
    case 'integer':
      return 'integer';
    case 'decimal':
      return fieldType.precision !== undefined
        ? `numeric(${fieldType.precision + NUMERIC_PRECISION_HEADROOM},${fieldType.precision})`
        : 'numeric';
    case 'percent':
      return 'numeric';
    case 'plain':
      return 'double precision';
    default:
      return assertUnreachable(format);
  }
}

/**
 * Create the column with the field's exact native Postgres type (DEV-11903), or return a skip reason.
 * The plan generator only sets `nativeFieldType` for a recreatable source type, but the spec arrives
 * from a client, so the type is re-checked here before it reaches `specificType` (raw SQL) — a type
 * outside the recreatable grammar/allowlist fails the field instead of being interpolated.
 */
function applyNativeColumnType(
  table: Knex.CreateTableBuilder,
  knexColumnName: string,
  field: ResolvedCreateFieldSpec,
  nativeColumnType: string,
): string | undefined {
  if (!isRecreatablePostgresNativeColumnType(nativeColumnType)) {
    return `field "${field.name}" asks for native Postgres type "${nativeColumnType}", which the Postgres connector can't create — remove the native type to create it from its logical type instead`;
  }
  applyRequired(table.specificType(knexColumnName, nativeColumnType), field);
  return undefined;
}

/**
 * Map a `number` field to its column: integer → `integer` (int4, so node-pg returns a JS number matching the
 * read-side `number` schema); decimal → `numeric(scale+headroom, scale)` (or bare `numeric`); percent →
 * `numeric`; plain → `double precision`. Shares {@link postgresNativeTypeForNumberField} with list columns,
 * so a scalar number column and a `number[]` list never map a format differently.
 */
function applyNumberColumn(
  table: Knex.CreateTableBuilder,
  name: string,
  fieldType: Extract<ResolvedCreateFieldSpec['fieldType'], { kind: 'number' }>,
): Knex.ColumnBuilder {
  return table.specificType(name, postgresNativeTypeForNumberField(fieldType));
}

/**
 * Apply the foreignKey column + constraint, or return a skip reason. The column
 * is typed to match the target's primary key, kept nullable, and the constraint
 * is `ON DELETE SET NULL` (so deleting a referenced row nulls the reference
 * rather than failing — matches how linked records behave elsewhere).
 */
function applyForeignKeyColumn(
  table: Knex.CreateTableBuilder,
  field: ResolvedCreateFieldSpec,
  fieldType: Extract<ResolvedCreateFieldSpec['fieldType'], { kind: 'foreignKey' }>,
  fkResolutions: ForeignKeyResolutions,
): string | undefined {
  if (fieldType.allowMultiple) {
    return `foreign key "${field.name}" requests allowMultiple, which the Postgres connector does not support yet — create a single-valued foreign key (or a join table) instead`;
  }
  const resolution = fkResolutions.get(field.name);
  if (!resolution) {
    return `foreign key "${field.name}" could not be resolved to a target table`;
  }
  if (resolution.kind === 'unresolvable') {
    return resolution.reason;
  }
  // Nullable so ON DELETE SET NULL is valid; type matches the referenced PK column. The FK column
  // and the referenced PK column are column identifiers (special-char-escaped so a dotted name
  // survives — DEV-11063 — and a `?` is not swallowed as a knex binding placeholder); the target
  // table is a `schema.table` reference and keeps its real dot so knex splits it into the correct
  // qualified reference.
  const knexColumnName = escapeKnexColumnIdentifierSpecialCharacters(field.name);
  table.specificType(knexColumnName, resolution.targetPkType).nullable();
  table
    .foreign(knexColumnName)
    .references(escapeKnexColumnIdentifierSpecialCharacters(resolution.targetPkColumn))
    .inTable(resolution.targetTableQualified)
    .onDelete('SET NULL');
  return undefined;
}

/**
 * Apply one field as a column on the table builder. Returns `undefined` when the
 * column was added, or a user-facing reason when the field was skipped (a
 * reserved name, an allowMultiple foreign key, or an unresolvable foreign key).
 */
function applyCreateFieldColumn(
  table: Knex.CreateTableBuilder,
  field: ResolvedCreateFieldSpec,
  fkResolutions: ForeignKeyResolutions,
): string | undefined {
  if (field.name.trim().toLowerCase() === AUTO_PK_COLUMN) {
    return `field name "${field.name}" is reserved — the Postgres connector injects an auto-generated "${AUTO_PK_COLUMN}" primary key column`;
  }

  const fieldType = field.fieldType;
  // A `.` in the column name is knex's qualification separator (DEV-11063) and a `?` is knex's
  // binding placeholder (an unescaped one turned "Featured?" into a column literally named
  // "Featured$1" — SANITY Live Export audit 2026-08-01); escape both so the column is emitted as
  // one verbatim identifier. Every name handed to a knex column method below goes through this.
  const knexColumnName = escapeKnexColumnIdentifierSpecialCharacters(field.name);
  // A same-type-system source column carries its exact Postgres type; create exactly that (DEV-11903). A
  // native type from another type system doesn't apply here — the logical `fieldType` below is used. A
  // foreign key always takes its type from the referenced primary key (and needs its constraint), so a
  // native type never overrides one.
  if (field.nativeFieldType?.typeSystem === POSTGRES_NATIVE_TYPE_SYSTEM && fieldType.kind !== 'foreignKey') {
    return applyNativeColumnType(table, knexColumnName, field, field.nativeFieldType.type);
  }

  // `description` is intentionally not mapped to COMMENT ON COLUMN in v1: the read side
  // reads information_schema (not pg_description), so it would not round-trip. select /
  // multiSelect option lists are likewise not enforced (no enum/CHECK) — stored as text / text[].
  switch (fieldType.kind) {
    case 'text':
      applyRequired(
        fieldType.isArray ? table.specificType(knexColumnName, 'text[]') : table.text(knexColumnName),
        field,
      );
      return undefined;
    case 'longText':
    case 'url':
    case 'email':
    case 'phone':
    case 'select':
      applyRequired(table.text(knexColumnName), field);
      return undefined;
    case 'multiSelect':
      applyRequired(table.specificType(knexColumnName, 'text[]'), field);
      return undefined;
    case 'boolean':
      applyRequired(
        fieldType.isArray ? table.specificType(knexColumnName, 'boolean[]') : table.boolean(knexColumnName),
        field,
      );
      return undefined;
    case 'number':
      applyRequired(
        fieldType.isArray
          ? table.specificType(knexColumnName, `${postgresNativeTypeForNumberField(fieldType)}[]`)
          : applyNumberColumn(table, knexColumnName, fieldType),
        field,
      );
      return undefined;
    case 'json':
      applyRequired(table.jsonb(knexColumnName), field);
      return undefined;
    case 'currency': {
      // currencyCode is metadata only — stored as a scaled numeric.
      const scale = fieldType.precision ?? DEFAULT_CURRENCY_SCALE;
      applyRequired(table.decimal(knexColumnName, scale + NUMERIC_PRECISION_HEADROOM, scale), field);
      return undefined;
    }
    case 'date':
      applyRequired(
        fieldType.includesTime ? table.timestamp(knexColumnName, { useTz: true }) : table.date(knexColumnName),
        field,
      );
      return undefined;
    case 'foreignKey':
      return applyForeignKeyColumn(table, field, fieldType, fkResolutions);
    default:
      return assertUnreachable(fieldType);
  }
}

/**
 * Build a `CREATE TABLE "<schema>"."<name>" (...)` schema-builder query: the
 * injected auto primary key followed by one column per field (FK targets already
 * resolved). Fields that can't become a column populate `skippedFieldReasons`
 * (keyed by field name) instead of failing the whole statement.
 */
export function buildCreateTableQuery(
  knexInstance: Knex,
  schema: string,
  tableName: string,
  fields: ResolvedCreateFieldSpec[],
  fkResolutions: ForeignKeyResolutions,
  skippedFieldReasons?: Map<string, string>,
): Knex.SchemaBuilder {
  return knexInstance.schema.withSchema(schema).createTable(tableName, (table) => {
    addAutoPrimaryKey(knexInstance, table);
    for (const field of fields) {
      const skipReason = applyCreateFieldColumn(table, field, fkResolutions);
      if (skipReason !== undefined) {
        skippedFieldReasons?.set(field.name, skipReason);
      }
    }
  });
}

/**
 * Build an `ALTER TABLE "<schema>"."<name>" ADD COLUMN ...` schema-builder query
 * for each field. Used for the deferred cyclic/self foreignKey pass and the
 * /schema/fields endpoint.
 */
export function buildAddColumnsQuery(
  knexInstance: Knex,
  schema: string,
  tableName: string,
  fields: ResolvedCreateFieldSpec[],
  fkResolutions: ForeignKeyResolutions,
  skippedFieldReasons?: Map<string, string>,
): Knex.SchemaBuilder {
  return knexInstance.schema.withSchema(schema).alterTable(tableName, (table) => {
    for (const field of fields) {
      const skipReason = applyCreateFieldColumn(table, field, fkResolutions);
      if (skipReason !== undefined) {
        skippedFieldReasons?.set(field.name, skipReason);
      }
    }
  });
}
