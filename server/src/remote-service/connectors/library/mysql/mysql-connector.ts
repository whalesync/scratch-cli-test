/**
 * MySQL connector (DEV-12035): MySQL 8.x, MariaDB and MySQL-protocol managed services (RDS/Aurora, Cloud SQL,
 * Azure Flexible, DigitalOcean/Aiven, PlanetScale, TiDB).
 *
 * Modeled on the Postgres connector: a short-lived knex client per operation, `[database, table]` remote ids,
 * discovery from `information_schema`, full record CRUD, and schema creation (so MySQL can be a Live Export
 * destination). MySQL has no `RETURNING`, so writes are "write, then re-select" inside one transaction, guarded
 * against a non-unique id matching several rows. See STATE.md for the type representation decisions and LOG.md
 * for the driver spike behind them.
 */
import {
  connectorMetadata,
  ConnectorSettingDefinition,
  IncrementalPullSupport,
  JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT,
  type CreateFieldResult,
  type CreateTableResult,
  type SchemaCreationCapabilities,
  type TableView,
} from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError } from '../../error';
import {
  type NormalizedCreateFieldsPlan,
  type NormalizedCreateTablePlan,
  type ResolvedCreateFieldSpec,
} from '../../schema-creation.types';
import { Service } from '../../service-constants';
import {
  type BaseJsonTableSpec,
  type ConnectorErrorDetails,
  type ConnectorFile,
  type CreateDestination,
  type EntityId,
  type PullRecordFilesOptions,
  type PullRecordFilesResult,
  type TablePreview,
} from '../../types';
import { applyPgClockSkew, pgIncrementalPullSupport, resolvePgModifiedAtField } from '../pg-common/pg-incremental';
import { KnexMySqlClient, MYSQL_STATEMENT_TIMEOUT_MS, type KnexMySqlClientDependencies } from './knex-mysql-client';
import { MySqlAuthParser } from './mysql-auth-parser';
import {
  findAllColumnsInTable,
  findAllTables,
  findDatabaseNames,
  findMariaDbJsonAliasColumnNames,
  findPrimaryKeyColumnNames,
  findSingleColumnForeignKeysInTable,
  findSingleColumnUniqueIndexColumns,
  findTablesWithAutoIncrementPrimaryKey,
  findTablesWithSingleColumnUniqueIndex,
} from './mysql-catalog-queries';
import {
  isMySqlSystemDatabaseName,
  MYSQL_SYSTEM_DATABASE_NAMES,
  type MySqlDiscoveryScope,
} from './mysql-catalog-types';
import { MySqlClientError, MySqlClientProblem } from './mysql-client-error';
import { parseStoredMySqlCredentials } from './mysql-connection-options';
import {
  findMySqlIdentifierProblem,
  isMySqlDuplicateTableError,
  MYSQL_SCHEMA_CREATION_CAPABILITIES,
  mySqlSchemaCreationErrorMessage,
  type MySqlForeignKeyResolution,
} from './mysql-create-schema';
import { buildMySqlDefaultView } from './mysql-default-view';
import { describeMySqlError } from './mysql-error-mapping';
import { resolveMySqlFieldValueCanonicalizer } from './mysql-field-value-canonicalizer';
import { validateMySqlWhereFilter } from './mysql-filter-validator';
import {
  canonicalMySqlPrimaryKeyText,
  resolveMySqlPrimaryKeyBindingKind,
  toBindableMySqlPrimaryKeyValue,
  type MySqlPrimaryKeyBindingKind,
} from './mysql-id-binding';
import {
  assertMySqlModifiedAtColumnIsUsable,
  listSelectableColumnNames,
  readPageSizeForTableSpec,
} from './mysql-incremental';
import { buildMySqlJsonTableSpec, buildMySqlTablePreview } from './mysql-json-schema';
import { MYSQL_LOGO_DATA_URI } from './mysql-logo';
import {
  buildMySqlTableWriteProfile,
  buildMySqlUpdateChangeSetWithWholeTopLevelValues,
  prepareRecordsForMySqlWrite,
} from './mysql-record-preparation';
import { selectTableRowsByIds, selectTableRowsPage } from './mysql-record-reads';
import {
  deleteRecordsByPrimaryKey,
  insertRecordsReturningPersistedRows,
  updateRecordsByPrimaryKeyReturningPersistedRows,
  type MySqlRecordWriteTarget,
} from './mysql-record-writes';
import {
  addForeignKeyColumnWithConstraint,
  addNonForeignKeyColumn,
  createTableWithAutoIncrementPrimaryKey,
  resolveForeignKeyReferenceForTargetTable,
} from './mysql-schema-creation-queries';
import { type MySqlServerFlavor } from './mysql-server-flavor';
import { formatInstantAsMySqlUtcDateTimeLiteral } from './mysql-temporal-values';
import { type MySqlConnectionOptions, type MySqlTableReference } from './mysql-types';

const DEFAULT_MYSQL_PUBLISH_BATCH_SIZE = 100;
export const LOCAL_MYSQL_PUBLISH_BATCH_SIZE_ENV = 'LOCAL_MYSQL_PUBLISH_BATCH_SIZE';
/** By-id pulls fetch this many ids per `WHERE id IN (...)`. */
const MYSQL_PULL_BY_IDS_BATCH_SIZE = 500;

function getMySqlPublishBatchSize(): number {
  const rawBatchSize = process.env[LOCAL_MYSQL_PUBLISH_BATCH_SIZE_ENV];
  if (!rawBatchSize) return DEFAULT_MYSQL_PUBLISH_BATCH_SIZE;
  const parsedBatchSize = Number.parseInt(rawBatchSize, 10);
  return Number.isFinite(parsedBatchSize) && parsedBatchSize > 0 ? parsedBatchSize : DEFAULT_MYSQL_PUBLISH_BATCH_SIZE;
}

// ---------------------------------------------------------------------------------------------------------------
// Id guards: an edited id on update, a repeated id on pull
// ---------------------------------------------------------------------------------------------------------------

/**
 * True when the publish pipeline's change set for a record edits the id column. Rows are addressed by the id in the
 * file, which after such an edit is the NEW value, so `UPDATE … WHERE id = <new value>` would overwrite whichever row
 * already has that id (and report success, because the row read back carries the id that was asked for) or match
 * no row at all.
 *
 * Only a PARTIAL change set (one that names some, not all, of the file's columns) is checked. The pipeline sends the
 * whole record as the change set when it can't read the record's published copy, and there an id key says nothing
 * about an edit; rejecting it would fail every such record. Residual risk: an id edit inside that whole-record
 * fallback, or an edit that changed every column of the record (both columns of a two-column table, say), looks
 * exactly like the fallback and is still addressed by the edited id. The complete fix belongs in the publish runner,
 * which knows each record's stored remote id and can compare it with the content's id for every connector (the
 * Postgres connector has the same gap).
 */
function isPartialChangeSetThatEditsIdColumn(
  file: ConnectorFile,
  changedFieldsForRecord: Record<string, unknown> | undefined,
  idColumnName: string,
): boolean {
  if (changedFieldsForRecord === undefined) return false;
  if (!Object.prototype.hasOwnProperty.call(changedFieldsForRecord, idColumnName)) return false;
  const changeSetNamesEveryColumnOfTheFile = Object.keys(file).every((fileColumnName) =>
    Object.prototype.hasOwnProperty.call(changedFieldsForRecord, fileColumnName),
  );
  return !changeSetNamesEveryColumnOfTheFile;
}

function buildIdColumnEditedMessage(idColumnName: string): string {
  return `The ID field "${idColumnName}" was edited, and Scratch can't publish a new ID: it finds the MySQL row to update by its ID, so the new value would update a different row (or none). Revert the edit. To give the row a new ID, change it in MySQL directly and pull again.`;
}

/**
 * What the duplicate-id guards compare: the id binding's canonical text (the same normalization writes use to line
 * rows up with ids), with NULL kept as a value of its own, because rows without an id collapse into one record just
 * like rows that share one. A value the canonical form doesn't cover (a JSON document chosen as the ID field)
 * compares by its JSON text.
 */
function readPulledRowIdComparisonKey(
  pulledRowIdValue: unknown,
  primaryKeyBindingKind: MySqlPrimaryKeyBindingKind,
): string | null {
  if (pulledRowIdValue === null || pulledRowIdValue === undefined) return null;
  return canonicalMySqlPrimaryKeyText(pulledRowIdValue, primaryKeyBindingKind) ?? JSON.stringify(pulledRowIdValue);
}

/** The message never quotes the repeated value: it is row data, and job errors are stored and logged verbatim. */
function buildPulledDuplicateIdError(
  idColumnName: string,
  tableName: string,
  repeatedIdComparisonKey: string | null,
): MySqlClientError {
  const whatTheRowsShare =
    repeatedIdComparisonKey === null ? 'have no value (NULL) in it' : 'share the same value in it';
  return new MySqlClientError(
    MySqlClientProblem.PulledDuplicateId,
    `The ID field "${idColumnName}" isn't unique: several rows of "${tableName}" ${whatTheRowsShare}, so Scratch can't tell them apart and would merge them into one record. Choose a column whose values are unique for every row, such as the primary key, as the ID field.`,
  );
}

/** The comparison key of the last row a full pull delivered; carried from page to page (undefined before any row). */
type LastPulledRowIdComparisonKey = { comparisonKey: string | null } | undefined;

/**
 * Fail the pull on the first row whose id equals the previous row's. Rows arrive ordered by the id column, so equal
 * ids are adjacent, including across a page boundary when the previous page's last key is passed in. (A
 * case-insensitive collation sorts `'a'`, `'A'`, `'a'` as ties in any order, so a repeat separated by a case variant
 * can slip through; a column with repeated values nearly always has adjacent repeats too.) Returns the key to carry
 * into the next page.
 */
function assertConsecutivePulledRowsHaveDistinctIds(params: {
  pulledRows: Record<string, unknown>[];
  idColumnName: string;
  tableName: string;
  primaryKeyBindingKind: MySqlPrimaryKeyBindingKind;
  lastRowIdComparisonKeyOfPreviousPage: LastPulledRowIdComparisonKey;
}): LastPulledRowIdComparisonKey {
  let lastRowIdComparisonKey = params.lastRowIdComparisonKeyOfPreviousPage;
  for (const pulledRow of params.pulledRows) {
    const rowIdComparisonKey = readPulledRowIdComparisonKey(
      pulledRow[params.idColumnName],
      params.primaryKeyBindingKind,
    );
    if (lastRowIdComparisonKey !== undefined && lastRowIdComparisonKey.comparisonKey === rowIdComparisonKey) {
      throw buildPulledDuplicateIdError(params.idColumnName, params.tableName, rowIdComparisonKey);
    }
    lastRowIdComparisonKey = { comparisonKey: rowIdComparisonKey };
  }
  return lastRowIdComparisonKey;
}

/**
 * A by-id query returning two rows for one id means the ID field isn't unique. One SELECT reads a single consistent
 * snapshot, so any repeat is real (never a paging artifact) and the whole batch can be checked, not just neighbours.
 */
function assertRowsFetchedByIdsHaveDistinctIds(params: {
  rowsFetchedByIds: Record<string, unknown>[];
  idColumnName: string;
  tableName: string;
  primaryKeyBindingKind: MySqlPrimaryKeyBindingKind;
}): void {
  const idComparisonKeysSeenInThisBatch = new Set<string | null>();
  for (const rowFetchedById of params.rowsFetchedByIds) {
    const rowIdComparisonKey = readPulledRowIdComparisonKey(
      rowFetchedById[params.idColumnName],
      params.primaryKeyBindingKind,
    );
    if (idComparisonKeysSeenInThisBatch.has(rowIdComparisonKey)) {
      throw buildPulledDuplicateIdError(params.idColumnName, params.tableName, rowIdComparisonKey);
    }
    idComparisonKeysSeenInThisBatch.add(rowIdComparisonKey);
  }
}

export class MysqlConnector extends Connector {
  readonly service = Service.MYSQL;
  static readonly displayName = 'MySQL';
  static readonly metadata = connectorMetadata({
    displayName: 'MySQL',
    record: 'row',
    records: 'rows',
    base: 'database',
    bases: 'databases',
    // A new table lands in one of the connection's databases.
    createDestination: 'database',
    createDestinations: 'databases',
    logo: MYSQL_LOGO_DATA_URI,
    visible: true,
    incrementalPull: true,
    incrementalPullInstructions:
      'To enable incremental pulls, this table must contain a TIMESTAMP or DATETIME column that records when a row was last changed (e.g. updated_at).',
    supportsSchemaCreation: true,
    userProvidedParamsLabel: 'Database connection',
    credentialFields: {
      user_provided_params: [
        {
          key: 'databaseHost',
          type: 'string',
          label: 'Host',
          placeholder: 'mydb.example.com',
          description:
            "The server's hostname or IP address, without a port or protocol. The database must be reachable from the public internet and allow connections from Scratch's IP address. Fill in Host and Username, or paste a connection string below instead.",
        },
        { key: 'databasePort', type: 'number', label: 'Port', placeholder: '3306' },
        {
          key: 'databaseName',
          type: 'string',
          label: 'Database',
          description: 'Optional. Leave blank to see every database this user can access.',
        },
        { key: 'username', type: 'string', label: 'Username' },
        { key: 'password', type: 'password', label: 'Password' },
        {
          key: 'sslMode',
          type: 'string',
          label: 'SSL mode',
          placeholder: 'REQUIRED',
          description:
            "REQUIRED (default): encrypted, certificate not checked. VERIFY_CA: also checks the server's certificate chain. VERIFY_IDENTITY: also checks the hostname (needs a hostname, not an IP address, in Host). DISABLED: unencrypted — avoid on the public internet.",
        },
        {
          key: 'sslCaCertificate',
          type: 'password',
          label: 'CA certificate (PEM)',
          description:
            "Optional, for VERIFY_CA / VERIFY_IDENTITY: your provider's CA certificate bundle. Amazon RDS and publicly trusted certificates work without one.",
        },
        {
          key: 'connectionString',
          type: 'password',
          label: 'Connection string',
          placeholder: 'mysql://user:password@host:3306/database',
          description:
            'Optional alternative to Host, Port, Database, Username and Password. Scratch splits it into those settings and never stores the string itself.',
        },
      ],
    },
  });
  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'modifiedAtField',
      type: 'field-select',
      label: 'Update field',
      description:
        'A TIMESTAMP or DATETIME column that records when a row last changed (e.g. updated_at). DATETIME values are compared as UTC, so they must be written in UTC.',
      placeholder: 'e.g. updated_at',
      fieldSelectFormats: ['date-time', JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT],
    },
  ];

  /** Remembered across operations so error messages can name flavor-specific behaviour. */
  private lastDetectedServerFlavor: MySqlServerFlavor | undefined;

  constructor(
    private readonly connectionOptions: MySqlConnectionOptions,
    private readonly clientDependencies?: KnexMySqlClientDependencies,
  ) {
    super();
  }

  /** Run an operation with a short-lived client that is disposed when it completes (or throws). */
  private async withMySqlClient<T>(operation: (client: KnexMySqlClient) => Promise<T>): Promise<T> {
    const client = new KnexMySqlClient(this.connectionOptions, this.clientDependencies);
    try {
      return await operation(client);
    } finally {
      this.lastDetectedServerFlavor = client.detectedServerFlavor ?? this.lastDetectedServerFlavor;
      try {
        await client.dispose();
      } catch {
        // Never let a dispose error mask the operation's own error.
      }
    }
  }

  private get discoveryScope(): MySqlDiscoveryScope {
    return {
      excludedDatabaseNames: MYSQL_SYSTEM_DATABASE_NAMES,
      onlyDatabaseName: this.connectionOptions.databaseName,
    };
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async testConnection(): Promise<void> {
    await this.withMySqlClient((client) => client.testQuery());
  }

  // -------------------------------------------------------------------------
  // Table discovery
  // -------------------------------------------------------------------------

  async listTables(): Promise<TablePreview[]> {
    return this.withMySqlClient(async (client) => {
      // Sequential on purpose: the pool has one connection, so concurrent queries would only queue behind each
      // other against the acquire timeout.
      const tables = await findAllTables(client.knex, this.discoveryScope);
      const tablesWithSingleColumnUniqueIndex = await findTablesWithSingleColumnUniqueIndex(
        client.knex,
        this.discoveryScope,
      );
      const tablesWithAutoIncrementPrimaryKey = await findTablesWithAutoIncrementPrimaryKey(
        client.knex,
        this.discoveryScope,
      );
      return tables.map((table) =>
        buildMySqlTablePreview(table, { tablesWithSingleColumnUniqueIndex, tablesWithAutoIncrementPrimaryKey }),
      );
    });
  }

  /** New tables are created in one of the (non-system) databases this connection can see. */
  override async listCreateDestinations(): Promise<CreateDestination[]> {
    return this.withMySqlClient(async (client) => {
      const databaseNames = await findDatabaseNames(client.knex, this.discoveryScope);
      return databaseNames.map((databaseName) => ({ id: databaseName, name: databaseName, created: true }));
    });
  }

  // No `buildCreateDestinationRemoteWebUrl`: a MySQL database has no web UI to deep-link into.

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    return buildMySqlDefaultView(spec.schema);
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const table = this.tableReferenceFromRemoteId(id.remoteId);
    return this.withMySqlClient(async (client) => {
      const serverFlavor = await client.getServerFlavor();
      const columns = await findAllColumnsInTable(client.knex, table);
      const primaryKeyColumnNames = await findPrimaryKeyColumnNames(client.knex, table);
      const singleColumnUniqueIndexColumns = await findSingleColumnUniqueIndexColumns(client.knex, table);
      const foreignKeys = await findSingleColumnForeignKeysInTable(client.knex, table);
      const mariaDbJsonAliasColumnNames =
        serverFlavor === 'mariadb' ? await findMariaDbJsonAliasColumnNames(client.knex, table) : new Set<string>();
      return buildMySqlJsonTableSpec({
        entityId: id,
        table,
        columns,
        primaryKeyColumnNames,
        singleColumnUniqueIndexColumns,
        foreignKeys,
        mariaDbJsonAliasColumnNames,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Pull
  // -------------------------------------------------------------------------

  /**
   * Incremental pulls need an explicit `modifiedAtField` (no schema auto-detect in v1: an
   * `ON UPDATE CURRENT_TIMESTAMP` column can still be NULL on new rows, and a DATETIME one is written in the
   * writer's session zone). Without it the job demotes the run to a full scan.
   */
  override incrementalPullSupport(
    options: PullRecordFilesOptions,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _tableSpec: BaseJsonTableSpec | null,
  ): IncrementalPullSupport {
    return pgIncrementalPullSupport(options);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const whereFilter = options.filter?.trim() || undefined;
    if (whereFilter) {
      validateMySqlWhereFilter(whereFilter);
    }

    const modifiedAtField = resolvePgModifiedAtField(options);
    const isIncremental =
      options.pullMode === 'incremental' && modifiedAtField !== undefined && options.since instanceof Date;

    let newWatermark: Date | undefined;
    let modifiedSince: { columnName: string; exclusiveLowerBoundUtcLiteral: string } | undefined;
    if (isIncremental && options.since && modifiedAtField) {
      // Reject a typo'd or non-time column up front (it comes from user options).
      assertMySqlModifiedAtColumnIsUsable(tableSpec, modifiedAtField);
      // Capture the watermark BEFORE the first query so rows changed mid-pull are re-pulled next time.
      newWatermark = new Date();
      modifiedSince = {
        columnName: modifiedAtField,
        exclusiveLowerBoundUtcLiteral: formatInstantAsMySqlUtcDateTimeLiteral(applyPgClockSkew(options.since)),
      };
    }

    const table = this.tableReferenceFromRemoteId(tableSpec.id.remoteId);
    const selectedColumnNames = listSelectableColumnNames(tableSpec);
    const pageSize = readPageSizeForTableSpec(tableSpec);
    const primaryKeyBindingKind = resolveMySqlPrimaryKeyBindingKind(tableSpec);
    await this.withMySqlClient(async (client) => {
      // The table picker lets the user choose ANY column as the ID field. One without a single-column unique index
      // can repeat a value; the OFFSET pages then order its ties differently from query to query (overlapping and
      // skipping rows), and rows that share an id collapse into one record. So such a column is checked row by row
      // and the pull fails loudly. A unique-indexed id is never checked: there a repeat across a page boundary can
      // only be a row shifted by a concurrent insert, which is harmless (the pipeline keys files by id) and must not
      // fail the pull of a busy table. (A NULLABLE unique id can still hold several NULLs; that known gap is left
      // as it was.)
      const idColumnIsBackedBySingleColumnUniqueIndex = (
        await findSingleColumnUniqueIndexColumns(client.knex, table)
      ).some((uniqueIndexColumn) => uniqueIndexColumn.columnName === tableSpec.idPath);
      let lastPulledRowIdComparisonKey: LastPulledRowIdComparisonKey;
      let pageOffset = (progress as { nextOffset?: number })?.nextOffset ?? 0;
      while (true) {
        const rows = await selectTableRowsPage(client.knex, {
          table,
          selectedColumnNames,
          idColumnName: tableSpec.idPath,
          pageSize,
          pageOffset,
          whereFilter,
          modifiedSince,
        });
        if (rows.length === 0) break;
        if (!idColumnIsBackedBySingleColumnUniqueIndex) {
          // Checked before the page is handed on, so no record of a page with a repeated id is ever written.
          lastPulledRowIdComparisonKey = assertConsecutivePulledRowsHaveDistinctIds({
            pulledRows: rows,
            idColumnName: tableSpec.idPath,
            tableName: table.tableName,
            primaryKeyBindingKind,
            lastRowIdComparisonKeyOfPreviousPage: lastPulledRowIdComparisonKey,
          });
        }
        pageOffset += rows.length;
        await callback({ files: rows as ConnectorFile[], connectorProgress: { nextOffset: pageOffset } });
        if (rows.length < pageSize) break;
      }
    });
    return newWatermark ? { newWatermark } : {};
  }

  /**
   * Ids that no longer exist (or can't match the id column's type) are skipped silently, per the contract. An id
   * that matches several rows (an ID field that isn't unique) fails the pull instead of writing one file per row
   * to the same path.
   */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const table = this.tableReferenceFromRemoteId(tableSpec.id.remoteId);
    const primaryKeyBindingKind = resolveMySqlPrimaryKeyBindingKind(tableSpec);
    const idBindingValues = ids.flatMap((id) => {
      const bindable = toBindableMySqlPrimaryKeyValue(id, primaryKeyBindingKind);
      return bindable.isMatchable ? [bindable.bindableValue] : [];
    });
    const selectedColumnNames = listSelectableColumnNames(tableSpec);
    // Tables with MEDIUMBLOB / LONGBLOB columns read smaller batches, as full pulls do (memory per round trip).
    const idsPerQuery = Math.min(MYSQL_PULL_BY_IDS_BATCH_SIZE, readPageSizeForTableSpec(tableSpec));
    await this.withMySqlClient(async (client) => {
      for (let batchStart = 0; batchStart < idBindingValues.length; batchStart += idsPerQuery) {
        const rows = await selectTableRowsByIds(client.knex, {
          table,
          selectedColumnNames,
          idColumnName: tableSpec.idPath,
          idBindingValues: idBindingValues.slice(batchStart, batchStart + idsPerQuery),
        });
        // Per batch only: the same id asked for in two batches is legitimately returned twice.
        assertRowsFetchedByIdsHaveDistinctIds({
          rowsFetchedByIds: rows,
          idColumnName: tableSpec.idPath,
          tableName: table.tableName,
          primaryKeyBindingKind,
        });
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
    return getMySqlPublishBatchSize();
  }

  // -------------------------------------------------------------------------
  // Schema creation (Live Export destination)
  // -------------------------------------------------------------------------

  override supportsSchemaCreation(): boolean {
    return true;
  }

  override getSchemaCreationCapabilities(): SchemaCreationCapabilities {
    return MYSQL_SCHEMA_CREATION_CAPABILITIES;
  }

  /**
   * Create one table (with an AUTO_INCREMENT `id` primary key) and its fields. Non-foreign-key fields are created
   * with the table; each foreign key is then added by its own atomic `ALTER TABLE … ADD COLUMN …, ADD CONSTRAINT …`,
   * so one unresolvable or rejected reference fails that field only. MySQL DDL commits implicitly, so nothing here
   * runs in a transaction. Creates are NOT idempotent: re-running fails with "already exists".
   */
  override async createTable(plan: NormalizedCreateTablePlan): Promise<CreateTableResult> {
    const failAllFields = (errorMessage: string): CreateTableResult => ({
      ref: plan.ref,
      name: plan.name,
      status: 'failed',
      fields: plan.fields.map((field) => ({ name: field.name, status: 'failed' as const })),
      error: errorMessage,
    });

    const requestedDatabaseName = plan.remoteParentId?.[0] ?? this.connectionOptions.databaseName;
    if (!requestedDatabaseName) {
      return failAllFields('Choose a database to create the table in.');
    }
    if (isMySqlSystemDatabaseName(requestedDatabaseName)) {
      return failAllFields(`"${requestedDatabaseName}" is a MySQL system database; choose another database.`);
    }
    if (
      this.connectionOptions.databaseName !== undefined &&
      requestedDatabaseName !== this.connectionOptions.databaseName
    ) {
      // A table outside the configured database would be invisible to this connection's listTables.
      return failAllFields(
        `This connection is limited to the "${this.connectionOptions.databaseName}" database, so the table can't be created in "${requestedDatabaseName}".`,
      );
    }
    const tableNameProblem = findMySqlIdentifierProblem(plan.name, 'table');
    if (tableNameProblem !== undefined) {
      return failAllFields(tableNameProblem);
    }

    const requestedTable: MySqlTableReference = { databaseName: requestedDatabaseName, tableName: plan.name };
    try {
      return await this.withMySqlClient(async (client) => {
        // Resolve every foreign-key target BEFORE any DDL, so an unresolvable reference never leaves a half-made table.
        const foreignKeyResolutionByFieldName = await this.resolveForeignKeyTargets(client, plan.fields);
        const nonForeignKeyFields = plan.fields.filter((field) => field.fieldType.kind !== 'foreignKey');
        const { skipReasonByFieldName, storedTable } = await createTableWithAutoIncrementPrimaryKey(
          client,
          requestedTable,
          nonForeignKeyFields,
        );
        const failureMessageByFieldName = new Map<string, string>();
        for (const field of plan.fields) {
          if (field.fieldType.kind !== 'foreignKey') continue;
          await this.addForeignKeyField(client, storedTable, field, foreignKeyResolutionByFieldName, {
            skipReasonByFieldName,
            failureMessageByFieldName,
          });
        }
        const fields = this.buildFieldResults(plan.fields, skipReasonByFieldName, failureMessageByFieldName);
        const anyFieldNotCreated = fields.some((field) => field.status !== 'created');
        return {
          ref: plan.ref,
          name: storedTable.tableName,
          status: anyFieldNotCreated ? 'partial' : 'created',
          remoteTableId: [storedTable.databaseName, storedTable.tableName],
          fields,
        };
      });
    } catch (error) {
      return failAllFields(
        mySqlSchemaCreationErrorMessage(error, { databaseName: requestedDatabaseName, tableName: plan.name }) ??
          (isMySqlDuplicateTableError(error)
            ? `A table named "${plan.name}" already exists in the "${requestedDatabaseName}" database.`
            : this.extractConnectorErrorDetails(error).userFriendlyMessage),
      );
    }
  }

  /**
   * Add fields to an existing table, one statement per field so a bad field fails in isolation. Also how the
   * server adds deferred cyclic / self foreign keys once every table of a multi-table create exists.
   */
  override async createFields(plan: NormalizedCreateFieldsPlan): Promise<CreateFieldResult[]> {
    const table = this.tableReferenceFromRemoteId(plan.remoteTableId);
    return this.withMySqlClient(async (client) => {
      const foreignKeyResolutionByFieldName = await this.resolveForeignKeyTargets(client, plan.fields);
      const results: CreateFieldResult[] = [];
      for (const field of plan.fields) {
        const skipReasonByFieldName = new Map<string, string>();
        const failureMessageByFieldName = new Map<string, string>();
        if (field.fieldType.kind === 'foreignKey') {
          await this.addForeignKeyField(client, table, field, foreignKeyResolutionByFieldName, {
            skipReasonByFieldName,
            failureMessageByFieldName,
          });
        } else {
          try {
            const { skipReason } = await addNonForeignKeyColumn(client, table, field);
            if (skipReason !== undefined) skipReasonByFieldName.set(field.name, skipReason);
          } catch (error) {
            failureMessageByFieldName.set(field.name, this.describeSchemaCreationError(error, table, field.name));
          }
        }
        results.push(...this.buildFieldResults([field], skipReasonByFieldName, failureMessageByFieldName));
      }
      return results;
    });
  }

  private async resolveForeignKeyTargets(
    client: KnexMySqlClient,
    fields: ResolvedCreateFieldSpec[],
  ): Promise<Map<string, MySqlForeignKeyResolution>> {
    const resolutionByFieldName = new Map<string, MySqlForeignKeyResolution>();
    for (const field of fields) {
      const fieldType = field.fieldType;
      if (fieldType.kind !== 'foreignKey' || fieldType.allowMultiple) continue;
      if (!('existingRemoteTableId' in fieldType.target)) {
        // The server resolves every {ref} target before dispatch; a lingering ref is a bug.
        resolutionByFieldName.set(field.name, {
          kind: 'unresolvable',
          reason: 'its target was not resolved to an existing table',
        });
        continue;
      }
      try {
        const targetTable = this.tableReferenceFromRemoteId(fieldType.target.existingRemoteTableId);
        resolutionByFieldName.set(field.name, await resolveForeignKeyReferenceForTargetTable(client.knex, targetTable));
      } catch (error) {
        // One unreadable target skips that field only; the rest of the table (or the other fields) still land.
        resolutionByFieldName.set(field.name, {
          kind: 'unresolvable',
          reason: `Scratch couldn't read its linked table. ${this.extractConnectorErrorDetails(error).userFriendlyMessage}`,
        });
      }
    }
    return resolutionByFieldName;
  }

  private async addForeignKeyField(
    client: KnexMySqlClient,
    table: MySqlTableReference,
    field: ResolvedCreateFieldSpec,
    foreignKeyResolutionByFieldName: Map<string, MySqlForeignKeyResolution>,
    outcomes: { skipReasonByFieldName: Map<string, string>; failureMessageByFieldName: Map<string, string> },
  ): Promise<void> {
    const skipForeignKeyField = (reason: string): void => {
      outcomes.skipReasonByFieldName.set(field.name, `couldn't create foreign key "${field.name}": ${reason}`);
    };
    const fieldType = field.fieldType;
    if (fieldType.kind === 'foreignKey' && fieldType.allowMultiple) {
      skipForeignKeyField(
        'it links to multiple records (allowMultiple), which the MySQL connector does not support — create a single-valued foreign key (or a join table) instead',
      );
      return;
    }
    const identifierProblem = findMySqlIdentifierProblem(field.name, 'column');
    if (identifierProblem !== undefined) {
      outcomes.skipReasonByFieldName.set(field.name, identifierProblem);
      return;
    }
    const resolution = foreignKeyResolutionByFieldName.get(field.name);
    if (!resolution) {
      skipForeignKeyField('its target could not be resolved to a table');
      return;
    }
    if (resolution.kind === 'unresolvable') {
      skipForeignKeyField(resolution.reason);
      return;
    }
    try {
      await addForeignKeyColumnWithConstraint(client, table, field, resolution);
    } catch (error) {
      outcomes.failureMessageByFieldName.set(field.name, this.describeSchemaCreationError(error, table, field.name));
    }
  }

  private describeSchemaCreationError(error: unknown, table: MySqlTableReference, columnName: string): string {
    return (
      mySqlSchemaCreationErrorMessage(error, { ...table, columnName }) ??
      this.extractConnectorErrorDetails(error).userFriendlyMessage
    );
  }

  /** Per-field results: `created` (the column name is the stable remote field id), `skipped` or `failed`. */
  private buildFieldResults(
    fields: ResolvedCreateFieldSpec[],
    skipReasonByFieldName: Map<string, string>,
    failureMessageByFieldName: Map<string, string>,
  ): CreateFieldResult[] {
    return fields.map((field) => {
      const failureMessage = failureMessageByFieldName.get(field.name);
      if (failureMessage !== undefined) return { name: field.name, status: 'failed', error: failureMessage };
      const skipReason = skipReasonByFieldName.get(field.name);
      if (skipReason !== undefined) return { name: field.name, status: 'skipped', error: skipReason };
      return { name: field.name, status: 'created', remoteFieldId: field.name };
    });
  }

  // -------------------------------------------------------------------------
  // Create / Update / Delete
  // -------------------------------------------------------------------------

  private buildRecordWriteTarget(tableSpec: BaseJsonTableSpec): MySqlRecordWriteTarget {
    return {
      ...this.tableReferenceFromRemoteId(tableSpec.id.remoteId),
      primaryKeyColumnName: tableSpec.idPath,
      primaryKeyBindingKind: resolveMySqlPrimaryKeyBindingKind(tableSpec),
      readBackColumnNames: listSelectableColumnNames(tableSpec),
    };
  }

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const writeProfile = buildMySqlTableWriteProfile(tableSpec);
    // Preparation throws before any SQL, so the publish runner's per-record retry isolates a bad row.
    const recordsReadyForInsert = prepareRecordsForMySqlWrite(files, writeProfile);
    const target = this.buildRecordWriteTarget(tableSpec);
    return this.withMySqlClient(
      async (client) =>
        (await insertRecordsReturningPersistedRows(client.knex, target, recordsReadyForInsert)) as ConnectorFile[],
    );
  }

  /**
   * Updates write the whole top-level value of each changed column (a one-key edit inside a JSON document must not
   * replace the document with the sparse diff) and return the rows as MySQL stored them (trigger- and
   * `ON UPDATE CURRENT_TIMESTAMP`-set values included). A record whose row no longer exists fails with
   * RemoteRecordNotFound instead of silently succeeding, and an edited id fails with IdColumnEdited instead of
   * updating the row that has the new id (see `isPartialChangeSetThatEditsIdColumn` for what that guard can't see).
   */
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields?: (Record<string, unknown> | undefined)[],
  ): Promise<ConnectorFile[]> {
    const writeProfile = buildMySqlTableWriteProfile(tableSpec);
    const primaryKeyColumnName = tableSpec.idPath;
    // Rejected before any client exists: the publish runner then retries the batch one record at a time, so only the
    // record whose id was edited fails. No RemoteRecordNotFound code: the row still exists, so the frontends' "run a
    // full sync" recovery for that code wouldn't help.
    for (const [fileIndex, file] of files.entries()) {
      if (isPartialChangeSetThatEditsIdColumn(file, changedFields?.[fileIndex], primaryKeyColumnName)) {
        throw new MySqlClientError(MySqlClientProblem.IdColumnEdited, buildIdColumnEditedMessage(primaryKeyColumnName));
      }
    }
    const changeSets = files.map((file, index) => ({
      recordId: file[primaryKeyColumnName],
      changedColumnValues: prepareRecordsForMySqlWrite(
        [buildMySqlUpdateChangeSetWithWholeTopLevelValues(file, changedFields?.[index], primaryKeyColumnName)],
        writeProfile,
      )[0],
    }));
    const target = this.buildRecordWriteTarget(tableSpec);
    return this.withMySqlClient(
      async (client) =>
        (await updateRecordsByPrimaryKeyReturningPersistedRows(client.knex, target, changeSets)) as ConnectorFile[],
    );
  }

  /** Rows that are already gone are tolerated. */
  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    if (files.length === 0) return;
    const target = this.buildRecordWriteTarget(tableSpec);
    const recordIds = files.map((file) => file[tableSpec.idPath]);
    await this.withMySqlClient((client) => deleteRecordsByPrimaryKey(client.knex, target, recordIds));
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const titlePath = tableSpec.titlePath && !tableSpec.titlePath.includes('.') ? tableSpec.titlePath : undefined;
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, titlePath);
  }

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  /** Never echoes raw driver / network text (it can carry SQL, bound values and resolved IPs). */
  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    return describeMySqlError(error, {
      host: this.connectionOptions.host,
      port: this.connectionOptions.port,
      databaseName: this.connectionOptions.databaseName,
      sslMode: this.connectionOptions.sslMode,
      serverFlavor: this.lastDetectedServerFlavor,
      statementTimeoutMs: MYSQL_STATEMENT_TIMEOUT_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    // No-op: every operation disposes its own client (withMySqlClient).
  }

  /** `[database, table]` → a table reference; a bare `[table]` means the configured database. */
  private tableReferenceFromRemoteId(remoteId: string[]): MySqlTableReference {
    if (remoteId.length >= 2) {
      return { databaseName: remoteId[0], tableName: remoteId[1] };
    }
    if (remoteId.length === 1 && this.connectionOptions.databaseName !== undefined) {
      return { databaseName: this.connectionOptions.databaseName, tableName: remoteId[0] };
    }
    throw new MySqlClientError(
      MySqlClientProblem.TableNotFound,
      `This MySQL table id (${JSON.stringify(remoteId)}) doesn't name a database and table.`,
    );
  }
}

connectorRegistry.register({
  service: Service.MYSQL,
  metadata: MysqlConnector.metadata,
  advancedSettings: MysqlConnector.advancedSettings,
  supportedAuthMethods: ['user_provided_params'],
  resolveIncrementalPullSupport: ({ options }) => pgIncrementalPullSupport(options),
  resolveFieldValueCanonicalizer: resolveMySqlFieldValueCanonicalizer,
  createAuthParser: () => new MySqlAuthParser(),
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for MySQL', Service.MYSQL);
    }
    // Defense in depth: re-validate the stored settings on every connect (PATCH and the dev-tools import can
    // store params without running the AuthParser). No I/O here; connection problems surface at connect time.
    return new MysqlConnector(parseStoredMySqlCredentials(ctx.decryptedCredentials));
  },
});
