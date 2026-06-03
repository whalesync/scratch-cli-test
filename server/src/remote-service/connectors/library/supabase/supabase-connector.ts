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
import {
  connectorMetadata,
  ConnectorSettingDefinition,
  IncrementalPullSupport,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_MAX_LENGTH,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError } from '../../error';
import { sanitizeForTableWsId } from '../../ids';
import { Service } from '../../service-constants';
import {
  idPath,
  type BaseJsonTableSpec,
  type ConnectorErrorDetails,
  type ConnectorFile,
  type EntityId,
  type PullRecordFilesOptions,
  type PullRecordFilesResult,
  type TablePreview,
} from '../../types';
import {
  applyPgClockSkew,
  assertModifiedAtColumnExists,
  isGeneratedColumn,
  KnexPGClient,
  KnexPGClientError,
  mapPgType,
  pgIncrementalPullSupport,
  resolvePgModifiedAtField,
  SUPABASE_SYSTEM_SCHEMA_PATTERNS,
  SUPABASE_SYSTEM_SCHEMAS,
  TableName,
  validateWhereFilter,
  type InformationSchemaColumn,
} from '../pg-common';
import { buildPgDefaultView } from '../pg-common/pg-default-view';
import { SupabaseApiError } from './supabase-api-client';
import { SupabaseAuthParser } from './supabase-auth-parser';
import { extractProjectRef } from './supabase-setup-utils';
import { SupabaseCredentials, SupabaseProjectConfig } from './supabase-types';

const READ_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class SupabaseConnector extends Connector {
  readonly service = Service.SUPABASE;
  static readonly displayName = 'Supabase';
  static readonly metadata = connectorMetadata({
    displayName: 'Supabase',
    record: 'row',
    records: 'rows',
    base: 'project',
    bases: 'projects',
    logo: 'https://static.scratch.md/connector-icons/supabase.svg',
    incrementalPull: true,
    incrementalPullInstructions:
      'To enable incremental pulls, this table must contain a timestamp column that tracks when a row was last changed (e.g. updated_at).',
    oauth: { label: 'OAuth' },
    userProvidedParamsLabel: 'Connection String',
    credentialFields: {
      user_provided_params: [
        {
          key: 'connectionString',
          type: 'password',
          label: 'Connection String',
          placeholder: 'postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres',
          description: 'Find this in your Supabase project under Settings > Database > Connection string',
          required: true,
        },
      ],
    },
  });
  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'modifiedAtField',
      type: 'field-select',
      label: 'Update field',
      description: 'A timestamp column that tracks when a row was last changed (e.g. updated_at).',
      placeholder: 'e.g. updated_at',
      // Only timestamp columns make sense as an incremental watermark; they map
      // to JSON Schema `format: 'date-time'`, so the picker offers only those.
      fieldSelectFormats: ['date-time'],
    },
  ];

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
    const projectRef = this.connectionStringProjectRef;
    if (!projectRef) {
      throw new Error('listTablesConnectionString called without a connection-string project ref');
    }
    return this.withPgClient(async (client) => {
      const [tables, tablesWithUnique, tablesWithAutoGenPK] = await Promise.all([
        client.findAllTablesExcludingSchemas(SUPABASE_SYSTEM_SCHEMAS, SUPABASE_SYSTEM_SCHEMA_PATTERNS),
        client.findTablesWithUniqueColumns(SUPABASE_SYSTEM_SCHEMAS),
        client.findTablesWithAutoGeneratedPK(SUPABASE_SYSTEM_SCHEMAS),
      ]);

      return tables.map((t) => this.parseTables(t, projectRef, undefined, tablesWithUnique, tablesWithAutoGenPK));
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
    const groupName = projectName || projectRef;
    return {
      id: {
        wsId: sanitizeForTableWsId(`${groupName}__${t.table_schema}__${t.table_name}`),
        remoteId: [projectRef, t.table_schema, t.table_name],
      },
      displayName,
      parentPath: `${groupName}/${t.table_schema}`,
      ...(!hasUnique && {
        disabled: true as const,
        disabledReason: "This table doesn't have a unique value column (primary key).",
      }),
      ...(hasUnique &&
        !hasAutoGenPK && {
          disabledCreates: true as const,
          disabledReason: "This table doesn't have an auto generated primary key, creates are not supported",
        }),
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
        const annotated = { ...colSchema, [X_SCRATCH_CONNECTOR_DATA_TYPE]: pgType } as TSchema;

        // Preserve VARCHAR(n)/CHAR(n) length limits from information_schema
        if (col.character_maximum_length !== null) {
          (annotated as Record<string, unknown>)[X_SCRATCH_MAX_LENGTH] = col.character_maximum_length;
        }

        // Generated/identity columns are read-only
        if (isGeneratedColumn(col) || col.is_updatable === 'NO') {
          (annotated as Record<string, unknown>)[X_SCRATCH_READONLY] = true;
        }

        // Annotate foreign key columns
        const linkedTableId = fkMap.get(col.column_name);
        if (linkedTableId) {
          (annotated as Record<string, unknown>)[X_SCRATCH_FOREIGN_KEY_OPTIONS] = { linkedTableId };
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
        idColumnRemoteId: idPath(primaryKey),
        basePath: [schema],
        generatedAt: new Date().toISOString(),
        defaultView: buildPgDefaultView(tableSchema),
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

  /**
   * Supabase supports incremental pulls only when the user has declared which
   * column stores the row's last-modified timestamp. SQL has no last-modified
   * convention, so there is no schema-annotated auto-detection — without an
   * explicit `modifiedAtField` the job demotes the run to a full scan.
   */
  override incrementalPullSupport(
    options: PullRecordFilesOptions,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    return pgIncrementalPullSupport(options);
  }

  /**
   * Resolve the modified-since column. Explicit `options.modifiedAtField` only
   * (no auto-detection for SQL). Helper shape kept identical to Airtable's for
   * consistency across connectors.
   */
  private resolveModifiedAtField(options: PullRecordFilesOptions): string | undefined {
    return resolvePgModifiedAtField(options);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const rawFilter = options.filter?.trim() || undefined;
    if (rawFilter) {
      validateWhereFilter(rawFilter);
    }

    const modifiedAtField = this.resolveModifiedAtField(options);
    const isIncremental =
      options.pullMode === 'incremental' && modifiedAtField !== undefined && options.since instanceof Date;

    let newWatermark: Date | undefined;
    let modifiedSinceColumn: string | undefined;
    let modifiedSinceDatetime: Date | undefined;

    if (isIncremental && options.since && modifiedAtField) {
      // Reject a typo'd column up front (it comes from user options) so the
      // pull fails fast with a clear message instead of an opaque SQL error.
      assertModifiedAtColumnExists(tableSpec.schema, tableSpec.name, modifiedAtField);
      // Capture the start-of-pull timestamp BEFORE the first query so changes
      // made mid-pull aren't lost; idempotent commits absorb any duplicates.
      newWatermark = new Date();
      modifiedSinceColumn = modifiedAtField;
      modifiedSinceDatetime = applyPgClockSkew(options.since);
    }

    const resolved = this.resolveConnection(tableSpec.id.remoteId);
    await this.withPgClient(async (client) => {
      const { schema, tableName } = resolved;
      const pk = tableSpec.idColumnRemoteId;
      const filter = rawFilter;
      let offset = (progress as { nextOffset?: number })?.nextOffset ?? 0;

      while (true) {
        const rows = await client.selectAll(
          schema,
          tableName,
          undefined,
          pk,
          READ_BATCH_SIZE,
          offset,
          filter,
          modifiedSinceColumn,
          modifiedSinceDatetime,
        );
        if (rows.length === 0) break;

        offset += rows.length;
        await callback({ files: rows as ConnectorFile[], connectorProgress: { nextOffset: offset } });

        if (rows.length < READ_BATCH_SIZE) break;
      }
    }, resolved.connectionString);
    return newWatermark ? { newWatermark } : {};
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

  supportsFieldSelection(): boolean {
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

  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const resolved = this.resolveConnection(tableSpec.id.remoteId);
    return this.withPgClient(async (client) => {
      const { schema, tableName } = resolved;
      const pk = tableSpec.idColumnRemoteId;

      const records = files.map((file, i) => ({
        id: file[pk] as string | number,
        data: changedFields[i],
      }));

      const persisted = await client.updateMany(schema, tableName, pk, records);
      // See postgres-connector.ts for the rationale — `updateMany` does
      // `UPDATE … RETURNING t.*` so we get the row Postgres actually
      // stored. Fall back to sent payload only for rows that vanished.
      return persisted.map((row, i) => (row === 'not_found' ? files[i] : (row as ConnectorFile)));
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

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titleColumnRemoteId?.length === 1 ? tableSpec.titleColumnRemoteId[0] : undefined;
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath ?? tableSpec.slugColumnRemoteId, titlePath);
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

connectorRegistry.register({
  service: Service.SUPABASE,
  metadata: SupabaseConnector.metadata,
  advancedSettings: SupabaseConnector.advancedSettings,
  supportedAuthMethods: ['oauth', 'user_provided_params'],
  resolveIncrementalPullSupport: ({ options }) => pgIncrementalPullSupport(options),
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Supabase', Service.SUPABASE);
    }
    if (ctx.connectorAccount.authType === 'OAUTH') {
      const supabaseProjects = ctx.decryptedCredentials?.supabaseProjects;
      if (!supabaseProjects || supabaseProjects.length === 0) {
        throw new ConnectorInstantiationError(
          'Supabase projects not configured. Please reconnect your Supabase account.',
          Service.SUPABASE,
        );
      }
      const supabaseAccessToken = await ctx.getOAuthAccessToken(ctx.connectorAccount.id);
      return new SupabaseConnector({
        projects: supabaseProjects.map((p) => ({
          projectRef: p.projectRef,
          projectName: p.projectName,
          connectionString: p.connectionString,
        })),
        oauthAccessToken: supabaseAccessToken,
      });
    } else {
      if (!ctx.decryptedCredentials?.connectionString) {
        throw new ConnectorInstantiationError('Connection string is required for Supabase.', Service.SUPABASE);
      }
      return new SupabaseConnector({
        connectionString: ctx.decryptedCredentials.connectionString,
      });
    }
  },
  createAuthParser() {
    return new SupabaseAuthParser();
  },
});
