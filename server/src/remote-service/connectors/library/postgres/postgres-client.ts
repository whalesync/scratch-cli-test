import { Pool, type PoolConfig } from 'pg';
import { PostgresColumnInfo } from './postgres-types';

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
    await this.validateTableName(tableName);
    const columns = await this.getValidatedColumns(tableName, Object.keys(data));
    const quotedTable = this.quoteIdentifier(tableName);

    const quotedColumns = columns.map((c) => this.quoteIdentifier(c));
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const values = columns.map((c) => data[c]);

    const result = await this.pool.query(
      `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values,
    );
    return result.rows[0] as Record<string, unknown>;
  }

  /**
   * Update a row by primary key.
   */
  async updateRow(tableName: string, pkColumn: string, id: unknown, data: Record<string, unknown>): Promise<void> {
    await this.validateTableName(tableName);
    const columns = await this.getValidatedColumns(tableName, Object.keys(data));
    const quotedTable = this.quoteIdentifier(tableName);
    const quotedPk = this.quoteIdentifier(pkColumn);

    const setClauses = columns.map((c, i) => `${this.quoteIdentifier(c)} = $${i + 2}`);
    const values = [id, ...columns.map((c) => data[c])];

    await this.pool.query(`UPDATE ${quotedTable} SET ${setClauses.join(', ')} WHERE ${quotedPk} = $1`, values);
  }

  /**
   * Delete a row by primary key.
   */
  async deleteRow(tableName: string, pkColumn: string, id: unknown): Promise<void> {
    await this.validateTableName(tableName);
    const quotedTable = this.quoteIdentifier(tableName);
    const quotedPk = this.quoteIdentifier(pkColumn);

    await this.pool.query(`DELETE FROM ${quotedTable} WHERE ${quotedPk} = $1`, [id]);
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
    const validColumnNames = new Set(columns.map((c) => c.column_name));

    const validated = requestedColumns.filter((col) => validColumnNames.has(col));
    if (validated.length === 0) {
      throw new PostgresClientError(`No valid columns found for table "${tableName}"`);
    }
    return validated;
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
