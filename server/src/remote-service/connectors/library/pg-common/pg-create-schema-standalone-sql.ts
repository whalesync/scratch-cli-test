/**
 * Live Export DDL rendered as standalone SQL text (DEV-12084).
 *
 * The create-schema builders in `pg-create-schema.ts` normally run through a live
 * {@link KnexPGClient}. Supabase has a second executor for them: its Management API's
 * `POST /projects/{ref}/database/query` endpoint, which runs a SQL *string* as the project's own
 * `postgres` role. That is how an OAuth Supabase connection creates the schemas and tables a Live
 * Export writes into without our data role ending up as their owner. The endpoint takes no bind
 * parameters, so every statement is rendered to self-contained text here, from the same builders
 * and with the same identifier hooks the live client uses, so both paths emit the same DDL.
 *
 * Two knex details shape the rendering:
 *
 *  - A schema builder compiles (`.toSQL()`) to one `{ sql, bindings }` per statement: `CREATE
 *    TABLE`, then one `ALTER TABLE … ADD CONSTRAINT` per foreign key. These builders bind nothing,
 *    so a statement that ever carries a binding is refused rather than sent with a placeholder
 *    nothing will fill.
 *  - The compiled SQL still carries knex's `\?` escape for a literal `?` in a column name (see
 *    `escapeKnexColumnIdentifierSpecialCharacters`); the live driver un-escapes it while numbering
 *    placeholders. Sent as compiled, a column named `Featured?` would be created as `Featured\?`.
 *    Each statement therefore goes through knex's own formatter (`raw(sql).toQuery()`), which
 *    un-escapes it and leaves any other `?` alone — exactly the text `.toString()` produces.
 */
import knex, { type Knex } from 'knex';
import { type ResolvedCreateFieldSpec } from '../../schema-creation.types';
import { applyVerbatimIdentifierQuoting } from './knex-column-identifier-dot-encoding';
import { buildAddColumnsQuery, buildCreateTableQuery, type ForeignKeyResolutions } from './pg-create-schema';

/** The table privileges a role needs to read and write rows, and nothing more (no TRUNCATE, REFERENCES, TRIGGER). */
const TABLE_DATA_MANIPULATION_PRIVILEGES = 'select, insert, update, delete';

/** Rendered DDL statements, plus the per-field skip reasons the builder reported while compiling them. */
export interface StandaloneDdlStatements {
  statements: string[];
  /** Fields that could not become a column, keyed by field name — the same map `KnexPGClient` returns. */
  skippedFields: Map<string, string>;
}

/**
 * A connection-less knex used solely as a DDL *formatter*, with the identifier hooks
 * `KnexPGClient` installs, so a column name containing `.`, `" as "` or `?` comes out as the same
 * single quoted identifier on both paths. Separate from the catalog-query formatter in
 * `pg-catalog-queries.ts`, which deliberately has no hooks.
 */
let ddlFormattingKnexInstance: Knex | undefined;

function getDdlFormattingKnexInstance(): Knex {
  if (!ddlFormattingKnexInstance) {
    ddlFormattingKnexInstance = knex({ client: 'pg' });
    applyVerbatimIdentifierQuoting(ddlFormattingKnexInstance);
  }
  return ddlFormattingKnexInstance;
}

/**
 * Render compiled schema-builder statements as standalone SQL, one string per statement. Throws if
 * a statement carries a binding: the executor this feeds has no way to bind it.
 */
export function renderCompiledDdlStatementsAsStandaloneSql(
  compiledStatements: readonly Pick<Knex.Sql, 'sql' | 'bindings'>[],
): string[] {
  return compiledStatements.map((compiledStatement) => {
    if (compiledStatement.bindings.length > 0) {
      throw new Error(
        `Cannot render a DDL statement that carries ${compiledStatement.bindings.length} binding(s) as standalone SQL: ${compiledStatement.sql}`,
      );
    }
    return getDdlFormattingKnexInstance().raw(compiledStatement.sql).toQuery();
  });
}

/** Mirrors `KnexPGClient.createTable`: `CREATE TABLE` plus one constraint statement per foreign key. */
export function renderCreateTableAsStandaloneSqlStatements(
  schema: string,
  tableName: string,
  fields: ResolvedCreateFieldSpec[],
  foreignKeyResolutions: ForeignKeyResolutions,
): StandaloneDdlStatements {
  const skippedFields = new Map<string, string>();
  const compiledStatements = buildCreateTableQuery(
    getDdlFormattingKnexInstance(),
    schema,
    tableName,
    fields,
    foreignKeyResolutions,
    skippedFields,
  ).toSQL();
  return { statements: renderCompiledDdlStatementsAsStandaloneSql(compiledStatements), skippedFields };
}

/**
 * Mirrors `KnexPGClient.addColumns`. When every field is skipped there is nothing to add, and the
 * statement list comes back empty rather than as a bare `ALTER TABLE`.
 */
export function renderAddColumnsAsStandaloneSqlStatements(
  schema: string,
  tableName: string,
  fields: ResolvedCreateFieldSpec[],
  foreignKeyResolutions: ForeignKeyResolutions,
): StandaloneDdlStatements {
  const skippedFields = new Map<string, string>();
  const compiledStatements = buildAddColumnsQuery(
    getDdlFormattingKnexInstance(),
    schema,
    tableName,
    fields,
    foreignKeyResolutions,
    skippedFields,
  ).toSQL();
  return { statements: renderCompiledDdlStatementsAsStandaloneSql(compiledStatements), skippedFields };
}

/** Mirrors `KnexPGClient.createSchemaIfNotExists`. */
export function renderCreateSchemaIfNotExistsAsStandaloneSqlStatements(schema: string): string[] {
  return renderCompiledDdlStatementsAsStandaloneSql(
    getDdlFormattingKnexInstance().schema.createSchemaIfNotExists(schema).toSQL(),
  );
}

/**
 * `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE <schema>.<table> TO <role>`. The table reference
 * goes through the same identifier formatter as `withSchema(schema).createTable(tableName)`, so it
 * names exactly the table the CREATE TABLE statement made.
 */
export function renderGrantTableDataManipulationPrivilegesToRoleAsStandaloneSql(
  schema: string,
  tableName: string,
  roleName: string,
): string {
  return getDdlFormattingKnexInstance()
    .raw(`grant ${TABLE_DATA_MANIPULATION_PRIVILEGES} on table ?? to ??`, [`${schema}.${tableName}`, roleName])
    .toQuery();
}

/** `GRANT USAGE ON SCHEMA <schema> TO <role>`: lets the role reach the tables it is granted inside the schema. */
export function renderGrantSchemaUsageToRoleAsStandaloneSql(schema: string, roleName: string): string {
  return getDdlFormattingKnexInstance().raw('grant usage on schema ?? to ??', [schema, roleName]).toQuery();
}

/**
 * `ALTER DEFAULT PRIVILEGES IN SCHEMA <schema> GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
 * <role>`: every table the *executing* role creates in the schema from now on is granted to `role`
 * as well, including tables created later by other tooling running as that same role.
 */
export function renderGrantDefaultTableDataManipulationPrivilegesInSchemaToRoleAsStandaloneSql(
  schema: string,
  roleName: string,
): string {
  return getDdlFormattingKnexInstance()
    .raw(`alter default privileges in schema ?? grant ${TABLE_DATA_MANIPULATION_PRIVILEGES} on tables to ??`, [
      schema,
      roleName,
    ])
    .toQuery();
}
