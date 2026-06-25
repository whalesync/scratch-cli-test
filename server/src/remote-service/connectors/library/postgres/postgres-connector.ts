/**
 * Generic PostgreSQL connector.
 *
 * Uses KnexPGClient from pg-common for all data access — same client layer the
 * Supabase connector uses, with the Supabase-specific bits (OAuth, Management
 * API, project routing) stripped out.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import {
  connectorMetadata,
  ConnectorSettingDefinition,
  IncrementalPullSupport,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_MAX_LENGTH,
  type CreateFieldResult,
  type CreateTableResult,
  type SchemaCreationCapabilities,
} from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError } from '../../error';
import { sanitizeForTableWsId } from '../../ids';
import {
  type NormalizedCreateFieldsPlan,
  type NormalizedCreateTablePlan,
  type ResolvedCreateFieldSpec,
} from '../../schema-creation.types';
import { Service } from '../../service-constants';
import {
  dotPath,
  type BaseJsonTableSpec,
  type ConnectorErrorDetails,
  type ConnectorFile,
  type CreateDestination,
  type DotPath,
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
  PG_TEXT_TYPES,
  pgIncrementalPullSupport,
  POSTGRES_SCHEMA_CREATION_CAPABILITIES,
  POSTGRES_SYSTEM_SCHEMA_PATTERNS,
  POSTGRES_SYSTEM_SCHEMAS,
  resolvePgModifiedAtField,
  TableName,
  validateWhereFilter,
  type ForeignKeyResolutions,
  type InformationSchemaColumn,
} from '../pg-common';
import { buildPgDefaultView } from '../pg-common/pg-default-view';
import { PostgresCredentials } from './postgres-types';

const READ_BATCH_SIZE = 500;
const DEFAULT_POSTGRES_PUBLISH_BATCH_SIZE = 100;
export const LOCAL_POSTGRES_PUBLISH_BATCH_SIZE_ENV = 'LOCAL_POSTGRES_PUBLISH_BATCH_SIZE';

function getPostgresPublishBatchSize(): number {
  const raw = process.env[LOCAL_POSTGRES_PUBLISH_BATCH_SIZE_ENV];
  if (!raw) return DEFAULT_POSTGRES_PUBLISH_BATCH_SIZE;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POSTGRES_PUBLISH_BATCH_SIZE;
}

/** JSON Schema extension keys (from CONNECTOR_GUIDE.md). */
const READONLY_FLAG = 'x-scratch-readonly';
const CONNECTOR_DATA_TYPE = 'x-scratch-connector-data-type';

const TITLE_COLUMN_CANDIDATES = ['name', 'title', 'display_name', 'label'];

/** Schema used when a create-schema request does not specify a `remoteParentId`. */
const DEFAULT_POSTGRES_SCHEMA = 'public';

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
    incrementalPull: true,
    incrementalPullInstructions:
      'To enable incremental pulls, this table must contain a date-time column that tracks when a row was last changed (e.g. updated_at).',
    // Postgres implements the create-schema seam (supportsSchemaCreation() === true).
    supportsSchemaCreation: true,
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
  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'modifiedAtField',
      type: 'field-select',
      label: 'Update field',
      description: 'A date-time column that tracks when a row was last changed (e.g. updated_at).',
      placeholder: 'e.g. updated_at',
      // Only timestamp columns make sense as an incremental watermark; they map
      // to JSON Schema `format: 'date-time'`, so the picker offers only those.
      fieldSelectFormats: ['date-time'],
    },
  ];

  private readonly connectionString: string;

  constructor(credentials: PostgresCredentials) {
    super();
    this.connectionString = credentials.connectionString;
  }

  /**
   * Run an operation with a short-lived KnexPGClient that is automatically
   * disposed when the operation completes (or throws).
   */
  private async withPgClient<T>(fn: (client: KnexPGClient) => Promise<T>): Promise<T> {
    const client = new KnexPGClient(this.connectionString);
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
    await this.withPgClient((client) => client.testQuery());
  }

  // -------------------------------------------------------------------------
  // Table discovery
  // -------------------------------------------------------------------------

  async listTables(): Promise<TablePreview[]> {
    return this.withPgClient(async (client) => {
      const [tables, tablesWithUnique, tablesWithAutoGenPK] = await Promise.all([
        client.findAllTablesExcludingSchemas(POSTGRES_SYSTEM_SCHEMAS, POSTGRES_SYSTEM_SCHEMA_PATTERNS),
        client.findTablesWithUniqueColumns(POSTGRES_SYSTEM_SCHEMAS),
        client.findTablesWithAutoGeneratedPK(POSTGRES_SYSTEM_SCHEMAS),
      ]);

      return tables.map((t) => this.parseTable(t, tablesWithUnique, tablesWithAutoGenPK));
    });
  }

  /**
   * A new Postgres table is created inside a schema, so the create destinations
   * are the database's non-system schemas. Mirrors the schema exclusions used by
   * {@link listTables} (the fixed system schemas plus the `pg_*` pattern).
   */
  override async listCreateDestinations(): Promise<CreateDestination[]> {
    return this.withPgClient(async (client) => {
      const schemas = await client.findAllSchemas();
      return schemas
        .filter(
          (schema) => !POSTGRES_SYSTEM_SCHEMAS.includes(schema.schema_name) && !schema.schema_name.startsWith('pg_'),
        )
        .map((schema) => ({ id: schema.schema_name, name: schema.schema_name }));
    });
  }

  private parseTable(t: TableName, tablesWithUnique: Set<string>, tablesWithAutoGenPK: Set<string>): TablePreview {
    const tableKey = `${t.table_schema}.${t.table_name}`;
    const hasUnique = tablesWithUnique.has(tableKey);
    const hasAutoGenPK = tablesWithAutoGenPK.has(tableKey);

    // Preserve historical wsId for public-schema tables (un-sanitized table name)
    // so existing workbook entries continue to map to the same files. Other
    // schemas are new territory and use the sanitized schema-qualified form.
    const wsId =
      t.table_schema === 'public' ? t.table_name : sanitizeForTableWsId(`${t.table_schema}__${t.table_name}`);

    return {
      id: {
        wsId,
        remoteId: [t.table_schema, t.table_name],
      },
      displayName: t.table_name,
      parentPath: t.table_schema,
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
        description: `Table "${t.table_name}" in schema "${t.table_schema}"`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const [schema, tableName] = id.remoteId;

    return this.withPgClient(async (client) => {
      const [columns, pkCandidates, foreignKeys] = await Promise.all([
        client.findAllColumnsInTable(schema, tableName),
        client.findPrimaryColumnCandidates(schema, tableName),
        client.findAllForeignKeysInTable(schema, tableName),
      ]);

      const primaryKey = this.pickPrimaryKey(pkCandidates, columns);

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
      let titlePath: DotPath | undefined;
      let slugPath: DotPath | undefined;

      for (const col of columns) {
        const isNullable = col.is_nullable === 'YES';
        const hasDefault = col.column_default !== null;
        const { schema: colSchema, pgType } = mapPgType(col.data_type, col.udt_name, isNullable);

        const annotated = { ...colSchema, [CONNECTOR_DATA_TYPE]: pgType } as TSchema;

        if (col.character_maximum_length !== null) {
          (annotated as Record<string, unknown>)[X_SCRATCH_MAX_LENGTH] = col.character_maximum_length;
        }

        if (isGeneratedColumn(col) || col.is_updatable === 'NO') {
          (annotated as Record<string, unknown>)[READONLY_FLAG] = true;
        }

        const linkedTableId = fkMap.get(col.column_name);
        if (linkedTableId) {
          (annotated as Record<string, unknown>)[X_SCRATCH_FOREIGN_KEY_OPTIONS] = { linkedTableId };
        }

        schemaProperties[col.column_name] = isNullable || hasDefault ? Type.Optional(annotated) : annotated;

        if (!titlePath && TITLE_COLUMN_CANDIDATES.includes(col.column_name) && PG_TEXT_TYPES.has(col.udt_name)) {
          titlePath = dotPath(col.column_name);
        }

        if (col.column_name === 'slug') {
          slugPath = dotPath('slug');
        }
      }

      const tableSchema = Type.Object(schemaProperties, {
        $id: `postgres/${schema}.${tableName}`,
        title: tableName,
      });

      return {
        id,
        slug: tableName,
        name: tableName,
        schema: tableSchema,
        idPath: dotPath(primaryKey),
        titlePath,
        slugPath,
        basePath: [schema],
        generatedAt: new Date().toISOString(),
        defaultView: buildPgDefaultView(tableSchema),
      };
    });
  }

  /**
   * Pick the best primary key column. Prefers a single auto-generated PK.
   * Falls back to first PK candidate, then 'id'.
   */
  private pickPrimaryKey(candidates: string[], columns: InformationSchemaColumn[]): string {
    if (candidates.length === 1) {
      return candidates[0];
    }

    if (candidates.length > 1) {
      const colMap = new Map(columns.map((c) => [c.column_name, c]));
      const generated = candidates.find((name) => {
        const col = colMap.get(name);
        return col && isGeneratedColumn(col);
      });
      return generated ?? candidates[0];
    }

    return 'id';
  }

  // -------------------------------------------------------------------------
  // Pull
  // -------------------------------------------------------------------------

  /**
   * Postgres supports incremental pulls only when the user has declared which
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

    const [schema, tableName] = tableSpec.id.remoteId;
    await this.withPgClient(async (client) => {
      const pk = tableSpec.idPath;
      let offset = (progress as { nextOffset?: number })?.nextOffset ?? 0;

      while (true) {
        const rows = await client.selectAll(
          schema,
          tableName,
          undefined,
          pk,
          READ_BATCH_SIZE,
          offset,
          rawFilter,
          modifiedSinceColumn,
          modifiedSinceDatetime,
        );
        if (rows.length === 0) break;

        offset += rows.length;
        await callback({ files: rows as ConnectorFile[], connectorProgress: { nextOffset: offset } });

        if (rows.length < READ_BATCH_SIZE) break;
      }
    });
    return newWatermark ? { newWatermark } : {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const [schema, tableName] = tableSpec.id.remoteId;
    return this.withPgClient(async (client) => {
      const pk = tableSpec.idPath;

      for (let i = 0; i < ids.length; i += READ_BATCH_SIZE) {
        const batch = ids.slice(i, i + READ_BATCH_SIZE);
        const rows = await client.selectByIds(schema, tableName, ['*'], pk, batch);
        if (rows.length > 0) {
          await callback({ files: rows as ConnectorFile[] });
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  supportsFilters(): boolean {
    return true;
  }

  supportsFieldSelection(): boolean {
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getBatchSize(_operation: 'create' | 'update' | 'delete'): number {
    return getPostgresPublishBatchSize();
  }

  // -------------------------------------------------------------------------
  // Schema creation (create-schema API — DEV-10381)
  // -------------------------------------------------------------------------

  override supportsSchemaCreation(): boolean {
    return true;
  }

  override getSchemaCreationCapabilities(): SchemaCreationCapabilities {
    return POSTGRES_SCHEMA_CREATION_CAPABILITIES;
  }

  /**
   * Create one table (with an auto-generated `id` primary key) and its
   * non-deferred fields in a single `CREATE TABLE`. ForeignKey targets are
   * already resolved to existing tables by the server; here we introspect each
   * target's primary-key column so the FK references it with a matching type.
   * Creates are NOT idempotent — re-running creates a second table (or fails with
   * "already exists").
   */
  override async createTable(plan: NormalizedCreateTablePlan): Promise<CreateTableResult> {
    const schema = plan.remoteParentId?.[0] ?? DEFAULT_POSTGRES_SCHEMA;
    const tableName = plan.name;
    try {
      return await this.withPgClient(async (client) => {
        if (schema !== DEFAULT_POSTGRES_SCHEMA) {
          await client.createSchemaIfNotExists(schema);
        }
        const foreignKeyResolutions = await this.resolveForeignKeyTargets(client, plan.fields);
        const { skippedFields } = await client.createTable(schema, tableName, plan.fields, foreignKeyResolutions);
        const fields = this.buildFieldResults(plan.fields, skippedFields);
        return {
          ref: plan.ref,
          name: tableName,
          status: skippedFields.size > 0 ? 'partial' : 'created',
          remoteTableId: [schema, tableName],
          fields,
        };
      });
    } catch (error) {
      return {
        ref: plan.ref,
        name: tableName,
        status: 'failed',
        fields: plan.fields.map((field) => ({ name: field.name, status: 'failed' as const })),
        error: this.extractConnectorErrorDetails(error).userFriendlyMessage,
      };
    }
  }

  /**
   * Add fields to an existing table — one `ALTER TABLE … ADD COLUMN` per field so
   * a single bad field fails in isolation rather than rolling back the rest. Also
   * used by the server to add deferred cyclic/self foreignKey fields after every
   * table in a multi-table create exists.
   */
  override async createFields(plan: NormalizedCreateFieldsPlan): Promise<CreateFieldResult[]> {
    const [schema, tableName] = this.splitRemoteTableId(plan.remoteTableId);
    return this.withPgClient(async (client) => {
      const foreignKeyResolutions = await this.resolveForeignKeyTargets(client, plan.fields);
      const results: CreateFieldResult[] = [];
      for (const field of plan.fields) {
        try {
          const { skippedFields } = await client.addColumns(schema, tableName, [field], foreignKeyResolutions);
          const skipReason = skippedFields.get(field.name);
          results.push(
            skipReason !== undefined
              ? { name: field.name, status: 'skipped', error: skipReason }
              : { name: field.name, status: 'created', remoteFieldId: field.name },
          );
        } catch (error) {
          results.push({
            name: field.name,
            status: 'failed',
            error: this.extractConnectorErrorDetails(error).userFriendlyMessage,
          });
        }
      }
      return results;
    });
  }

  /**
   * Build the per-field result list for a created table: each requested field is
   * `created` (its column name is the stable remote field id) unless it was
   * skipped (an unresolvable/allowMultiple foreign key, or the reserved `id`
   * name), in which case the reason is surfaced.
   */
  private buildFieldResults(
    fields: ResolvedCreateFieldSpec[],
    skippedFields: Map<string, string>,
  ): CreateFieldResult[] {
    return fields.map((field) => {
      const skipReason = skippedFields.get(field.name);
      if (skipReason !== undefined) {
        return { name: field.name, status: 'skipped', error: skipReason };
      }
      return { name: field.name, status: 'created', remoteFieldId: field.name };
    });
  }

  /**
   * For every single-valued foreignKey field, introspect its (already server-
   * resolved) target table's primary-key column + type so the FK column matches.
   * A target with no usable primary key yields an `unresolvable` reason that the
   * builder turns into a per-field skip.
   */
  private async resolveForeignKeyTargets(
    client: KnexPGClient,
    fields: ResolvedCreateFieldSpec[],
  ): Promise<ForeignKeyResolutions> {
    const resolutions: ForeignKeyResolutions = new Map();
    for (const field of fields) {
      const fieldType = field.fieldType;
      if (fieldType.kind !== 'foreignKey' || fieldType.allowMultiple) {
        continue;
      }
      if (!('existingRemoteTableId' in fieldType.target)) {
        // The server resolves every {ref} target before dispatch; a lingering ref is a bug.
        resolutions.set(field.name, {
          kind: 'unresolvable',
          reason: `foreign key "${field.name}" target was not resolved to an existing table`,
        });
        continue;
      }
      const [targetSchema, targetTable] = this.splitRemoteTableId(fieldType.target.existingRemoteTableId);
      const primaryKey = await client.findTablePrimaryKeyColumn(targetSchema, targetTable);
      if (primaryKey === null) {
        resolutions.set(field.name, {
          kind: 'unresolvable',
          reason: `couldn't create foreign key "${field.name}": the linked table "${targetSchema}.${targetTable}" has no primary key to reference`,
        });
        continue;
      }
      resolutions.set(field.name, {
        kind: 'resolved',
        targetTableQualified: `${targetSchema}.${targetTable}`,
        targetPkColumn: primaryKey.column,
        targetPkType: primaryKey.dataType,
      });
    }
    return resolutions;
  }

  /** Split a `[schema, table]` remoteId (defaulting the schema to `public` for a bare `[table]`). */
  private splitRemoteTableId(remoteTableId: string[]): [schema: string, table: string] {
    if (remoteTableId.length >= 2) {
      return [remoteTableId[0], remoteTableId[1]];
    }
    return [DEFAULT_POSTGRES_SCHEMA, remoteTableId[0]];
  }

  // -------------------------------------------------------------------------
  // Create / Update / Delete
  // -------------------------------------------------------------------------

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const [schema, tableName] = tableSpec.id.remoteId;
    return this.withPgClient(async (client) => {
      const pk = tableSpec.idPath;
      return client.insertMany(schema, tableName, pk, files);
    });
  }

  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const [schema, tableName] = tableSpec.id.remoteId;
    return this.withPgClient(async (client) => {
      const pk = tableSpec.idPath;
      const records = files.map((file, index) => {
        const data = { ...(changedFields?.[index] ?? file) };
        delete data[pk];
        return { id: file[pk] as string | number, data };
      });

      const persisted = await client.updateMany(schema, tableName, pk, records);
      // `updateMany` runs `UPDATE … RETURNING t.*` so each entry is
      // either the row Postgres actually stored (trigger-set timestamps,
      // normalized values, native PK types) or 'not_found'. Map back to
      // `ConnectorFile[]` parallel to `files`; fall back to the sent
      // payload only when the row went missing mid-publish.
      return persisted.map((row, i) => (row === 'not_found' ? files[i] : (row as ConnectorFile)));
    });
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const [schema, tableName] = tableSpec.id.remoteId;
    return this.withPgClient(async (client) => {
      const pk = tableSpec.idPath;
      const ids = files.map((file) => file[pk] as string | number);
      if (ids.length > 0) {
        await client.deleteMany(schema, tableName, ids, pk);
      }
    });
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titlePath && !tableSpec.titlePath.includes('.') ? tableSpec.titlePath : undefined;
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, titlePath);
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

    if (error && typeof error === 'object' && 'code' in error) {
      const pgError = error as { code: string; message: string; detail?: string };
      return {
        userFriendlyMessage: this.getPgErrorMessage(pgError.code, pgError.message),
        description: pgError.detail ?? pgError.message,
        additionalContext: { code: pgError.code },
      };
    }

    if (error instanceof Error && error.name === 'KnexTimeoutError') {
      return {
        userFriendlyMessage: 'Connection to the database timed out. Please check your connection settings.',
        description: error.message,
      };
    }

    if (error instanceof Error) {
      const msg = error.message;

      if (msg.startsWith('Knex: Timeout acquiring a connection')) {
        return {
          userFriendlyMessage:
            'Could not connect to the database. Please verify the host and port in your connection string.',
          description: msg,
        };
      }

      if (msg.includes('getaddrinfo ENOTFOUND')) {
        return {
          userFriendlyMessage:
            'Could not resolve the database hostname. If your password contains special characters, they must be URL-encoded.',
          description: msg,
        };
      }

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

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    // No-op: connections are automatically disposed after each operation via withPgClient()
  }
}

connectorRegistry.register({
  service: Service.POSTGRES,
  metadata: PostgresConnector.metadata,
  advancedSettings: PostgresConnector.advancedSettings,
  supportedAuthMethods: ['user_provided_params'],
  resolveIncrementalPullSupport: ({ options }) => pgIncrementalPullSupport(options),
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
