/**
 * Live Export DDL for an OAuth Supabase connection, run as the project's own `postgres` role
 * (DEV-12084).
 *
 * An OAuth token authorizes the Management API, not Postgres, so the only Postgres login an OAuth
 * connection has is the data role Scratch provisions for itself (`whalesync_svc_…`). Running DDL
 * over that role made it the OWNER of every schema and table a Live Export created in the customer's
 * database. The Management API's `POST /projects/{ref}/database/query` endpoint runs SQL as the
 * project's `postgres` role instead — the owner the Supabase dashboard and `supabase db push` use —
 * so what an export creates belongs to the customer's own tooling, and the data role is granted only
 * what it needs to read and write rows.
 *
 * Each call is ONE request whose statements are wrapped in `BEGIN; … COMMIT;`, so a statement that
 * fails part-way (a foreign key `postgres` may not reference, say) rolls the whole call back and
 * leaves nothing behind for the caller's fallback to trip over.
 *
 * The DDL is the same `KnexPGClient` runs, rendered to text by
 * `pg-common/pg-create-schema-standalone-sql.ts`. A sibling of
 * {@link SupabaseManagementApiCatalogReader}, which does the same for catalog reads.
 */
import { type ResolvedCreateFieldSpec } from '../../schema-creation.types';
import {
  renderAddColumnsAsStandaloneSqlStatements,
  renderCreateSchemaIfNotExistsAsStandaloneSqlStatements,
  renderCreateTableAsStandaloneSqlStatements,
  renderGrantDefaultTableDataManipulationPrivilegesInSchemaToRoleAsStandaloneSql,
  renderGrantSchemaUsageToRoleAsStandaloneSql,
  renderGrantTableDataManipulationPrivilegesToRoleAsStandaloneSql,
  type ForeignKeyResolutions,
} from '../pg-common';
import { SupabaseApiClient } from './supabase-api-client';

export class SupabaseManagementApiDdlExecutor {
  constructor(
    private readonly apiClient: SupabaseApiClient,
    private readonly projectRef: string,
    /** The connection's own data role (`whalesync_svc_…`): granted row access, never ownership. */
    private readonly dataRoleName: string,
  ) {}

  /**
   * Mirrors `KnexPGClient.createTable`, plus the grant that lets the data role use the table.
   *
   * With `createSchemaIfMissing` (the "New schema" destination) the schema is provisioned in the
   * same transaction: created if absent, USAGE granted to the data role, and the data role given row
   * access by default on every table `postgres` creates in it from now on. One transaction means a
   * refused statement rolls the schema back too, so the caller's data-role fallback can create both,
   * exactly as it did before DDL moved here.
   */
  async createTable(
    schema: string,
    tableName: string,
    fields: ResolvedCreateFieldSpec[],
    foreignKeyResolutions: ForeignKeyResolutions,
    options: { createSchemaIfMissing: boolean },
  ): Promise<{ skippedFields: Map<string, string> }> {
    const { statements: createTableStatements, skippedFields } = renderCreateTableAsStandaloneSqlStatements(
      schema,
      tableName,
      fields,
      foreignKeyResolutions,
    );
    await this.runStatementsInOneTransaction([
      ...(options.createSchemaIfMissing ? this.buildCreateSchemaAndGrantDataRoleAccessStatements(schema) : []),
      ...createTableStatements,
      renderGrantTableDataManipulationPrivilegesToRoleAsStandaloneSql(schema, tableName, this.dataRoleName),
    ]);
    return { skippedFields };
  }

  /**
   * Mirrors `KnexPGClient.addColumns`: when every field is skipped there is nothing to add, and no
   * request is made at all. A new column needs no grant of its own; the table's grant covers it.
   */
  async addColumns(
    schema: string,
    tableName: string,
    fields: ResolvedCreateFieldSpec[],
    foreignKeyResolutions: ForeignKeyResolutions,
  ): Promise<{ skippedFields: Map<string, string> }> {
    const { statements: addColumnStatements, skippedFields } = renderAddColumnsAsStandaloneSqlStatements(
      schema,
      tableName,
      fields,
      foreignKeyResolutions,
    );
    if (addColumnStatements.length > 0) {
      await this.runStatementsInOneTransaction(addColumnStatements);
    }
    return { skippedFields };
  }

  private buildCreateSchemaAndGrantDataRoleAccessStatements(schema: string): string[] {
    return [
      ...renderCreateSchemaIfNotExistsAsStandaloneSqlStatements(schema),
      renderGrantSchemaUsageToRoleAsStandaloneSql(schema, this.dataRoleName),
      renderGrantDefaultTableDataManipulationPrivilegesInSchemaToRoleAsStandaloneSql(schema, this.dataRoleName),
    ];
  }

  private async runStatementsInOneTransaction(statements: string[]): Promise<void> {
    await this.apiClient.executeQuery(this.projectRef, `${['begin', ...statements, 'commit'].join(';\n')};`);
  }
}
