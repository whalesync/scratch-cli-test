/**
 * Supabase connector.
 *
 * Hybrid architecture:
 * - SupabaseApiClient (REST) for Management API operations (project listing, DDL, pooler config)
 * - KnexPGClient (Knex/pg) for all DML operations (schema discovery, CRUD)
 *
 * Authenticates via OAuth 2.0 with the Supabase Management API.
 * Data access uses a dedicated PostgreSQL role created during setup.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import { PostgresColumnType, Service, type ConnectorPullOptions } from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector } from '../../connector';
import { sanitizeForTableWsId } from '../../ids';
import { FOREIGN_KEY_OPTIONS } from '../../json-schema';
import {
  type BaseJsonTableSpec,
  type ConnectorErrorDetails,
  type ConnectorFile,
  type EntityId,
  type TablePreview,
} from '../../types';
import {
  isGeneratedColumn,
  KnexPGClient,
  KnexPGClientError,
  SUPABASE_SYSTEM_SCHEMA_PATTERNS,
  SUPABASE_SYSTEM_SCHEMAS,
  TableName,
  type InformationSchemaColumn,
} from '../pg-common';
import { SupabaseApiError } from './supabase-api-client';
import { extractProjectRef } from './supabase-setup-utils';
import { SupabaseCredentials, SupabaseProjectConfig } from './supabase-types';

const READ_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// SQL filter sanitization
// ---------------------------------------------------------------------------

/**
 * SQL keywords that must NEVER appear in a user-provided WHERE filter.
 * Matched as whole words (case-insensitive) to prevent injection attacks.
 */
const DANGEROUS_SQL_KEYWORDS = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'EXECUTE',
  'COPY',
  'SET',
  'EXPLAIN',
  'VACUUM',
  'REINDEX',
  'COMMENT',
  'LOCK',
  'NOTIFY',
  'LISTEN',
  'UNLISTEN',
  'LOAD',
  'DO',
  'CALL',
  'IMPORT',
  'EXPORT',
  'RAISE',
  'PERFORM',
  'RETURNING',
  'INTO',
  'WITH',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'VALUES',
  'TABLE',
];

/**
 * Dangerous PostgreSQL functions that could cause side-effects or data exfiltration.
 * Matched case-insensitively followed by an opening parenthesis.
 */
const DANGEROUS_FUNCTIONS = [
  'pg_sleep',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'lo_import',
  'lo_export',
  'lo_unlink',
  'dblink',
  'dblink_exec',
  'dblink_connect',
  'copy_to',
  'copy_from',
  'query_to_xml',
  'query_to_xml_and_xmlschema',
  'query_to_json',
  'currval',
  'nextval',
  'setval',
  'txid_current',
  'set_config',
  'current_setting',
  'pg_advisory_lock',
  'pg_advisory_unlock',
  'pg_advisory_xact_lock',
  'inet_server_addr',
  'inet_server_port',
];

const DANGEROUS_KEYWORDS_PATTERN = new RegExp(`\\b(${DANGEROUS_SQL_KEYWORDS.join('|')})\\b`, 'i');
const DANGEROUS_FUNCTIONS_PATTERN = new RegExp(`\\b(${DANGEROUS_FUNCTIONS.join('|')})\\s*\\(`, 'i');

/**
 * Validate that a user-provided SQL filter expression is safe for use in a WHERE clause.
 *
 * Allows: column comparisons, AND/OR/NOT, IS NULL, IN (...), BETWEEN, LIKE/ILIKE,
 *         string/number literals, parenthesized grouping, boolean TRUE/FALSE.
 *
 * Rejects: DDL/DML statements, subqueries, dangerous functions, multi-statement injection,
 *          SQL comments, and escape sequences.
 *
 * @throws {KnexPGClientError} if the filter contains dangerous SQL constructs.
 */
function validateWhereFilter(filter: string): void {
  // Block semicolons (multi-statement injection)
  if (filter.includes(';')) {
    throw new KnexPGClientError('Filter contains invalid character: ";"', 'INVALID_FILTER');
  }

  // Block SQL comments
  if (filter.includes('--') || filter.includes('/*')) {
    throw new KnexPGClientError('Filter must not contain SQL comments', 'INVALID_FILTER');
  }

  // Block dollar-quoting (PostgreSQL alternative string syntax that can bypass keyword checks)
  if (filter.includes('$$') || /\$[a-zA-Z_]\w*\$/.test(filter)) {
    throw new KnexPGClientError('Filter must not contain dollar-quoting', 'INVALID_FILTER');
  }

  // Block dangerous SQL keywords
  if (DANGEROUS_KEYWORDS_PATTERN.test(filter)) {
    throw new KnexPGClientError('Filter contains disallowed SQL keyword', 'INVALID_FILTER');
  }

  // Block dangerous functions
  if (DANGEROUS_FUNCTIONS_PATTERN.test(filter)) {
    throw new KnexPGClientError('Filter contains disallowed SQL function', 'INVALID_FILTER');
  }
}

/** JSON Schema extension keys (from CONNECTOR_GUIDE.md). */
const READONLY_FLAG = 'x-scratch-readonly';
const CONNECTOR_DATA_TYPE = 'x-scratch-connector-data-type';

// ---------------------------------------------------------------------------
// PostgreSQL type mapping (same logic as the existing PostgresConnector)
// ---------------------------------------------------------------------------

const PG_NUMERIC_TYPES = new Set([
  'integer',
  'bigint',
  'smallint',
  'serial',
  'bigserial',
  'numeric',
  'decimal',
  'real',
  'double precision',
  'float',
  'float4',
  'float8',
  'int2',
  'int4',
  'int8',
]);
const PG_BOOLEAN_TYPES = new Set(['boolean', 'bool']);
const PG_TEXT_TYPES = new Set(['text', 'varchar', 'char', 'character varying', 'character', 'uuid', 'citext']);
const PG_TIMESTAMP_TYPES = new Set([
  'timestamp',
  'timestamp without time zone',
  'timestamp with time zone',
  'timestamptz',
]);
const PG_DATE_TYPES = new Set(['date']);
const PG_JSON_TYPES = new Set(['json', 'jsonb']);

function mapScalarPgType(typeName: string): { schema: TSchema; pgType: PostgresColumnType } {
  const t = typeName.toLowerCase();
  if (PG_NUMERIC_TYPES.has(t)) return { schema: Type.Number(), pgType: PostgresColumnType.NUMERIC };
  if (PG_BOOLEAN_TYPES.has(t)) return { schema: Type.Boolean(), pgType: PostgresColumnType.BOOLEAN };
  if (PG_TEXT_TYPES.has(t)) return { schema: Type.String(), pgType: PostgresColumnType.TEXT };
  if (PG_TIMESTAMP_TYPES.has(t))
    return { schema: Type.String({ format: 'date-time' }), pgType: PostgresColumnType.TIMESTAMP };
  if (PG_DATE_TYPES.has(t)) return { schema: Type.String({ format: 'date' }), pgType: PostgresColumnType.TIMESTAMP };
  if (PG_JSON_TYPES.has(t)) return { schema: Type.Unknown(), pgType: PostgresColumnType.JSONB };
  return { schema: Type.Unknown(), pgType: PostgresColumnType.TEXT };
}

function mapPgType(
  dataType: string,
  udtName: string,
  isNullable: boolean,
): { schema: TSchema; pgType: PostgresColumnType } {
  let schema: TSchema;
  let pgType: PostgresColumnType;

  if (dataType === 'ARRAY' || udtName.startsWith('_')) {
    const elementUdtName = udtName.startsWith('_') ? udtName.slice(1) : udtName;
    const elementMapping = mapScalarPgType(elementUdtName);
    if (elementMapping.pgType === PostgresColumnType.NUMERIC) {
      schema = Type.Array(Type.Number());
      pgType = PostgresColumnType.NUMERIC_ARRAY;
    } else if (elementMapping.pgType === PostgresColumnType.BOOLEAN) {
      schema = Type.Array(Type.Boolean());
      pgType = PostgresColumnType.BOOLEAN_ARRAY;
    } else {
      schema = Type.Array(Type.String());
      pgType = PostgresColumnType.TEXT_ARRAY;
    }
  } else {
    const mapping = mapScalarPgType(udtName.length > 0 ? udtName : dataType);
    schema = mapping.schema;
    pgType = mapping.pgType;
  }

  if (isNullable) {
    schema = Type.Union([schema, Type.Null()]);
  }

  return { schema, pgType };
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class SupabaseConnector extends Connector<typeof Service.SUPABASE> {
  readonly service = Service.SUPABASE;
  static readonly displayName = 'Supabase';

  private readonly connectionString: string | undefined;
  private readonly projects: SupabaseProjectConfig[];
  private readonly isOAuth: boolean;
  private readonly connectionStringProjectRef: string | undefined;

  constructor(credentials: SupabaseCredentials) {
    super();
    this.projects = credentials.projects ?? [];
    this.isOAuth = this.projects.length > 0;
    this.connectionString = credentials.connectionString;
    this.connectionStringProjectRef = credentials.connectionString
      ? extractProjectRef(credentials.connectionString)
      : undefined;
  }

  /**
   * Resolve the connection string, schema, and table name for a given remoteId.
   * remoteId is always [projectRef, schema, tableName].
   */
  private resolveConnection(remoteId: string[]): { connectionString: string; schema: string; tableName: string } {
    const [projectRef, schema, tableName] = remoteId;

    if (this.isOAuth) {
      const project = this.projects.find((p) => p.projectRef === projectRef);
      if (!project) {
        throw new KnexPGClientError(`Unknown Supabase project: ${projectRef}`, 'CONNECTION_ERROR');
      }
      return { connectionString: project.connectionString, schema, tableName };
    }

    if (!this.connectionString) {
      throw new KnexPGClientError('No connection string configured', 'CONNECTION_ERROR');
    }
    return { connectionString: this.connectionString, schema, tableName };
  }

  /**
   * Run an operation with a short-lived KnexPGClient that is automatically
   * disposed when the operation completes (or throws).
   */
  private async withPgClient<T>(fn: (client: KnexPGClient) => Promise<T>, connectionString?: string): Promise<T> {
    const connStr = connectionString ?? this.connectionString;
    if (!connStr) {
      throw new KnexPGClientError('No connection string configured', 'CONNECTION_ERROR');
    }
    const client = new KnexPGClient(connStr, { sslNoVerify: true });
    try {
      return await fn(client);
    } finally {
      try {
        await client.dispose();
      } catch {
        // Swallow dispose errors so they don't mask the original error
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async testConnection(): Promise<void> {
    if (this.isOAuth) {
      const errors: string[] = [];
      for (const project of this.projects) {
        try {
          await this.withPgClient((client) => client.testQuery(), project.connectionString);
        } catch (error) {
          errors.push(`${project.projectName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (errors.length === this.projects.length) {
        throw new KnexPGClientError(
          `All Supabase projects failed connectivity test: ${errors.join('; ')}`,
          'CONNECTION_ERROR',
        );
      }
      return;
    }
    await this.withPgClient((client) => client.testQuery());
  }

  // -------------------------------------------------------------------------
  // Table discovery
  // -------------------------------------------------------------------------

  async listTables(): Promise<TablePreview[]> {
    if (this.isOAuth) {
      return this.listTablesOAuth();
    }
    return this.listTablesConnectionString();
  }

  private async listTablesConnectionString(): Promise<TablePreview[]> {
    return this.withPgClient(async (client) => {
      const [tables, tablesWithUnique, tablesWithAutoGenPK] = await Promise.all([
        client.findAllTablesExcludingSchemas(SUPABASE_SYSTEM_SCHEMAS, SUPABASE_SYSTEM_SCHEMA_PATTERNS),
        client.findTablesWithUniqueColumns(SUPABASE_SYSTEM_SCHEMAS),
        client.findTablesWithAutoGeneratedPK(SUPABASE_SYSTEM_SCHEMAS),
      ]);

      return tables.map((t) =>
        this.parseTables(t, this.connectionStringProjectRef!, undefined, tablesWithUnique, tablesWithAutoGenPK),
      );
    });
  }

  private parseTables(
    t: TableName,
    projectRef: string,
    projectName?: string,
    tablesWithUnique?: Set<string>,
    tablesWithAutoGenPK?: Set<string>,
  ): TablePreview {
    const displayName = t.table_name;
    const tableKey = `${t.table_schema}.${t.table_name}`;
    const hasUnique = tablesWithUnique ? tablesWithUnique.has(tableKey) : true;
    const hasAutoGenPK = tablesWithAutoGenPK ? tablesWithAutoGenPK.has(tableKey) : true;
    return {
      id: {
        wsId: sanitizeForTableWsId(`${projectName || projectRef}__${t.table_schema}__${t.table_name}`),
        remoteId: [projectRef, t.table_schema, t.table_name],
      },
      displayName,
      ...(!hasUnique && { disabled: true as const }),
      ...(hasUnique && !hasAutoGenPK && { disabledCreates: true as const }),
      metadata: {
        schema: t.table_schema,
        projectRef: projectRef,
        projectName: projectName,
        description: `Table "${t.table_name}" in schema "${t.table_schema}"`,
      },
    };
  }

  private async listTablesOAuth(): Promise<TablePreview[]> {
    const allTables: TablePreview[] = [];

    for (const project of this.projects) {
      const [tables, tablesWithUnique, tablesWithAutoGenPK] = await this.withPgClient(async (client) => {
        const [rows, uniqueSet, autoGenSet] = await Promise.all([
          client.findAllTablesExcludingSchemas(SUPABASE_SYSTEM_SCHEMAS, SUPABASE_SYSTEM_SCHEMA_PATTERNS),
          client.findTablesWithUniqueColumns(SUPABASE_SYSTEM_SCHEMAS),
          client.findTablesWithAutoGeneratedPK(SUPABASE_SYSTEM_SCHEMAS),
        ]);
        return [rows, uniqueSet, autoGenSet] as const;
      }, project.connectionString);

      allTables.push(
        ...tables.map((t) =>
          this.parseTables(t, project.projectRef, project.projectName, tablesWithUnique, tablesWithAutoGenPK),
        ),
      );
    }

    return allTables;
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const resolved = this.resolveConnection(id.remoteId);
    return this.withPgClient(async (client) => {
      const { schema, tableName } = resolved;

      const [columns, pkCandidates, foreignKeys] = await Promise.all([
        client.findAllColumnsInTable(schema, tableName),
        client.findPrimaryColumnCandidates(schema, tableName),
        client.findAllForeignKeysInTable(schema, tableName),
      ]);

      const primaryKey = this.pickPrimaryKey(pkCandidates, columns);

      // Build a map from column name → linked table display name
      const fkMap = new Map<string, string>();
      for (const fk of foreignKeys) {
        if (fk.foreign_table_name) {
          const linkedTableId =
            fk.foreign_table_schema === 'public'
              ? fk.foreign_table_name
              : `${fk.foreign_table_schema}.${fk.foreign_table_name}`;
          fkMap.set(fk.column_name, linkedTableId);
        }
      }

      const schemaProperties: Record<string, TSchema> = {};
      for (const col of columns) {
        const isNullable = col.is_nullable === 'YES';
        const hasDefault = col.column_default !== null;
        const { schema: colSchema, pgType } = mapPgType(col.data_type, col.udt_name, isNullable);

        // Annotate with connector data type
        const annotated = { ...colSchema, [CONNECTOR_DATA_TYPE]: pgType } as TSchema;

        // Generated/identity columns are read-only
        if (isGeneratedColumn(col) || col.is_updatable === 'NO') {
          (annotated as Record<string, unknown>)[READONLY_FLAG] = true;
        }

        // Annotate foreign key columns
        const linkedTableId = fkMap.get(col.column_name);
        if (linkedTableId) {
          (annotated as Record<string, unknown>)[FOREIGN_KEY_OPTIONS] = { linkedTableId };
        }

        schemaProperties[col.column_name] = isNullable || hasDefault ? Type.Optional(annotated) : annotated;
      }

      const tableSchema = Type.Object(schemaProperties, {
        $id: `supabase/${schema}.${tableName}`,
        title: tableName,
      });

      return {
        id,
        slug: tableName,
        name: tableName,
        schema: tableSchema,
        idColumnRemoteId: primaryKey,
        basePath: [schema],
        generatedAt: new Date().toISOString(),
      };
    }, resolved.connectionString);
  }

  /**
   * Pick the best primary key column. Prefers a single auto-generated PK.
   * Falls back to first PK candidate, then 'id'.
   */
  private pickPrimaryKey(candidates: string[], columns: InformationSchemaColumn[]): string {
    if (candidates.length === 1) {
      return candidates[0];
    }

    // If multiple PK candidates, prefer one that is auto-generated
    if (candidates.length > 1) {
      const colMap = new Map(columns.map((c) => [c.column_name, c]));
      const generated = candidates.find((name) => {
        const col = colMap.get(name);
        return col && isGeneratedColumn(col);
      });
      return generated ?? candidates[0];
    }

    // No PK found — fall back to 'id'
    return 'id';
  }

  // -------------------------------------------------------------------------
  // Pull
  // -------------------------------------------------------------------------

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    _progress: JsonSafeObject,
    options: ConnectorPullOptions,
  ): Promise<void> {
    const rawFilter = options.filter?.trim() || undefined;
    if (rawFilter) {
      validateWhereFilter(rawFilter);
    }

    const resolved = this.resolveConnection(tableSpec.id.remoteId);
    return this.withPgClient(async (client) => {
      const { schema, tableName } = resolved;
      const pk = tableSpec.idColumnRemoteId;
      const filter = rawFilter;
      let offset = 0;

      while (true) {
        const rows = await client.selectAll(schema, tableName, undefined, pk, READ_BATCH_SIZE, offset, filter);
        if (rows.length === 0) break;

        await callback({ files: rows as ConnectorFile[] });
        offset += rows.length;

        if (rows.length < READ_BATCH_SIZE) break;
      }
    }, resolved.connectionString);
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const resolved = this.resolveConnection(tableSpec.id.remoteId);
    return this.withPgClient(async (client) => {
      const { schema, tableName } = resolved;
      const pk = tableSpec.idColumnRemoteId;

      for (let i = 0; i < ids.length; i += READ_BATCH_SIZE) {
        const batch = ids.slice(i, i + READ_BATCH_SIZE);
        const rows = await client.selectByIds(schema, tableName, ['*'], pk, batch);
        if (rows.length > 0) {
          await callback({ files: rows as ConnectorFile[] });
        }
      }
    }, resolved.connectionString);
  }

  // -------------------------------------------------------------------------
  // Batch size
  // -------------------------------------------------------------------------

  supportsFilters(): boolean {
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getBatchSize(_operation: 'create' | 'update' | 'delete'): number {
    return 100;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const resolved = this.resolveConnection(tableSpec.id.remoteId);
    return this.withPgClient(async (client) => {
      const { schema, tableName } = resolved;
      const pk = tableSpec.idColumnRemoteId;

      return client.insertMany(schema, tableName, pk, files);
    }, resolved.connectionString);
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const resolved = this.resolveConnection(tableSpec.id.remoteId);
    return this.withPgClient(async (client) => {
      const { schema, tableName } = resolved;
      const pk = tableSpec.idColumnRemoteId;

      const records = files.map((file) => ({
        id: file[pk] as string | number,
        data: file,
      }));

      await client.updateMany(schema, tableName, pk, records);
    }, resolved.connectionString);
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const resolved = this.resolveConnection(tableSpec.id.remoteId);
    return this.withPgClient(async (client) => {
      const { schema, tableName } = resolved;
      const pk = tableSpec.idColumnRemoteId;

      const ids = files.map((file) => file[pk] as string | number);
      if (ids.length > 0) {
        await client.deleteMany(schema, tableName, ids, pk);
      }
    }, resolved.connectionString);
  }

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof KnexPGClientError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: { code: error.code },
      };
    }

    if (error instanceof SupabaseApiError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: { statusCode: error.statusCode },
      };
    }

    // Handle pg library errors with error codes
    if (error && typeof error === 'object' && 'code' in error) {
      const pgError = error as { code: string; message: string; detail?: string };
      return {
        userFriendlyMessage: this.getPgErrorMessage(pgError.code, pgError.message),
        description: pgError.detail ?? pgError.message,
        additionalContext: { code: pgError.code },
      };
    }

    // Handle Knex timeout errors
    if (error instanceof Error && error.name === 'KnexTimeoutError') {
      return {
        userFriendlyMessage: 'Connection to Supabase timed out. Please check your connection settings.',
        description: error.message,
      };
    }

    if (error instanceof Error) {
      const msg = error.message;

      // Knex pool timeout (unreachable host / wrong port)
      if (msg.startsWith('Knex: Timeout acquiring a connection')) {
        return {
          userFriendlyMessage:
            'Could not connect to the database. Please verify the host and port in your connection string.',
          description: msg,
        };
      }

      // DNS resolution failure (often caused by unencoded '@' in password)
      if (msg.includes('getaddrinfo ENOTFOUND')) {
        return {
          userFriendlyMessage:
            'Could not resolve the database hostname. If your password contains special characters, they must be URL-encoded.',
          description: msg,
        };
      }

      // SASL errors (empty or malformed password)
      if (msg.includes('SASL')) {
        return {
          userFriendlyMessage: 'Authentication failed. The password appears empty or malformed.',
          description: msg,
        };
      }
    }

    return this.fallbackErrorDetails(error);
  }

  private getPgErrorMessage(code: string, fallbackMessage: string): string {
    switch (code) {
      case '28P01':
      case '28000':
        return this.isOAuth
          ? 'Authentication failed. Please reconnect your Supabase account.'
          : 'Authentication failed. Please check the password in your connection string.';
      case '3D000':
        return 'Database does not exist. Please check your Supabase project settings.';
      case '08001':
      case '08006':
        return 'Could not connect to the Supabase database. The service may be temporarily unavailable.';
      case '42P01':
        return 'Table not found in Supabase.';
      case '23505':
        return 'A record with this ID already exists (unique constraint violation).';
      case '23503':
        return 'Cannot complete this operation due to a foreign key constraint.';
      case '23502':
        return 'A required field is missing (NOT NULL constraint violation).';
      case '42501':
        return 'Insufficient permissions. This may occur during Supabase maintenance periods.';
      default:
        return fallbackMessage;
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    // No-op: connections are automatically disposed after each operation via withPgClient()
  }
}
