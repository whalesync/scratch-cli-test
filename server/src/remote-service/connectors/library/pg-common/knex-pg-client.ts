/**
 * Reusable Knex-based PostgreSQL client.
 * Ported from Whalesync's PGClient — provides schema discovery and CRUD operations
 * using Knex.js as the query builder with the pg driver.
 *
 * Designed for use by any connector that needs direct PostgreSQL access
 * (Supabase, generic Postgres, etc.).
 */
import knex, { type Knex } from 'knex';
import { type ResolvedCreateFieldSpec } from '../../schema-creation.types';
import {
  chooseUniquelyAddressableColumn,
  type InformationSchemaCatalog,
  type InformationSchemaColumn,
  type PostgresEnumValue,
  type PostgresForeignKey,
  type PostgresUserDefinedType,
  type SingleColumnUniqueIndexColumn,
  type TableName,
} from './knex-pg-types';
import { buildAddColumnsQuery, buildCreateTableQuery, type ForeignKeyResolutions } from './pg-create-schema';

// NUMERIC / DECIMAL fidelity (DEV-10777): we intentionally do NOT register a global
// `pg.types.setTypeParser(1700, parseFloat)`. The `pg` driver returns `numeric`/`decimal` as a
// precision-preserving STRING by design (NUMERIC is arbitrary-precision); coercing it to a JS float
// on read is lossy and violates the Connector Prime Directive — it reshapes the data to fit the
// schema instead of the schema to fit the data. We store the driver's verbatim string and type the
// column as a numeric-valued string (`PostgresColumnType.NUMERIC_STRING`); the fixed-width numeric
// types (`integer`, `real`, `double precision`, …) are unaffected — the driver already hands those
// back as JS numbers. Removing the override was verified safe: it mutated the process-global `pg`
// parser, but the server's own schema (Prisma) has no `numeric`/`decimal` columns, so only the
// Postgres/Supabase connectors were relying on it.

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Knex uses `?` as binding placeholders — column names containing `?` must be escaped.
 */
function escapeKnexSpecialCharacters(column: string): string {
  return column.replace(/\?/g, '\\?');
}

/** Escape an array of column names for use in Knex select(). */
function escapeColumns(columns: string[]): string[] {
  return columns.map(escapeKnexSpecialCharacters);
}

/** Escape all keys of an object for use in Knex insert/update. */
function escapeObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[escapeKnexSpecialCharacters(key)] = value;
  }
  return result;
}

/**
 * Recursively convert Date objects to ISO strings and handle arrays.
 *
 * DEV-10777 ruling: the `Date → ISO` conversion is Connector-Prime-Directive-DEFENSIBLE, not a
 * forbidden reshape. The `pg` driver parses `timestamp`/`date` OIDs into a JS `Date`, which is not
 * JSON-serializable; RFC 3339 (`toISOString()`) is simply the faithful, lossless serialization of
 * the value the driver produced — it renames no key and changes no container. This is unlike the
 * NUMERIC coercion (removed above), which threw away precision. Left unchanged deliberately.
 */
function sanitizeFieldValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeFieldValue);
  }
  return value;
}

/** Sanitize all values in a row object. */
function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = sanitizeFieldValue(value);
  }
  return result;
}

/**
 * Sanitize a PostgreSQL connection string.
 * - Handles SSL parameters (strips invalid ones, adds no-verify if needed).
 * - Falls back to the original string if URL parsing fails.
 */
export function sanitizeConnectionString(connectionString: string, sslNoVerify?: boolean): string {
  try {
    const url = new URL(connectionString);
    const sslParam = url.searchParams.get('ssl');
    if (sslParam && sslParam !== 'true') {
      url.searchParams.delete('ssl');
    }
    if (sslNoVerify && !url.searchParams.has('sslmode')) {
      url.searchParams.set('sslmode', 'no-verify');
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

// ---------------------------------------------------------------------------
// KnexPGClient
// ---------------------------------------------------------------------------

export class KnexPGClient {
  private readonly knex: Knex;

  constructor(connectionString: string, options?: { sslNoVerify?: boolean }) {
    const sanitized = sanitizeConnectionString(connectionString, options?.sslNoVerify);
    this.knex = knex({
      client: 'pg',
      connection: {
        connectionString: sanitized,
        ssl: options?.sslNoVerify ? { rejectUnauthorized: false } : undefined,
      },
      pool: { min: 0, max: 1, createTimeoutMillis: 10_000 },
    });
  }

  /** Destroy the underlying connection pool. Must be called when done. */
  async dispose(): Promise<void> {
    await this.knex.destroy();
  }

  // -------------------------------------------------------------------------
  // Connection test
  // -------------------------------------------------------------------------

  /** Run `SELECT current_database()` to verify connectivity. */
  async testQuery(): Promise<string> {
    const result = await this.knex.raw<{ rows: { current_database: string }[] }>('SELECT current_database()');
    return result.rows[0].current_database;
  }

  // -------------------------------------------------------------------------
  // Schema discovery
  // -------------------------------------------------------------------------

  /** List all schemas in the database. */
  async findAllSchemas(): Promise<InformationSchemaCatalog[]> {
    const result = await this.knex.raw<{ rows: InformationSchemaCatalog[] }>(
      'SELECT catalog_name, schema_name FROM information_schema.schemata',
    );
    return result.rows;
  }

  /** List all tables in a specific schema. */
  async findAllTablesInSchema(schema: string): Promise<TableName[]> {
    const result = await this.knex.raw<{ rows: TableName[] }>(
      'SELECT table_name, table_schema, table_type FROM information_schema.tables WHERE table_schema = ?',
      [schema],
    );
    return result.rows;
  }

  /**
   * List all tables excluding specified schemas and LIKE patterns.
   * Used by the Supabase connector to discover tables across all user schemas.
   */
  async findAllTablesExcludingSchemas(excludedSchemas: string[], excludePatterns?: string[]): Promise<TableName[]> {
    let query = this.knex('information_schema.tables')
      .select('table_name', 'table_schema', 'table_type')
      .whereNotIn('table_schema', excludedSchemas);

    if (excludePatterns) {
      for (const pattern of excludePatterns) {
        query = query.andWhereNot('table_schema', 'like', pattern);
      }
    }

    return query;
  }

  /** Get column metadata for a table. */
  async findAllColumnsInTable(schema: string, tableName: string): Promise<InformationSchemaColumn[]> {
    const result = await this.knex.raw<{ rows: InformationSchemaColumn[] }>(
      `SELECT column_name, data_type, column_default, is_updatable, is_nullable,
              domain_name, udt_name, character_maximum_length, is_identity,
              identity_increment, identity_cycle
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [schema, tableName],
    );
    return result.rows;
  }

  /**
   * Find primary key column candidates for a table using pg_catalog.
   * Returns the column names that form the primary key.
   */
  async findPrimaryColumnCandidates(schema: string, tableName: string): Promise<string[]> {
    const result = await this.knex.raw<{ rows: { attname: string }[] }>(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid IN (
         SELECT oid FROM pg_class
         WHERE relname = ? AND relnamespace IN (
           SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = ?
         )
       )
       AND i.indisprimary`,
      [tableName, schema],
    );
    return result.rows.map((r) => r.attname);
  }

  /**
   * Find tables whose primary key column has an auto-generated default
   * (serial/nextval, gen_random_uuid, now(), nanoid, auth.uid(), or IDENTITY).
   * Returns a Set of "schema.table" strings for efficient lookup.
   */
  async findTablesWithAutoGeneratedPK(excludedSchemas: string[]): Promise<Set<string>> {
    const result = await this.knex.raw<{ rows: { table_schema: string; table_name: string }[] }>(
      `SELECT DISTINCT n.nspname AS table_schema, c.relname AS table_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       JOIN information_schema.columns isc
         ON isc.table_schema = n.nspname
        AND isc.table_name = c.relname
        AND isc.column_name = a.attname
       WHERE i.indisprimary
         AND n.nspname NOT IN (${excludedSchemas.map(() => '?').join(', ')})
         AND (
           isc.column_default LIKE '%nextval%'
           OR isc.column_default LIKE '%gen%'
           OR isc.column_default LIKE '%now%'
           OR isc.column_default LIKE '%nanoid%'
           OR isc.column_default LIKE '%auth.uid()%'
           OR (isc.is_identity = 'YES' AND isc.identity_increment IS NOT NULL AND isc.identity_cycle = 'NO')
         )`,
      excludedSchemas,
    );
    return new Set(result.rows.map((r) => `${r.table_schema}.${r.table_name}`));
  }

  /**
   * Find tables that have at least one genuinely unique single column — a
   * single-column, non-partial, non-expression, non-deferrable unique index
   * (which includes a single-column primary key). Returns a Set of
   * "schema.table" strings for efficient lookup.
   *
   * A composite primary key does NOT qualify (DEV-10802): `idPath` is one
   * column, so a table whose only uniqueness is multi-column cannot be
   * addressed row-by-row — updates/deletes matching on one column of a
   * composite key would hit every row sharing that value. The filter here must
   * stay in lockstep with {@link findSingleColumnUniqueIndexColumns}, which
   * picks the actual column for tables this set admits.
   */
  async findTablesWithUniqueColumns(excludedSchemas: string[]): Promise<Set<string>> {
    const result = await this.knex.raw<{ rows: { table_schema: string; table_name: string }[] }>(
      `SELECT DISTINCT n.nspname AS table_schema, c.relname AS table_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE i.indisunique
         AND array_length(i.indkey, 1) = 1
         AND i.indkey[0] <> 0
         AND i.indpred IS NULL
         AND i.indimmediate
         AND n.nspname NOT IN (${excludedSchemas.map(() => '?').join(', ')})`,
      excludedSchemas,
    );
    return new Set(result.rows.map((r) => `${r.table_schema}.${r.table_name}`));
  }

  /**
   * The columns of one table that carry a single-column, non-partial,
   * non-expression, non-deferrable unique index — the only columns a record can
   * safely be addressed by (`idPath`) or a foreign key can reference. One column
   * of a composite primary key is deliberately NOT returned (it is not unique on
   * its own); the composite's index only appears here when some single column
   * also has its own unique index. `native_type` comes from
   * `format_type(atttypid, atttypmod)`, so enums/citext/arrays yield their real
   * type name (schema-qualified when off the search_path) rather than
   * information_schema's `USER-DEFINED`/`ARRAY` placeholders (DEV-10821).
   * Ordered primary-key-first so callers can prefer the PK deterministically.
   */
  async findSingleColumnUniqueIndexColumns(
    schema: string,
    tableName: string,
  ): Promise<SingleColumnUniqueIndexColumn[]> {
    const result = await this.knex.raw<{ rows: SingleColumnUniqueIndexColumn[] }>(
      `SELECT a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS native_type,
              i.indisprimary AS is_primary_key
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE c.relname = ? AND n.nspname = ?
         AND i.indisunique
         AND array_length(i.indkey, 1) = 1
         AND i.indkey[0] <> 0
         AND i.indpred IS NULL
         AND i.indimmediate
       ORDER BY i.indisprimary DESC, a.attnum ASC`,
      [tableName, schema],
    );
    return result.rows;
  }

  /** Find all foreign key constraints for a table. */
  async findAllForeignKeysInTable(schema: string, tableName: string): Promise<PostgresForeignKey[]> {
    const result = await this.knex.raw<{ rows: PostgresForeignKey[] }>(
      `SELECT
         con.conname   AS constraint_name,
         n.nspname     AS table_schema,
         cl.relname    AS table_name,
         att.attname   AS column_name,
         fn.nspname    AS foreign_table_schema,
         fcl.relname   AS foreign_table_name,
         fatt.attname  AS foreign_column_name
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class cl       ON con.conrelid = cl.oid
       JOIN pg_catalog.pg_namespace n    ON cl.relnamespace = n.oid
       JOIN pg_catalog.pg_attribute att  ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
       JOIN pg_catalog.pg_class fcl      ON con.confrelid = fcl.oid
       JOIN pg_catalog.pg_namespace fn   ON fcl.relnamespace = fn.oid
       JOIN pg_catalog.pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = ANY(con.confkey)
       WHERE con.contype = 'f'
         AND array_length(con.conkey, 1) = 1
         AND cl.relname = ? AND n.nspname = ?`,
      [tableName, schema],
    );
    return result.rows;
  }

  /** List all enum types and their values in the database. */
  async listEnumValues(): Promise<PostgresEnumValue[]> {
    const result = await this.knex.raw<{ rows: { enum_name: string; enum_value: string }[] }>(
      `SELECT pg_type.typname AS enum_name, pg_enum.enumlabel AS enum_value
       FROM pg_type
       JOIN pg_enum ON pg_type.oid = pg_enum.enumtypid`,
    );

    // Group into { enumName, enumValues[] }
    const grouped = new Map<string, string[]>();
    for (const row of result.rows) {
      const values = grouped.get(row.enum_name) ?? [];
      values.push(row.enum_value);
      grouped.set(row.enum_name, values);
    }

    return Array.from(grouped.entries()).map(([enumName, enumValues]) => ({ enumName, enumValues }));
  }

  /** List user-defined types (enums, composites, etc.) used by columns in a schema. */
  async listUserDefinedTypesInSchema(schema: string): Promise<PostgresUserDefinedType[]> {
    const result = await this.knex.raw<{ rows: PostgresUserDefinedType[] }>(
      `SELECT typname AS type_name, typtype AS type_classification
       FROM pg_type
       WHERE typname IN (
         SELECT pt.udt_name
         FROM information_schema.columns pt
         WHERE pt.table_schema = ? AND pt.data_type = 'USER-DEFINED'
       )`,
      [schema],
    );
    return result.rows;
  }

  /** Get the PostgreSQL OID for a table (used for Supabase dashboard deep-links). */
  async getTableOid(schema: string, tableName: string): Promise<number | null> {
    const result = await this.knex.raw<{ rows: { oid: number }[] }>(
      `SELECT c.oid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = ? AND n.nspname = ?`,
      [tableName, schema],
    );
    return result.rows[0]?.oid ?? null;
  }

  // -------------------------------------------------------------------------
  // Schema creation (DDL)
  // -------------------------------------------------------------------------

  /** Create a schema if it does not already exist (idempotent, non-destructive). */
  async createSchemaIfNotExists(schema: string): Promise<void> {
    await this.knex.schema.createSchemaIfNotExists(schema);
  }

  /**
   * Create a table with an auto-generated primary key plus one column per field.
   * Runs in a transaction so the table and its foreign-key constraints land
   * atomically. Returns the per-field skip reasons (a field that could not become
   * a column — e.g. an unresolvable foreign key) keyed by field name; every other
   * field became a column.
   */
  async createTable(
    schema: string,
    tableName: string,
    fields: ResolvedCreateFieldSpec[],
    fkResolutions: ForeignKeyResolutions,
  ): Promise<{ skippedFields: Map<string, string> }> {
    const skippedFields = new Map<string, string>();
    await this.knex.transaction(async (trx) => {
      await buildCreateTableQuery(trx, schema, tableName, fields, fkResolutions, skippedFields);
    });
    return { skippedFields };
  }

  /**
   * Add columns to an existing table via `ALTER TABLE … ADD COLUMN`. Compiles
   * once to discover which fields became columns, then executes only when at
   * least one real column remains — so a call containing only skipped fields
   * (e.g. a lone unresolvable foreign key) returns the reasons without issuing an
   * empty ALTER.
   */
  async addColumns(
    schema: string,
    tableName: string,
    fields: ResolvedCreateFieldSpec[],
    fkResolutions: ForeignKeyResolutions,
  ): Promise<{ skippedFields: Map<string, string> }> {
    const skippedFields = new Map<string, string>();
    buildAddColumnsQuery(this.knex, schema, tableName, fields, fkResolutions, skippedFields).toSQL();
    if (skippedFields.size < fields.length) {
      await buildAddColumnsQuery(this.knex, schema, tableName, fields, fkResolutions);
    }
    return { skippedFields };
  }

  /**
   * Resolve the column a foreign key into an existing table should reference,
   * plus its exact native type (via `format_type`, never information_schema's
   * `USER-DEFINED`/`ARRAY` placeholders — DEV-10821). Uses
   * {@link chooseUniquelyAddressableColumn}, the same choice `pickPrimaryKey`
   * makes for the table's `idPath`, so the foreign-key column holds exactly the
   * values the sync pipeline writes into it. Returns null when the table has no
   * single-column unique index to reference (e.g. only a composite primary key
   * — Postgres itself rejects a foreign key onto one column of it).
   */
  async findTableUniquelyAddressableColumn(
    schema: string,
    tableName: string,
  ): Promise<{ column: string; nativeType: string } | null> {
    const [singleColumnUniqueIndexColumns, allColumnsInTable] = await Promise.all([
      this.findSingleColumnUniqueIndexColumns(schema, tableName),
      this.findAllColumnsInTable(schema, tableName),
    ]);
    return chooseUniquelyAddressableColumn(singleColumnUniqueIndexColumns, allColumnsInTable);
  }

  // -------------------------------------------------------------------------
  // CRUD — Read
  // -------------------------------------------------------------------------

  /**
   * Paginated SELECT with ORDER BY primary key.
   * Returns sanitized row objects.
   *
   * When both `modifiedSinceColumn` and `modifiedSinceDatetime` are supplied
   * (incremental pulls), a parameterized `WHERE <col> > $since` predicate is
   * appended. The column is quoted via Knex's identifier ref and the datetime
   * is bound as a parameter — never string-interpolated — so a user-declared
   * column/value can't inject SQL. Knex ANDs this with any raw `filter`.
   * Ordering and offset pagination are unchanged.
   */
  async selectAll(
    schema: string,
    tableName: string,
    columns: string[] | undefined,
    primaryId: string,
    limit: number,
    offset: number,
    filter?: string,
    modifiedSinceColumn?: string,
    modifiedSinceDatetime?: Date,
  ): Promise<Record<string, unknown>[]> {
    const selection = columns ? escapeColumns(columns) : '*';
    let query = this.knex(`${schema}.${tableName}`).select(selection).orderBy(primaryId).offset(offset).limit(limit);
    if (filter) {
      query = query.whereRaw(filter);
    }
    if (modifiedSinceColumn && modifiedSinceDatetime) {
      query = query.where(this.knex.ref(modifiedSinceColumn), '>', modifiedSinceDatetime);
    }
    const rows = (await query) as Record<string, unknown>[];
    return rows.map(sanitizeRow);
  }

  /** SELECT rows by primary key values. */
  async selectByIds(
    schema: string,
    tableName: string,
    columns: string[],
    primaryId: string,
    ids: (string | number)[],
  ): Promise<Record<string, unknown>[]> {
    const escaped = escapeColumns(columns);
    const rows = (await this.knex(`${schema}.${tableName}`).select(escaped).whereIn(primaryId, ids)) as Record<
      string,
      unknown
    >[];
    return rows.map(sanitizeRow);
  }

  // -------------------------------------------------------------------------
  // CRUD — Create
  // -------------------------------------------------------------------------

  /** Insert a single row, returning all columns. Strips the primary key from input. */
  async insertOne(
    schema: string,
    tableName: string,
    primaryId: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const results = await this.insertMany(schema, tableName, primaryId, [data]);
    return results[0];
  }

  /** Insert multiple rows in a single INSERT, returning all columns. Strips primary keys from input. */
  async insertMany(
    schema: string,
    tableName: string,
    primaryId: string,
    records: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const insertData = records.map((record) => {
      const filtered = { ...record };
      delete filtered[primaryId];
      return escapeObjectKeys(filtered);
    });

    const rows = (await this.knex(`${schema}.${tableName}`).insert(insertData).returning('*')) as Record<
      string,
      unknown
    >[];

    if (rows.length !== records.length) {
      throw new KnexPGClientError(
        `Expected ${records.length} inserted rows, got ${rows.length}`,
        'INSERT_COUNT_MISMATCH',
      );
    }

    return rows.map(sanitizeRow);
  }

  // -------------------------------------------------------------------------
  // CRUD — Update
  // -------------------------------------------------------------------------

  /** Update a single row by primary key. Returns updated row or 'not_found'. */
  async updateOne(
    schema: string,
    tableName: string,
    recordId: string | number,
    primaryId: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | 'not_found'> {
    const filteredData = { ...data };
    delete filteredData[primaryId];
    const escapedData = escapeObjectKeys(filteredData);

    const rows = (await this.knex(`${schema}.${tableName}`)
      .where(primaryId, recordId)
      .update(escapedData)
      .returning('*')) as Record<string, unknown>[];

    if (rows.length === 0) {
      return 'not_found';
    }
    if (rows.length > 1) {
      throw new KnexPGClientError(
        `UPDATE affected ${rows.length} rows (expected 1) for ${schema}.${tableName} where ${primaryId} = ${String(recordId)}`,
        'UPDATE_MULTIPLE_ROWS',
      );
    }

    return sanitizeRow(rows[0]);
  }

  /**
   * Bulk-update rows by primary key. Each record's `data` is a SPARSE per-row
   * change set — only the columns that actually changed for that row (the
   * connectors pass `changedFields[i]`), so different rows in one batch can
   * touch different columns.
   *
   * A single fixed SET clause for the whole batch is therefore WRONG: the SET
   * list would come from one row's changed columns, and because
   * `json_populate_recordset` defaults any key absent from a row's JSON object
   * to NULL (from the all-NULL base row), every sibling row that didn't change
   * those columns would have its existing values overwritten with NULL — while
   * its own real changes (columns not in the fixed SET list) would be silently
   * dropped.
   *
   * To stay correct for mixed batches we group records by their exact
   * changed-column set and run one bulk UPDATE per group. Every row within a
   * group shares the same SET clause, so the clause always matches the JSON
   * each row carries. The common homogeneous case (every row changed the same
   * columns) collapses to a single group → a single query. Explicitly setting a
   * column to `null` is preserved, because the column is still present in
   * `data`'s keys and thus in the group's SET clause.
   */
  async updateMany(
    schema: string,
    tableName: string,
    primaryId: string,
    records: { id: string | number; data: Record<string, unknown> }[],
  ): Promise<(Record<string, unknown> | 'not_found')[]> {
    if (records.length === 0) return [];

    const quoteId = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const quotedTable = `${quoteId(schema)}.${quoteId(tableName)}`;
    const quotedPk = quoteId(primaryId);

    // Group records that change the exact same set of columns. The map key is
    // the sorted changed-column list so that `{name, price}` and `{price, name}`
    // land in the same group regardless of key order; the stored `columns`
    // array keeps one representative order for building the SET clause.
    const recordsGroupedByChangedColumnSet = new Map<
      string,
      { changedColumns: string[]; records: { id: string | number; data: Record<string, unknown> }[] }
    >();
    for (const record of records) {
      const changedColumns = Object.keys(record.data).filter((column) => column !== primaryId);
      // A record with no changed columns (only the PK) has nothing to update;
      // it maps to 'not_found' below since no query touches it.
      if (changedColumns.length === 0) continue;
      const groupKey = JSON.stringify([...changedColumns].sort());
      const existingGroup = recordsGroupedByChangedColumnSet.get(groupKey);
      if (existingGroup) {
        existingGroup.records.push(record);
      } else {
        recordsGroupedByChangedColumnSet.set(groupKey, { changedColumns, records: [record] });
      }
    }

    // The whole batch runs in one transaction so the non-unique-key guard below
    // can roll back EVERY group's changes — an over-match discovered in a late
    // group must not leave earlier groups' updates applied.
    const updatedRowByPrimaryId = await this.knex.transaction(async (transaction) => {
      const updatedRowByPrimaryIdInTransaction = new Map<string, Record<string, unknown>>();
      for (const { changedColumns, records: recordsInGroup } of recordsGroupedByChangedColumnSet.values()) {
        const setClauses = changedColumns.map((column) => `${quoteId(column)} = v.${quoteId(column)}`);
        const payload = recordsInGroup.map((r) => ({ ...r.data, [primaryId]: r.id }));
        const jsonParam = JSON.stringify(payload);

        const query = `
          UPDATE ${quotedTable} AS t
          SET ${setClauses.join(', ')}
          FROM json_populate_recordset(null::${quotedTable}, ?::json) AS v
          WHERE t.${quotedPk} = v.${quotedPk}
          RETURNING t.*
        `;

        const result = await transaction.raw<{ rows: Record<string, unknown>[] }>(query, [jsonParam]);
        // Guard against a non-unique match column (e.g. one column of a composite
        // primary key, DEV-10802): each id may update AT MOST one row, so the same
        // primary-id value appearing on two returned rows proves the WHERE clause
        // over-matched sibling rows. Throwing here rolls the transaction back.
        const returnedRowCountByPrimaryIdValue = new Map<string, number>();
        for (const row of result.rows) {
          const primaryIdValue = String(row[primaryId]);
          const returnedRowCount = (returnedRowCountByPrimaryIdValue.get(primaryIdValue) ?? 0) + 1;
          if (returnedRowCount > 1) {
            throw new KnexPGClientError(
              `UPDATE on ${schema}.${tableName} matched multiple rows with "${primaryId}" = ${primaryIdValue} — "${primaryId}" is not a unique column, so a bulk update would corrupt sibling rows. All updates in this batch were rolled back.`,
              'UPDATE_MULTIPLE_ROWS',
            );
          }
          returnedRowCountByPrimaryIdValue.set(primaryIdValue, returnedRowCount);
          updatedRowByPrimaryIdInTransaction.set(primaryIdValue, sanitizeRow(row));
        }
      }
      return updatedRowByPrimaryIdInTransaction;
    });

    return records.map((r) => updatedRowByPrimaryId.get(String(r.id)) || 'not_found');
  }

  // -------------------------------------------------------------------------
  // CRUD — Delete
  // -------------------------------------------------------------------------

  /**
   * Delete multiple rows by primary key. Returns the number of affected rows.
   * Runs in a transaction with a `RETURNING` check so a non-unique match column
   * (e.g. one column of a composite primary key, DEV-10802) rolls back instead
   * of silently deleting every sibling row that shares the value.
   */
  async deleteMany(
    schema: string,
    tableName: string,
    recordIds: (string | number)[],
    primaryId: string,
  ): Promise<number> {
    if (recordIds.length === 0) return 0;
    const quoteId = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const quotedTable = `${quoteId(schema)}.${quoteId(tableName)}`;
    const quotedPk = quoteId(primaryId);
    return this.knex.transaction(async (transaction) => {
      const bindingPlaceholders = recordIds.map(() => '?').join(', ');
      const result = await transaction.raw<{ rows: Record<string, unknown>[] }>(
        `DELETE FROM ${quotedTable} WHERE ${quotedPk} IN (${bindingPlaceholders}) RETURNING ${quotedPk}`,
        recordIds,
      );
      // Each id may delete AT MOST one row; a repeated returned value proves the
      // match column is not unique and siblings were caught. Roll back.
      const deletedPrimaryIdValues = new Set<string>();
      for (const row of result.rows) {
        const primaryIdValue = String(row[primaryId]);
        if (deletedPrimaryIdValues.has(primaryIdValue)) {
          throw new KnexPGClientError(
            `DELETE on ${schema}.${tableName} matched multiple rows with "${primaryId}" = ${primaryIdValue} — "${primaryId}" is not a unique column, so a bulk delete would destroy sibling rows. All deletes in this batch were rolled back.`,
            'DELETE_MULTIPLE_ROWS',
          );
        }
        deletedPrimaryIdValues.add(primaryIdValue);
      }
      return result.rows.length;
    });
  }

  /** Delete a single row by primary key. Returns 'not_found' if zero rows affected. */
  async deleteOne(
    schema: string,
    tableName: string,
    recordId: string | number,
    primaryId: string,
  ): Promise<void | 'not_found'> {
    const count = await this.knex(`${schema}.${tableName}`).where(primaryId, recordId).del();

    if (count === 0) {
      return 'not_found';
    }
    if (count > 1) {
      throw new KnexPGClientError(
        `DELETE affected ${count} rows (expected 1) for ${schema}.${tableName} where ${primaryId} = ${String(recordId)}`,
        'DELETE_MULTIPLE_ROWS',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class KnexPGClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'KnexPGClientError';
  }
}
