import { Type, type TSchema } from '@sinclair/typebox';
import { Service } from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector } from '../../connector';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  ConnectorPullOptions,
  EntityId,
  PostgresColumnType,
  TablePreview,
} from '../../types';
import { PostgresClient, PostgresClientError } from './postgres-client';
import {
  PG_BOOLEAN_TYPES,
  PG_DATE_TYPES,
  PG_JSON_TYPES,
  PG_NUMERIC_TYPES,
  PG_TEXT_TYPES,
  PG_TIMESTAMP_TYPES,
  PostgresCredentials,
} from './postgres-types';

const READ_BATCH_SIZE = 500;

/**
 * Map a PostgreSQL data type to a TypeBox schema and internal PostgresColumnType.
 */
function mapPgType(
  dataType: string,
  udtName: string,
  isNullable: boolean,
): { schema: TSchema; pgType: PostgresColumnType } {
  let schema: TSchema;
  let pgType: PostgresColumnType;

  // Check for array types first (data_type is 'ARRAY', udt_name starts with '_')
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

/**
 * Map a scalar PostgreSQL type name to TypeBox schema and PostgresColumnType.
 */
function mapScalarPgType(typeName: string): { schema: TSchema; pgType: PostgresColumnType } {
  const lowerType = typeName.toLowerCase();

  if (PG_NUMERIC_TYPES.has(lowerType)) {
    return { schema: Type.Number(), pgType: PostgresColumnType.NUMERIC };
  }
  if (PG_BOOLEAN_TYPES.has(lowerType)) {
    return { schema: Type.Boolean(), pgType: PostgresColumnType.BOOLEAN };
  }
  if (PG_TEXT_TYPES.has(lowerType)) {
    return { schema: Type.String(), pgType: PostgresColumnType.TEXT };
  }
  if (PG_TIMESTAMP_TYPES.has(lowerType) || lowerType === 'timestamptz') {
    return { schema: Type.String({ format: 'date-time' }), pgType: PostgresColumnType.TIMESTAMP };
  }
  if (PG_DATE_TYPES.has(lowerType)) {
    return { schema: Type.String({ format: 'date' }), pgType: PostgresColumnType.TIMESTAMP };
  }
  if (PG_JSON_TYPES.has(lowerType)) {
    return { schema: Type.Unknown(), pgType: PostgresColumnType.JSONB };
  }

  // Fallback for unknown types
  return { schema: Type.Unknown(), pgType: PostgresColumnType.TEXT };
}

/**
 * Connector for PostgreSQL databases.
 *
 * Dynamically discovers tables from information_schema and builds TypeBox schemas.
 * This is a JSON-only connector that implements:
 * - fetchJsonTableSpec() for schema discovery
 * - pullRecordFiles() for fetching records
 */
export class PostgresConnector extends Connector<typeof Service.POSTGRES> {
  readonly service = Service.POSTGRES;
  static readonly displayName = 'PostgreSQL';

  private readonly client: PostgresClient;

  constructor(credentials: PostgresCredentials) {
    super();
    this.client = new PostgresClient(credentials.connectionString);
  }

  /**
   * Test the connection by running a simple query.
   */
  async testConnection(): Promise<void> {
    await this.client.testConnection();
  }

  /**
   * List all tables in the public schema.
   */
  async listTables(): Promise<TablePreview[]> {
    const tables = await this.client.listTables();

    return tables.map((tableName) => ({
      id: {
        wsId: tableName,
        remoteId: ['public', tableName],
      },
      displayName: tableName,
      metadata: {
        description: `Table "${tableName}" in the public schema`,
      },
    }));
  }

  /**
   * Fetch the JSON Table Spec for a PostgreSQL table.
   * Dynamically builds a TypeBox schema from the table's column metadata.
   */
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const tableName = id.remoteId[1] ?? id.wsId;
    const columns = await this.client.getTableColumns(tableName);
    const primaryKey = await this.client.getPrimaryKeyColumn(tableName);

    const schemaProperties: Record<string, TSchema> = {};
    for (const col of columns) {
      const isNullable = col.is_nullable === 'YES';
      const hasDefault = col.column_default !== null;
      const { schema } = mapPgType(col.data_type, col.udt_name, isNullable);
      // Columns that are nullable or have a default value (including serial/identity)
      // are not required for inserts, so mark them optional
      schemaProperties[col.column_name] = isNullable || hasDefault ? Type.Optional(schema) : schema;
    }

    const schema = Type.Object(schemaProperties, {
      $id: `postgres/${tableName}`,
      title: tableName,
    });

    return {
      id,
      slug: tableName,
      name: tableName,
      schema,
      idColumnRemoteId: primaryKey,
    };
  }

  /**
   * Download all rows from a table as JSON files, paginated.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    const tableName = tableSpec.id.remoteId[1] ?? tableSpec.id.wsId;
    let offset = 0;

    while (true) {
      const rows = await this.client.selectRows(tableName, READ_BATCH_SIZE, offset);
      if (rows.length === 0) {
        break;
      }

      await callback({ files: rows as ConnectorFile[] });
      offset += rows.length;

      if (rows.length < READ_BATCH_SIZE) {
        break;
      }
    }
  }

  /**
   * Get the batch size for CRUD operations.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getBatchSize(_operation: 'create' | 'update' | 'delete'): number {
    return 100;
  }

  /**
   * Create records by inserting rows.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const tableName = tableSpec.id.remoteId[1] ?? tableSpec.id.wsId;
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const result = await this.client.insertRow(tableName, file);
      results.push(result as ConnectorFile);
    }

    return results;
  }

  /**
   * Update records by ID.
   */
  async updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const tableName = tableSpec.id.remoteId[1] ?? tableSpec.id.wsId;
    const pkColumn = tableSpec.idColumnRemoteId || 'id';

    for (const file of files) {
      const id = file[pkColumn];
      const data = { ...file };
      delete data[pkColumn];
      await this.client.updateRow(tableName, pkColumn, id, data);
    }
  }

  /**
   * Delete records by primary key.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const tableName = tableSpec.id.remoteId[1] ?? tableSpec.id.wsId;
    const pkColumn = tableSpec.idColumnRemoteId || 'id';

    for (const file of files) {
      await this.client.deleteRow(tableName, pkColumn, file[pkColumn]);
    }
  }

  /**
   * Extract error details from PostgreSQL-specific errors.
   */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof PostgresClientError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          code: error.code,
        },
      };
    }

    // Handle pg library errors with error codes
    if (error && typeof error === 'object' && 'code' in error) {
      const pgError = error as { code: string; message: string; detail?: string };
      const userMessage = this.getPgErrorMessage(pgError.code, pgError.message);

      return {
        userFriendlyMessage: userMessage,
        description: pgError.detail ?? pgError.message,
        additionalContext: {
          code: pgError.code,
        },
      };
    }

    return {
      userFriendlyMessage: 'An error occurred while connecting to PostgreSQL',
      description: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * Map common PostgreSQL error codes to user-friendly messages.
   */
  private getPgErrorMessage(code: string, fallbackMessage: string): string {
    switch (code) {
      case '28P01':
      case '28000':
        return 'Authentication failed. Please check your username and password.';
      case '3D000':
        return 'Database does not exist. Please check your connection string.';
      case '08001':
      case '08006':
        return 'Could not connect to the database server. Please check the host and port.';
      case '42P01':
        return 'Table not found.';
      case '23505':
        return 'A record with this ID already exists (unique constraint violation).';
      case '23503':
        return 'Cannot complete this operation due to a foreign key constraint.';
      case '23502':
        return 'A required field is missing (NOT NULL constraint violation).';
      case '42501':
        return 'Insufficient permissions to perform this operation.';
      default:
        return fallbackMessage;
    }
  }

  /**
   * Disconnect from the database. Should be called when the connector is no longer needed.
   */
  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }
}
