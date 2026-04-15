import { Type, type TSchema } from '@sinclair/typebox';
import { connectorMetadata, ConnectorPullOptions, PostgresColumnType } from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError } from '../../error';
import { FOREIGN_KEY_OPTIONS } from '../../json-schema';
import { Service } from '../../service-constants';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
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
const DEFAULT_POSTGRES_PUBLISH_BATCH_SIZE = 100;
export const LOCAL_POSTGRES_PUBLISH_BATCH_SIZE_ENV = 'LOCAL_POSTGRES_PUBLISH_BATCH_SIZE';

function getPostgresPublishBatchSize(): number {
  const raw = process.env[LOCAL_POSTGRES_PUBLISH_BATCH_SIZE_ENV];
  if (!raw) return DEFAULT_POSTGRES_PUBLISH_BATCH_SIZE;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POSTGRES_PUBLISH_BATCH_SIZE;
}

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
export class PostgresConnector extends Connector {
  readonly service = Service.POSTGRES;
  static readonly displayName = 'PostgreSQL';
  static readonly metadata = connectorMetadata({
    displayName: 'PostgreSQL',
    record: 'row',
    records: 'rows',
    base: 'database',
    bases: 'databases',
    logo: 'https://static.scratch.md/connector-icons/postgres.svg',
    visible: false,
    userProvidedParamsLabel: 'Connection String',
    credentialFields: {
      user_provided_params: [
        {
          key: 'connectionString',
          type: 'password',
          label: 'Connection String',
          placeholder: 'postgres://user:password@host:5432/database',
          required: true,
        },
      ],
    },
  });

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

    const [columns, primaryKey, foreignKeys] = await Promise.all([
      this.client.getTableColumns(tableName),
      this.client.getPrimaryKeyColumn(tableName),
      this.client.getForeignKeys(tableName),
    ]);

    // Build a map from column name → linked table ID
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
    let titleColumnRemoteId: string[] | undefined;
    let slugFieldPath: string | undefined;

    const titleCandidates = ['name', 'title', 'display_name', 'label'];

    for (const col of columns) {
      const isNullable = col.is_nullable === 'YES';
      const hasDefault = col.column_default !== null;
      const { schema } = mapPgType(col.data_type, col.udt_name, isNullable);

      // Annotate foreign key columns
      const linkedTableId = fkMap.get(col.column_name);
      if (linkedTableId) {
        (schema as Record<string, unknown>)[FOREIGN_KEY_OPTIONS] = { linkedTableId };
      }

      // Columns that are nullable or have a default value (including serial/identity)
      // are not required for inserts, so mark them optional
      schemaProperties[col.column_name] = isNullable || hasDefault ? Type.Optional(schema) : schema;

      // Title heuristic: first text-type column matching a known name
      if (!titleColumnRemoteId && titleCandidates.includes(col.column_name) && PG_TEXT_TYPES.has(col.udt_name)) {
        titleColumnRemoteId = [col.column_name];
      }

      // Slug heuristic: column named "slug"
      if (col.column_name === 'slug') {
        slugFieldPath = 'slug';
      }
    }

    const tableSchema = Type.Object(schemaProperties, {
      $id: `postgres/${tableName}`,
      title: tableName,
    });

    return {
      id,
      slug: tableName,
      name: tableName,
      schema: tableSchema,
      idColumnRemoteId: primaryKey,
      titleColumnRemoteId,
      slugFieldPath,
      basePath: id.remoteId[0] ? [id.remoteId[0]] : ['public'],
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Download all rows from a table as JSON files, paginated.
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: ConnectorPullOptions,
  ): Promise<void> {
    const tableName = tableSpec.id.remoteId[1] ?? tableSpec.id.wsId;
    let offset = (progress as { nextOffset?: number })?.nextOffset ?? 0;

    while (true) {
      const rows = await this.client.selectRows(tableName, READ_BATCH_SIZE, offset);
      if (rows.length === 0) {
        break;
      }

      offset += rows.length;
      await callback({ files: rows as ConnectorFile[], connectorProgress: { nextOffset: offset } });

      if (rows.length < READ_BATCH_SIZE) {
        break;
      }
    }
  }

  /**
   * Fetch specific rows by primary key values.
   */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const tableName = tableSpec.id.remoteId[1] ?? tableSpec.id.wsId;
    const pkColumn = tableSpec.idColumnRemoteId || 'id';

    for (let i = 0; i < ids.length; i += READ_BATCH_SIZE) {
      const batch = ids.slice(i, i + READ_BATCH_SIZE);
      const rows = await this.client.selectByIds(tableName, pkColumn, batch);
      if (rows.length > 0) {
        await callback({ files: rows as ConnectorFile[] });
      }
    }
  }

  /**
   * Get the batch size for CRUD operations.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getBatchSize(_operation: 'create' | 'update' | 'delete'): number {
    return getPostgresPublishBatchSize();
  }

  /**
   * Create records by inserting rows.
   */
  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const tableName = tableSpec.id.remoteId[1] ?? tableSpec.id.wsId;
    const results = await this.client.insertRows(tableName, files as Record<string, unknown>[]);
    return results as ConnectorFile[];
  }

  /**
   * Update records by ID.
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<void> {
    const tableName = tableSpec.id.remoteId[1] ?? tableSpec.id.wsId;
    const pkColumn = tableSpec.idColumnRemoteId || 'id';
    const updates = files.map((file, index) => {
      const data = { ...(changedFields?.[index] ?? file) };
      delete data[pkColumn];
      return { id: file[pkColumn], data };
    });

    await this.client.updateRows(tableName, pkColumn, updates);
  }

  /**
   * Delete records by primary key.
   */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const tableName = tableSpec.id.remoteId[1] ?? tableSpec.id.wsId;
    const pkColumn = tableSpec.idColumnRemoteId || 'id';
    await this.client.deleteRows(
      tableName,
      pkColumn,
      files.map((file) => file[pkColumn]),
    );
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titleColumnRemoteId?.length === 1 ? tableSpec.titleColumnRemoteId[0] : undefined;
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath, titlePath);
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

    return this.fallbackErrorDetails(error);
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

connectorRegistry.register({
  service: Service.POSTGRES,
  metadata: PostgresConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for PostgreSQL', Service.POSTGRES);
    }
    if (!ctx.decryptedCredentials?.connectionString) {
      throw new ConnectorInstantiationError('Connection string is required for PostgreSQL', Service.POSTGRES);
    }
    return new PostgresConnector({ connectionString: ctx.decryptedCredentials.connectionString });
  },
});
