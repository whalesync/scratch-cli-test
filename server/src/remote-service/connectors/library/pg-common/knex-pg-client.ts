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
  decodeColumnIdentifierSentinelDots,
  encodeColumnIdentifierDotsForKnex,
  escapeKnexColumnIdentifierSpecialCharacters,
} from './knex-column-identifier-dot-encoding';
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
 * Make a column name safe for knex's query builder — delegates to the shared
 * {@link escapeKnexColumnIdentifierSpecialCharacters} (`?` binding-placeholder
 * escape + DEV-11063 dot sentinel), which the DDL side (`pg-create-schema.ts`)
 * uses too. Apply to column identifiers only, never to a `schema.table`
 * reference.
 */
function escapeKnexSpecialCharacters(column: string): string {
  return escapeKnexColumnIdentifierSpecialCharacters(column);
}

/**
 * Undo knex's identifier alias-splitting for a column whose real name contains `" as "`.
 *
 * Knex's identifier formatter treats a bare `" as "` inside any identifier as SQL aliasing and
 * rewrites e.g. `"Marked as done time"` into `"Marked" as "done time"` — silently corrupting the
 * column name in CREATE / INSERT / SELECT / UPDATE for any Postgres/Supabase column whose name
 * contains " as " (a legitimate name we must preserve verbatim — Connector Prime Directive). There
 * is no config hook to disable the split: it happens in knex's module-level `wrapString` BEFORE the
 * `wrapIdentifier` hook runs. But knex funnels every such split through `client.alias(first, second)`
 * with both halves already quoted, and this client never emits an intentional SQL alias through the
 * query builder (the only `... AS ...` it uses lives inside `knex.raw` strings, which bypass this
 * path). So overriding `alias` to rejoin the halves into one correctly-quoted identifier is a safe,
 * global fix. Each half is a `wrapIdentifierImpl` result (`"…"` with any inner `"` doubled); we
 * unwrap both, rejoin with " as ", and re-quote. (DEV-11051)
 */
function rejoinKnexAliasSplitIdentifier(quotedFirstHalf: string, quotedSecondHalf: string): string {
  const unwrapQuotedIdentifier = (quoted: string): string =>
    quoted.replace(/^"/, '').replace(/"$/, '').replace(/""/g, '"');
  const rejoinedIdentifier = `${unwrapQuotedIdentifier(quotedFirstHalf)} as ${unwrapQuotedIdentifier(quotedSecondHalf)}`;
  return `"${rejoinedIdentifier.replace(/"/g, '""')}"`;
}

/**
 * Install the identifier-preserving hooks on a knex instance so a Postgres column name survives
 * verbatim through knex's formatter even when it contains a substring knex would otherwise treat as
 * structure (Connector Prime Directive):
 *
 *  - `" as "` — override `client.alias` to rejoin the mis-split halves ({@link
 *    rejoinKnexAliasSplitIdentifier}, DEV-11051).
 *  - `.` — install a `wrapIdentifier` hook that decodes the sentinel a column name's dots were
 *    encoded to ({@link decodeColumnIdentifierSentinelDots}, DEV-11063) back to a literal `.` before
 *    the default quoting, so the encoded name is emitted as one identifier (`"Dealroom.co URL"`).
 *
 * Exported so tests can build SQL strings through a connection-less knex with the same behavior the
 * {@link KnexPGClient} constructor applies. `knex.client` is typed `any`; narrow it to just the two
 * hooks we replace.
 */
export function applyVerbatimIdentifierQuoting(knexInstance: Knex): void {
  const knexClientHooks = knexInstance.client as {
    alias: (first: string, second: string) => string;
    config: { wrapIdentifier?: (value: string, origImpl: (value: string) => string) => string };
  };
  knexClientHooks.alias = rejoinKnexAliasSplitIdentifier;
  knexClientHooks.config.wrapIdentifier = (value, origImpl) => origImpl(decodeColumnIdentifierSentinelDots(value));
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

    // Preserve column names containing " as " (e.g. Pipedrive's "Marked as done time") verbatim
    // across CREATE / INSERT / SELECT / UPDATE — see {@link rejoinKnexAliasSplitIdentifier}.
    applyVerbatimIdentifierQuoting(this.knex);
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
   * List all tables and views excluding specified schemas and LIKE patterns.
   * Used by the Supabase and Postgres connectors to discover tables across all
   * user schemas. Materialized views are absent from `information_schema.tables`
   * entirely, so they're unioned in from `pg_class` (relkind 'm') with the
   * synthetic table_type 'MATERIALIZED VIEW' — mirroring how information_schema
   * labels the other relation kinds ('BASE TABLE', 'VIEW', 'FOREIGN').
   */
  async findAllTablesExcludingSchemas(excludedSchemas: string[], excludePatterns?: string[]): Promise<TableName[]> {
    const patterns = excludePatterns ?? [];
    const schemaPlaceholders = excludedSchemas.map(() => '?').join(', ');
    const informationSchemaPatternClauses = patterns.map(() => 'AND table_schema NOT LIKE ?').join('\n         ');
    const matviewPatternClauses = patterns.map(() => 'AND n.nspname NOT LIKE ?').join('\n         ');
    const result = await this.knex.raw<{ rows: TableName[] }>(
      `SELECT table_name, table_schema, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN (${schemaPlaceholders})
         ${informationSchemaPatternClauses}
       UNION ALL
       SELECT c.relname AS table_name, n.nspname AS table_schema, 'MATERIALIZED VIEW' AS table_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'm'
         AND n.nspname NOT IN (${schemaPlaceholders})
         ${matviewPatternClauses}`,
      [...excludedSchemas, ...patterns, ...excludedSchemas, ...patterns],
    );
    return result.rows;
  }

  /**
   * Get column metadata for a table or view. Materialized views have no
   * `information_schema.columns` rows at all, so an empty result falls back to
   * an equivalent `pg_attribute`-based query for them.
   */
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
    if (result.rows.length > 0) {
      return result.rows;
    }
    return this.findAllColumnsInMaterializedView(schema, tableName);
  }

  /**
   * Column metadata for a MATERIALIZED VIEW, synthesized from `pg_attribute`
   * into the {@link InformationSchemaColumn} shape (information_schema skips
   * matviews entirely). The `data_type` CASE mirrors how information_schema
   * derives its value ('ARRAY' for arrays, the formatted name for pg_catalog
   * types, 'USER-DEFINED' otherwise — domain-typed columns land in
   * 'USER-DEFINED' rather than resolving the base type, a fidelity loss
   * accepted for this rare combination). Matview columns are never updatable
   * and carry no defaults or identity, so those fields are constants.
   * Returns [] for anything that isn't a materialized view.
   */
  private async findAllColumnsInMaterializedView(
    schema: string,
    tableName: string,
  ): Promise<InformationSchemaColumn[]> {
    const result = await this.knex.raw<{ rows: InformationSchemaColumn[] }>(
      `SELECT
         a.attname AS column_name,
         CASE
           WHEN t.typelem <> 0 AND t.typlen = -1 THEN 'ARRAY'
           WHEN tn.nspname = 'pg_catalog' THEN format_type(a.atttypid, NULL)
           ELSE 'USER-DEFINED'
         END AS data_type,
         NULL AS column_default,
         'NO' AS is_updatable,
         CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
         NULL AS domain_name,
         t.typname AS udt_name,
         CASE
           WHEN a.atttypid IN (1042, 1043) AND a.atttypmod >= 4 THEN a.atttypmod - 4
           ELSE NULL
         END AS character_maximum_length,
         'NO' AS is_identity,
         NULL AS identity_increment,
         'NO' AS identity_cycle
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
       JOIN pg_namespace tn ON tn.oid = t.typnamespace
       WHERE n.nspname = ? AND c.relname = ? AND c.relkind = 'm'
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
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

  // ---------------------------------------------------------------------------
  // View addressability (DEV-11136)
  //
  // A view has no indexes of its own, so its addressability comes from PROVENANCE:
  // which base-table column each output column is a plain reference to. Postgres
  // computes this mapping itself — every query's result-row descriptor (the wire
  // protocol's RowDescription, `result.fields` in the pg driver) carries the origin
  // relation OID + attnum (`resorigtbl`/`resorigcol`) per output column. Probing
  // `SELECT * FROM <relation> LIMIT 0` reports the relation itself, so instead we
  // probe the view's DEFINING QUERY (`pg_get_viewdef`) wrapped as a zero-row
  // derived table, which resolves one level of expansion; stacked views are
  // followed by iterating. This is exact where it matters: an output column
  // aliased from a different column, or computed by an expression, is never
  // mis-attributed the way name-matching against view_column_usage would.
  //
  // What provenance still can't prove is row-level uniqueness of the VIEW: a
  // fan-out join can repeat a genuinely PK-backed column's values (a cardinality
  // property of the data, invisible to any static analysis).
  // ---------------------------------------------------------------------------

  /** How many levels of views-defined-over-views to follow before giving up. */
  private static readonly MAX_VIEW_STACK_RESOLUTION_DEPTH = 8;

  /**
   * Probe one view's defining query with a zero-row SELECT and return, per
   * output column, its name and the origin (relation OID + attnum) Postgres
   * reports in the result-row descriptor — `null` origin for computed columns.
   * The origin of a column referencing another view is that VIEW's column;
   * {@link resolveViewOutputColumnBaseOrigins} iterates those down to base
   * relations.
   */
  private async probeViewDefinitionOutputOrigins(
    viewRelationOid: number,
  ): Promise<{ name: string; origin: { relationOid: number; columnAttnum: number } | null }[]> {
    const definitionResult = await this.knex.raw<{ rows: { view_definition_sql: string }[] }>(
      'SELECT pg_get_viewdef(?::oid) AS view_definition_sql',
      [viewRelationOid],
    );
    const viewDefinitionSql = definitionResult.rows[0]?.view_definition_sql;
    if (!viewDefinitionSql) {
      return [];
    }
    // pg_get_viewdef emits a single canonical SELECT with a trailing semicolon;
    // strip it so the statement can be embedded as a derived table. LIMIT 0
    // plans but reads no rows — we only want the result-row descriptor.
    const embeddableDefinitionSql = viewDefinitionSql.replace(/;\s*$/, '');
    const probeResult = await this.knex.raw<{ fields: { name: string; tableID: number; columnID: number }[] }>(
      `SELECT * FROM (${embeddableDefinitionSql}) view_provenance_probe LIMIT 0`,
    );
    return probeResult.fields.map((field) => ({
      name: field.name,
      origin:
        field.tableID !== 0 && field.columnID !== 0
          ? { relationOid: field.tableID, columnAttnum: field.columnID }
          : null,
    }));
  }

  /** relkind per pg_class OID ('r' table, 'v' view, 'm' matview, 'p' partitioned, 'f' foreign). */
  private async findRelationKindsByOid(relationOids: number[]): Promise<Map<number, string>> {
    if (relationOids.length === 0) {
      return new Map();
    }
    const result = await this.knex.raw<{ rows: { oid: number; relkind: string }[] }>(
      'SELECT oid::int AS oid, relkind FROM pg_class WHERE oid = ANY(?)',
      [relationOids],
    );
    return new Map(result.rows.map((row) => [row.oid, row.relkind]));
  }

  /**
   * One view's output columns with their origins resolved all the way down to
   * non-view relations (iterating through stacked views up to
   * {@link MAX_VIEW_STACK_RESOLUTION_DEPTH} levels; columns still pointing at a
   * view after that, or computed by an expression, resolve to a `null` origin).
   * Probe results are memoized by relation OID so a bulk caller resolving many
   * views (or a stack sharing an inner view) probes each view once.
   */
  private async resolveViewOutputColumnBaseOrigins(
    viewRelationOid: number,
    probeResultByRelationOidMemo: Map<
      number,
      { name: string; origin: { relationOid: number; columnAttnum: number } | null }[]
    >,
    relationKindByOidMemo: Map<number, string>,
  ): Promise<{ name: string; origin: { relationOid: number; columnAttnum: number } | null }[]> {
    const probeMemoized = async (relationOid: number) => {
      const memoized = probeResultByRelationOidMemo.get(relationOid);
      if (memoized) {
        return memoized;
      }
      const probed = await this.probeViewDefinitionOutputOrigins(relationOid);
      probeResultByRelationOidMemo.set(relationOid, probed);
      return probed;
    };

    const outputColumns = (await probeMemoized(viewRelationOid)).map((column) => ({ ...column }));
    for (let depth = 0; depth < KnexPGClient.MAX_VIEW_STACK_RESOLUTION_DEPTH; depth++) {
      const originOidsMissingKind = [
        ...new Set(
          outputColumns
            .map((column) => column.origin?.relationOid)
            .filter((oid): oid is number => oid !== undefined && !relationKindByOidMemo.has(oid)),
        ),
      ];
      for (const [oid, relkind] of await this.findRelationKindsByOid(originOidsMissingKind)) {
        relationKindByOidMemo.set(oid, relkind);
      }

      const viewOriginOids = new Set(
        outputColumns
          .map((column) => column.origin?.relationOid)
          .filter((oid): oid is number => oid !== undefined && relationKindByOidMemo.get(oid) === 'v'),
      );
      if (viewOriginOids.size === 0) {
        return outputColumns;
      }
      for (const innerViewOid of viewOriginOids) {
        // A view's attnums are dense and 1-based (view columns can't be
        // dropped), so origin attnum N is the inner view's Nth output column.
        const innerViewOutputColumns = await probeMemoized(innerViewOid);
        for (const column of outputColumns) {
          if (column.origin?.relationOid === innerViewOid) {
            column.origin = innerViewOutputColumns[column.origin.columnAttnum - 1]?.origin ?? null;
          }
        }
      }
    }
    // Still view-backed after the depth cap — treat those columns as unresolved.
    return outputColumns.map((column) => ({
      ...column,
      origin:
        column.origin !== null && relationKindByOidMemo.get(column.origin.relationOid) === 'v' ? null : column.origin,
    }));
  }

  /**
   * For a set of base relations, the (relation OID, attnum) pairs carrying a
   * single-column, non-partial, non-expression, non-deferrable unique index —
   * the same predicate as {@link findSingleColumnUniqueIndexColumns}, keyed by
   * `"<oid>:<attnum>"` for lookup against resolved view-column origins.
   */
  private async findSingleColumnUniqueIndexInfoByRelationColumn(
    relationOids: number[],
  ): Promise<Map<string, { native_type: string; is_primary_key: boolean }>> {
    if (relationOids.length === 0) {
      return new Map();
    }
    const result = await this.knex.raw<{
      rows: { relation_oid: number; column_attnum: number; native_type: string; is_primary_key: boolean }[];
    }>(
      `SELECT i.indrelid::int AS relation_oid,
              a.attnum::int AS column_attnum,
              format_type(a.atttypid, a.atttypmod) AS native_type,
              bool_or(i.indisprimary) AS is_primary_key
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indisunique
         AND array_length(i.indkey, 1) = 1
         AND i.indkey[0] <> 0
         AND i.indpred IS NULL
         AND i.indimmediate
         AND i.indrelid = ANY(?)
       GROUP BY i.indrelid, a.attnum, format_type(a.atttypid, a.atttypmod)`,
      [relationOids],
    );
    return new Map(
      result.rows.map((row) => [
        `${row.relation_oid}:${row.column_attnum}`,
        { native_type: row.native_type, is_primary_key: row.is_primary_key },
      ]),
    );
  }

  /**
   * Resolve a relation's pg_class OID and kind ('r' ordinary table, 'v' view,
   * 'm' materialized view, 'p' partitioned table, 'f' foreign table), or null
   * when the schema holds no relation by that name. One lookup serves callers
   * that need the kind (is this a view?) and callers that need the OID itself
   * (Supabase's dashboard addresses a table in its editor by OID).
   */
  async findRelationOidAndKind(schema: string, relationName: string): Promise<{ oid: number; relkind: string } | null> {
    const result = await this.knex.raw<{ rows: { oid: number; relkind: string }[] }>(
      `SELECT c.oid::int AS oid, c.relkind::text AS relkind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ? AND c.relname = ?`,
      [schema, relationName],
    );
    return result.rows[0] ?? null;
  }

  /** Resolve a view's pg_class OID, or null when no such view exists. */
  async findViewRelationOid(schema: string, viewName: string): Promise<number | null> {
    const relation = await this.findRelationOidAndKind(schema, viewName);
    return relation?.relkind === 'v' ? relation.oid : null;
  }

  /**
   * The views (as "schema.view" strings) that expose at least one output column
   * a record can be addressed by: a column whose resolved base origin (see the
   * provenance notes above) carries a single-column unique index. Views whose
   * probe fails (e.g. the data role lacks SELECT on a base table of a
   * security-definer view) are treated as not addressable rather than failing
   * the whole listing. Note the caveat above: a unique origin column still
   * doesn't prove the VIEW's rows are unique (fan-out joins).
   */
  async findViewsWithUniquelyAddressableColumns(
    excludedSchemas: string[],
    excludePatterns?: string[],
  ): Promise<Set<string>> {
    let viewListQuery = this.knex('information_schema.tables')
      .select<{ table_schema: string; table_name: string }[]>('table_schema', 'table_name')
      .where('table_type', 'VIEW')
      .whereNotIn('table_schema', excludedSchemas);
    for (const pattern of excludePatterns ?? []) {
      viewListQuery = viewListQuery.andWhereNot('table_schema', 'like', pattern);
    }
    const views = await viewListQuery;

    const probeResultByRelationOidMemo = new Map<
      number,
      { name: string; origin: { relationOid: number; columnAttnum: number } | null }[]
    >();
    const relationKindByOidMemo = new Map<number, string>();
    const resolvedOriginsByViewKey = new Map<string, { relationOid: number; columnAttnum: number }[]>();
    for (const view of views) {
      const viewKey = `${view.table_schema}.${view.table_name}`;
      try {
        const viewRelationOid = await this.findViewRelationOid(view.table_schema, view.table_name);
        if (viewRelationOid === null) {
          continue;
        }
        const outputColumns = await this.resolveViewOutputColumnBaseOrigins(
          viewRelationOid,
          probeResultByRelationOidMemo,
          relationKindByOidMemo,
        );
        resolvedOriginsByViewKey.set(
          viewKey,
          outputColumns.flatMap((column) => (column.origin ? [column.origin] : [])),
        );
      } catch {
        // An unprobeable view is simply not addressable; don't fail the listing.
      }
    }

    const allOriginRelationOids = [
      ...new Set([...resolvedOriginsByViewKey.values()].flat().map((origin) => origin.relationOid)),
    ];
    const uniqueIndexInfoByRelationColumn =
      await this.findSingleColumnUniqueIndexInfoByRelationColumn(allOriginRelationOids);

    const addressableViews = new Set<string>();
    for (const [viewKey, origins] of resolvedOriginsByViewKey) {
      const hasUniquelyAddressableColumn = origins.some((origin) =>
        uniqueIndexInfoByRelationColumn.has(`${origin.relationOid}:${origin.columnAttnum}`),
      );
      if (hasUniquelyAddressableColumn) {
        addressableViews.add(viewKey);
      }
    }
    return addressableViews;
  }

  /**
   * The uniquely-addressable column candidates of one VIEW: its output columns
   * whose resolved base origin (see the provenance notes above) carries a
   * single-column unique index — the per-view companion of
   * {@link findViewsWithUniquelyAddressableColumns} (same mechanism), shaped
   * like {@link findSingleColumnUniqueIndexColumns} so callers can feed the
   * result through the same `chooseUniquelyAddressableColumn` path. Ordered
   * primary-key-backed first, then by the view's own column order, so the pick
   * is deterministic. `column_name` is the VIEW's output column name;
   * `is_primary_key`/`native_type` describe the BASE column backing it.
   * Returns [] for anything that isn't a view.
   */
  async findViewUniquelyAddressableColumnCandidates(
    schema: string,
    viewName: string,
  ): Promise<SingleColumnUniqueIndexColumn[]> {
    const viewRelationOid = await this.findViewRelationOid(schema, viewName);
    if (viewRelationOid === null) {
      return [];
    }
    const outputColumns = await this.resolveViewOutputColumnBaseOrigins(viewRelationOid, new Map(), new Map());
    const originRelationOids = [
      ...new Set(outputColumns.flatMap((column) => (column.origin ? [column.origin.relationOid] : []))),
    ];
    const uniqueIndexInfoByRelationColumn =
      await this.findSingleColumnUniqueIndexInfoByRelationColumn(originRelationOids);

    const candidates: SingleColumnUniqueIndexColumn[] = [];
    for (const column of outputColumns) {
      if (!column.origin) {
        continue;
      }
      const uniqueIndexInfo = uniqueIndexInfoByRelationColumn.get(
        `${column.origin.relationOid}:${column.origin.columnAttnum}`,
      );
      if (uniqueIndexInfo) {
        candidates.push({
          column_name: column.name,
          native_type: uniqueIndexInfo.native_type,
          is_primary_key: uniqueIndexInfo.is_primary_key,
        });
      }
    }
    // Primary-key-backed first, otherwise keep the view's own column order
    // (Array.prototype.sort is stable).
    return candidates.sort((a, b) => Number(b.is_primary_key) - Number(a.is_primary_key));
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
    let query = this.knex(`${schema}.${tableName}`)
      .select(selection)
      .orderBy(encodeColumnIdentifierDotsForKnex(primaryId))
      .offset(offset)
      .limit(limit);
    if (filter) {
      query = query.whereRaw(filter);
    }
    if (modifiedSinceColumn && modifiedSinceDatetime) {
      query = query.where(
        this.knex.ref(encodeColumnIdentifierDotsForKnex(modifiedSinceColumn)),
        '>',
        modifiedSinceDatetime,
      );
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
    const rows = (await this.knex(`${schema}.${tableName}`)
      .select(escaped)
      .whereIn(encodeColumnIdentifierDotsForKnex(primaryId), ids)) as Record<string, unknown>[];
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
      .where(encodeColumnIdentifierDotsForKnex(primaryId), recordId)
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
    const count = await this.knex(`${schema}.${tableName}`)
      .where(encodeColumnIdentifierDotsForKnex(primaryId), recordId)
      .del();

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
