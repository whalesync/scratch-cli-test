import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { PostgresColumnInfo, PostgresForeignKey } from './postgres-types';

export class PostgresClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PostgresClientError';
  }
}

/**
 * Low-level PostgreSQL client wrapping pg.Pool.
 * Handles connection management, schema discovery, and CRUD operations.
 * All table/column names are validated against information_schema before use.
 */
export class PostgresClient {
  private readonly pool: Pool;

  /** Cache of validated table names to avoid repeated information_schema queries */
  private validatedTables: Set<string> | null = null;

  constructor(connectionString: string) {
    const config: PoolConfig = {
      connectionString,
      max: 5,
      // 10 second connection timeout
      connectionTimeoutMillis: 10_000,
      // 30 second query timeout
      statement_timeout: 30_000,
    };
    this.pool = new Pool(config);
    // Prevent idle connection errors (e.g. 57P01 from pg_terminate_backend) from
    // propagating as unhandled 'error' events and crashing the process.
    this.pool.on('error', (err) => {
      console.warn('[postgres-client] idle pool connection error', (err as NodeJS.ErrnoException).code, err.message);
    });
  }

  /**
   * Test the connection by running a simple query.
   */
  async testConnection(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
    } catch (error) {
      throw new PostgresClientError(
        `Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : String(error)}`,
        this.extractPgErrorCode(error),
      );
    }
  }

  /**
   * List all user tables in the public schema.
   */
  async listTables(): Promise<string[]> {
    const result = await this.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tables = result.rows.map((row) => row.table_name);
    this.validatedTables = new Set(tables);
    return tables;
  }

  /**
   * Get column metadata for a table.
   */
  async getTableColumns(tableName: string): Promise<PostgresColumnInfo[]> {
    await this.validateTableName(tableName);

    const result = await this.pool.query<PostgresColumnInfo>(
      `SELECT column_name, data_type, is_nullable, udt_name, character_maximum_length, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName],
    );
    return result.rows;
  }

  /**
   * Get the primary key column name for a table.
   * Falls back to 'id' if no primary key is found.
   */
  async getPrimaryKeyColumn(tableName: string): Promise<string> {
    await this.validateTableName(tableName);

    const result = await this.pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = 'public'
         AND tc.table_name = $1
       LIMIT 1`,
      [tableName],
    );

    return result.rows[0]?.column_name ?? 'id';
  }

  /**
   * Get single-column foreign key constraints for a table.
   */
  async getForeignKeys(tableName: string): Promise<PostgresForeignKey[]> {
    await this.validateTableName(tableName);

    const result = await this.pool.query<PostgresForeignKey>(
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
         AND cl.relname = $1 AND n.nspname = 'public'`,
      [tableName],
    );
    return result.rows;
  }

  /**
   * Select rows with pagination.
   */
  async selectRows(tableName: string, limit: number, offset: number): Promise<Record<string, unknown>[]> {
    await this.validateTableName(tableName);
    const quotedTable = this.quoteIdentifier(tableName);

    const result = await this.pool.query(`SELECT * FROM ${quotedTable} LIMIT $1 OFFSET $2`, [limit, offset]);
    return result.rows as Record<string, unknown>[];
  }

  /**
   * Select rows by primary key values using a parameterized WHERE IN query.
   */
  async selectByIds(tableName: string, pkColumn: string, ids: (string | number)[]): Promise<Record<string, unknown>[]> {
    if (ids.length === 0) return [];

    await this.validateTableName(tableName);
    const quotedTable = this.quoteIdentifier(tableName);
    const quotedPk = this.quoteIdentifier(pkColumn);

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await this.pool.query(`SELECT * FROM ${quotedTable} WHERE ${quotedPk} IN (${placeholders})`, ids);
    return result.rows as Record<string, unknown>[];
  }

  /**
   * Insert a row and return the inserted data.
   */
  async insertRow(tableName: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows = await this.insertRows(tableName, [data]);
    return rows[0];
  }

  /**
   * Insert multiple rows in a single atomic statement and return the inserted data.
   */
  async insertRows(tableName: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return [];

    await this.validateTableName(tableName);
    const tableColumns = await this.getTableColumns(tableName);
    const quotedTable = this.quoteIdentifier(tableName);
    const insertedRows: Record<string, unknown>[] = [];

    return this.withTransaction(async (tx) => {
      for (const row of rows) {
        const columns = this.getValidatedColumnsInTableOrderFromColumns(tableName, tableColumns, Object.keys(row));
        const quotedColumns = columns.map((column) => this.quoteIdentifier(column));
        const placeholders = columns.map((_, index) => `$${index + 1}`);
        const values = columns.map((column) => row[column]);

        const result = await tx.query(
          `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
          values,
        );
        insertedRows.push(result.rows[0] as Record<string, unknown>);
      }

      return insertedRows;
    });
  }

  /**
   * Update a row by primary key.
   */
  async updateRow(tableName: string, pkColumn: string, id: unknown, data: Record<string, unknown>): Promise<void> {
    await this.updateRows(tableName, pkColumn, [{ id, data }]);
  }

  /**
   * Update multiple rows in a single atomic statement.
   */
  async updateRows(
    tableName: string,
    pkColumn: string,
    rows: { id: unknown; data: Record<string, unknown> }[],
  ): Promise<void> {
    if (rows.length === 0) return;

    await this.validateTableName(tableName);
    const tableColumns = await this.getTableColumns(tableName);
    const quotedTable = this.quoteIdentifier(tableName);
    const quotedPk = this.quoteIdentifier(pkColumn);

    await this.withTransaction(async (tx) => {
      for (const row of rows) {
        const columns = this.getValidatedColumnsInTableOrderFromColumns(tableName, tableColumns, Object.keys(row.data));
        const setClauses = columns.map((column, index) => `${this.quoteIdentifier(column)} = $${index + 2}`);
        const values = [row.id, ...columns.map((column) => row.data[column])];

        await tx.query(`UPDATE ${quotedTable} SET ${setClauses.join(', ')} WHERE ${quotedPk}::text = $1::text`, values);
      }
    });
  }

  /**
   * Delete a row by primary key.
   */
  async deleteRow(tableName: string, pkColumn: string, id: unknown): Promise<void> {
    await this.deleteRows(tableName, pkColumn, [id]);
  }

  /**
   * Delete multiple rows in a single atomic statement.
   */
  async deleteRows(tableName: string, pkColumn: string, ids: unknown[]): Promise<void> {
    if (ids.length === 0) return;

    await this.validateTableName(tableName);
    const quotedTable = this.quoteIdentifier(tableName);
    const quotedPk = this.quoteIdentifier(pkColumn);

    await this.withTransaction(async (tx) => {
      for (const id of ids) {
        await tx.query(`DELETE FROM ${quotedTable} WHERE ${quotedPk}::text = $1::text`, [id]);
      }
    });
  }

  /**
   * End the connection pool.
   */
  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Validate a table name exists in information_schema.
   * Prevents SQL injection via table names.
   */
  private async validateTableName(tableName: string): Promise<void> {
    if (!this.validatedTables) {
      await this.listTables();
    }
    if (!this.validatedTables!.has(tableName)) {
      throw new PostgresClientError(`Table "${tableName}" does not exist in the public schema`);
    }
  }

  /**
   * Validate column names exist in the table and return only valid ones.
   */
  private async getValidatedColumns(tableName: string, requestedColumns: string[]): Promise<string[]> {
    const columns = await this.getTableColumns(tableName);
    return this.getValidatedColumnsInTableOrderFromColumns(tableName, columns, requestedColumns);
  }

  /**
   * Validate column names and return them in table order for deterministic SQL generation.
   */
  private async getValidatedColumnsInTableOrder(tableName: string, requestedColumns: string[]): Promise<string[]> {
    const columns = await this.getTableColumns(tableName);
    return this.getValidatedColumnsInTableOrderFromColumns(tableName, columns, requestedColumns);
  }

  private getValidatedColumnsInTableOrderFromColumns(
    tableName: string,
    tableColumns: PostgresColumnInfo[],
    requestedColumns: string[],
  ): string[] {
    const requested = new Set(requestedColumns);
    const validated = tableColumns.map((column) => column.column_name).filter((column) => requested.has(column));
    if (validated.length === 0) {
      throw new PostgresClientError(`No valid columns found for table "${tableName}"`);
    }
    return validated;
  }

  private async withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      const result = await fn(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }

  /**
   * Quote an identifier (table or column name) to prevent SQL injection.
   */
  private quoteIdentifier(name: string): string {
    // Replace any double quotes with two double quotes (standard SQL escaping)
    return `"${name.replace(/"/g, '""')}"`;
  }

  private extractPgErrorCode(error: unknown): string | undefined {
    if (error && typeof error === 'object' && 'code' in error) {
      return String((error as { code: string }).code);
    }
    return undefined;
  }
}
