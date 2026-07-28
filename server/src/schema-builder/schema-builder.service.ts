import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConnectorAccount } from '@prisma/client';
import { TSchema } from '@sinclair/typebox';
import {
  CreateFieldSpec,
  CreateSchemaFieldsDto,
  CreateSchemaFieldsResponse,
  CreateSchemaPrerequisites,
  CreateSchemaStatus,
  CreateSchemaTablesDto,
  CreateSchemaTablesResponse,
  CreateTableResult,
  DataFolderId,
  GenerateCreatePlanDto,
  GenerateCreatePlanResponse,
  SchemaCreationCapabilities,
  ValidateSchemaIssue,
  ValidateSchemaResponse,
  ValidatedCreateDataFolderDto,
  WorkbookId,
  createSchemaTablesSchema,
} from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { DecryptedCredentials } from 'src/remote-service/connector-account/types/encrypted-credentials.interface';
import { Connector } from 'src/remote-service/connectors/connector';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { getServiceDisplayName } from 'src/remote-service/connectors/display-names';
import { NormalizedCreateTablePlan } from 'src/remote-service/connectors/schema-creation.types';
import { Actor } from 'src/users/types';
import { SchemaField, extractSchemaFields } from 'src/utils/schema-helpers';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { linkedTableIdCandidateTokensForRemoteTableId } from './foreign-key-linked-table-id';
import { selectPlanFieldsFromTableView } from './schema-builder-field-selection';
import { normalizeCreateSchema } from './schema-builder-normalizer';
import {
  ExistingDestinationTable,
  PlanGeneratorSource,
  generateCreatePlanFromSources,
  inferLogicalFieldType,
} from './schema-builder-plan-generator';
import {
  validateFieldsAgainstCapabilities,
  validateForeignKeyTargetsResolved,
  validateNamesAgainstExisting,
  validateTableForeignKeyTargetsResolved,
  validateTablesAgainstCapabilities,
  zodErrorToValidateIssues,
} from './schema-builder-validator';

const SOURCE = 'SchemaBuilderService';

/**
 * Progress observer for {@link SchemaBuilderService.createTables} (DEV-10875): tables in a batch are
 * created sequentially against the remote service (often seconds each under rate limits), and
 * `onTableResult` fires as EACH table's creation attempt finishes — with that table's Phase 1
 * result — so a caller (the apply-sync-draft save job) can tick a per-table progress bar instead
 * of waiting for the whole batch. Purely a side-channel: the result the callback sees may still be
 * amended by Phase 2 (deferred foreignKey fields can demote it to `partial`), and an exception
 * thrown by the callback is logged and swallowed so an observer bug can never fail — or, worse,
 * duplicate — remote creation work.
 */
export interface CreateTablesProgressOptions {
  onTableResult?: (result: CreateTableResult) => Promise<void> | void;
}

/**
 * The create-schema API (DEV-10378): validate logical table/field specs and (when
 * a connector supports it) create the tables/fields on the remote service, then
 * optionally materialize them as local DataFolders.
 *
 * The execute* methods are deliberately self-contained (no controller-coupled
 * state) so a future BullMQ job handler can wrap them unchanged when schema
 * creation graduates from synchronous to async (decision #8). Airtable, Postgres,
 * and Notion ship `supportsSchemaCreation() === true`, so the create endpoints
 * execute against those services; a connector that doesn't (e.g. Framer) returns
 * a `not_supported` result.
 */
@Injectable()
export class SchemaBuilderService {
  constructor(
    private readonly workbookService: WorkbookService,
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly connectorService: ConnectorsService,
    private readonly dataFolderService: DataFolderService,
    private readonly db: DbService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Dry-run: validate a create-tables body WITHOUT touching the remote service.
   * Returns every issue (structural, intra-request, and connector-capability)
   * rather than throwing, so a client can pre-flight a plan before /tables.
   */
  async validate(workbookId: WorkbookId, body: unknown, actor: Actor): Promise<ValidateSchemaResponse> {
    await this.workbookService.assertWritableWorkbook(actor, workbookId);

    const issues: ValidateSchemaIssue[] = [];
    let serviceName = '';
    let schemaCreationSupported = false;
    let capabilities: SchemaCreationCapabilities | undefined;

    const connectorAccountId = readConnectorAccountId(body);
    if (connectorAccountId) {
      const account = await this.connectorAccountService.findOneById(connectorAccountId, actor).catch(() => null);
      if (!account) {
        issues.push({
          path: 'connectorAccountId',
          code: 'CONNECTOR_ACCOUNT_NOT_FOUND',
          message: 'connector account not found',
        });
      } else if (account.workbookId !== workbookId) {
        issues.push({
          path: 'connectorAccountId',
          code: 'ACCOUNT_NOT_IN_WORKBOOK',
          message: 'connector account does not belong to this workbook',
        });
      } else {
        const connector = await this.getConnectorForAccount(account);
        serviceName = connector.service;
        schemaCreationSupported = connector.supportsSchemaCreation();
        capabilities = connector.getSchemaCreationCapabilities?.();
      }
    }

    const parsed = createSchemaTablesSchema.safeParse(body);
    if (!parsed.success) {
      issues.push(...zodErrorToValidateIssues(parsed.error));
    } else if (capabilities) {
      issues.push(...validateTablesAgainstCapabilities(parsed.data, capabilities));
    }

    return { valid: issues.length === 0, issues, schemaCreationSupported, service: serviceName };
  }

  /** Create one or more tables (with their fields) on the remote service. */
  async createTables(
    workbookId: WorkbookId,
    dto: CreateSchemaTablesDto,
    actor: Actor,
    progressOptions: CreateTablesProgressOptions = {},
  ): Promise<CreateSchemaTablesResponse> {
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);
    const { connector } = await this.resolveConnectorForWorkbook(dto.connectorAccountId, workbookId, actor);

    // A foreignKey still carrying a pending `{ unresolvedLinkedTableId }` target can't
    // be created — it must be bound to a destination first. The zod pipe rejects this
    // at the controller, but the sync-draft materializer calls us directly (bypassing
    // the pipe), so guard here too rather than let an unresolved target reach a connector.
    const unresolvedForeignKeyIssues = validateTableForeignKeyTargetsResolved(dto);
    if (unresolvedForeignKeyIssues.length > 0) {
      WSLogger.error({
        source: SOURCE,
        message: 'create-schema table validation failed: unresolved foreignKey target(s)',
        workbookId,
        connectorAccountId: dto.connectorAccountId,
        service: connector.service,
        issues: unresolvedForeignKeyIssues,
      });
      throw new BadRequestException({ message: 'create-schema validation failed', issues: unresolvedForeignKeyIssues });
    }

    const capabilities = connector.getSchemaCreationCapabilities?.();
    if (capabilities) {
      const issues = validateTablesAgainstCapabilities(dto, capabilities);
      if (issues.length > 0) {
        // The thrown BadRequestException only reaches the client as a per-table
        // "create-schema validation failed" summary; the actionable detail (which
        // field, which capability constraint) lives in `issues` and would otherwise
        // never be observable server-side. Log it before throwing so support can
        // debug from the logs alone.
        WSLogger.error({
          source: SOURCE,
          message: 'create-schema table validation failed against connector capabilities',
          workbookId,
          connectorAccountId: dto.connectorAccountId,
          service: connector.service,
          capabilities,
          tables: dto.tables.map((table, tableIndex) => ({
            index: tableIndex,
            ref: table.ref,
            name: table.name,
            fieldCount: table.fields.length,
          })),
          issues,
        });
        throw new BadRequestException({ message: 'create-schema validation failed', issues });
      }
    }

    if (!connector.supportsSchemaCreation()) {
      return { status: 'not_supported', tables: [], unsupported: this.unsupported(connector) };
    }

    return this.executeCreateTables(connector, dto, workbookId, workbook.organizationId, actor, progressOptions);
  }

  /** Add fields to an existing remote table. */
  async createFields(
    workbookId: WorkbookId,
    dto: CreateSchemaFieldsDto,
    actor: Actor,
  ): Promise<CreateSchemaFieldsResponse> {
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);
    const { connector } = await this.resolveConnectorForWorkbook(dto.connectorAccountId, workbookId, actor);

    const issues: ValidateSchemaIssue[] = [];
    const capabilities = connector.getSchemaCreationCapabilities?.();
    if (capabilities) {
      issues.push(...validateFieldsAgainstCapabilities(dto.fields, capabilities, 'fields'));
    }
    // A pending `{ unresolvedLinkedTableId }` FK target can't be added to an existing
    // table — it must be bound to an existing remote table first (guarded here as well
    // as in the zod pipe, since the sync-draft materializer calls us directly).
    issues.push(...validateForeignKeyTargetsResolved(dto.fields, 'fields'));
    // If the target table is materialized as a local folder, reject names that
    // already exist on it (decision #3). A remote-only table's existing names are
    // checked by the connector pass.
    const existingNames = await this.existingFieldNamesForLocalFolder(
      workbookId,
      dto.connectorAccountId,
      dto.remoteTableId,
      actor,
    );
    if (existingNames) {
      issues.push(
        ...validateNamesAgainstExisting(
          dto.fields.map((field) => field.name),
          existingNames,
          (index) => `fields[${index}].name`,
        ),
      );
    }
    if (issues.length > 0) {
      // See createTables: surface the actionable per-issue detail in the logs, since
      // the client only sees the opaque "create-schema validation failed" summary.
      WSLogger.error({
        source: SOURCE,
        message: 'create-schema field validation failed against connector capabilities / existing names',
        workbookId,
        connectorAccountId: dto.connectorAccountId,
        service: connector.service,
        remoteTableId: dto.remoteTableId,
        fields: dto.fields.map((field, fieldIndex) => ({
          index: fieldIndex,
          name: field.name,
          kind: field.fieldType.kind,
        })),
        issues,
      });
      throw new BadRequestException({ message: 'create-schema validation failed', issues });
    }

    if (!connector.supportsSchemaCreation()) {
      return {
        status: 'not_supported',
        remoteTableId: dto.remoteTableId,
        fields: [],
        unsupported: this.unsupported(connector),
      };
    }

    const createFields = connector.createFields?.bind(connector);
    if (!createFields) {
      return {
        status: 'not_supported',
        remoteTableId: dto.remoteTableId,
        fields: [],
        unsupported: this.unsupported(connector),
      };
    }
    const fieldResults = await createFields({ remoteTableId: dto.remoteTableId, fields: dto.fields });
    const status: CreateSchemaStatus = aggregateFieldStatus(fieldResults);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'create',
      message: `Added ${fieldResults.filter((r) => r.status === 'created').length} field(s) to a ${getServiceDisplayName(connector.service)} table`,
      entityId: workbookId,
      organizationId: workbook.organizationId,
      context: { action: 'schema.create_fields', service: connector.service, remoteTableId: dto.remoteTableId },
    });

    if (dto.refreshLocalSchema) {
      // TODO(DEV-10378 connector pass): re-fetch the table spec and rewrite the
      // local schema.json. Deferred — only meaningful once a real connector
      // executes field creation.
      WSLogger.info({
        source: SOURCE,
        message: 'refreshLocalSchema requested; deferred to connector pass',
        workbookId,
      });
    }

    return { status, remoteTableId: dto.remoteTableId, fields: fieldResults };
  }

  /**
   * Generate an editable create-tables plan from one or more existing source
   * DataFolders, targeting a destination connector. Read-only.
   */
  async generatePlan(
    workbookId: WorkbookId,
    dto: GenerateCreatePlanDto,
    actor: Actor,
  ): Promise<GenerateCreatePlanResponse> {
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    const { connector } = await this.resolveConnectorForWorkbook(dto.destinationConnectorAccountId, workbookId, actor);

    const sources: PlanGeneratorSource[] = [];
    for (const source of dto.sources) {
      const folder = await this.db.client.dataFolder.findUnique({ where: { id: source.dataFolderId } });
      if (!folder) {
        throw new NotFoundException(`Source data folder ${source.dataFolderId} not found`);
      }
      if (folder.workbookId !== workbookId) {
        throw new BadRequestException(`Source data folder ${source.dataFolderId} does not belong to this workbook`);
      }
      const stored = await this.dataFolderService.getStoredSchema(source.dataFolderId as DataFolderId, actor);
      if (!stored) {
        throw new BadRequestException(
          `Source data folder ${source.dataFolderId} has no stored schema to derive a plan from`,
        );
      }

      // Prefer the connector's curated default view: it names the meaningful
      // columns and hides deep system objects, so deeply-nested sources (Notion's
      // `created_by: { object, id }`, etc.) don't explode into duplicate `object`/
      // `id` columns. Fall back to raw schema flattening when no view is stored
      // (e.g. connectors that don't build a default view).
      const storedView = await this.dataFolderService.getStoredView(source.dataFolderId as DataFolderId, actor);
      const { schemaFields, viewTypeByPath } = storedView
        ? selectPlanFieldsFromTableView({
            schema: stored.schema as TSchema,
            view: storedView,
            titlePath: toDotPath(stored.titlePath),
            idPath: typeof stored.idPath === 'string' ? stored.idPath : undefined,
          })
        : { schemaFields: extractSchemaFields(stored.schema as TSchema), viewTypeByPath: undefined };

      // When the source targets an existing destination table, resolve that
      // folder's current fields now so the generator can diff against them.
      const existingDestination = source.existingDestinationDataFolderId
        ? await this.resolveExistingDestinationTable(
            workbookId,
            dto.destinationConnectorAccountId,
            source.existingDestinationDataFolderId,
            actor,
          )
        : undefined;

      sources.push({
        ref: source.dataFolderId,
        dataFolderId: source.dataFolderId,
        tableName: source.newTableName ?? (typeof stored.name === 'string' ? stored.name : folder.name),
        schemaFields,
        primaryFieldPath: toDotPath(stored.titlePath),
        idFieldPath: typeof stored.idPath === 'string' ? stored.idPath : undefined,
        remoteTableIds: linkedTableIdCandidateTokensForRemoteTableId(folder.tableId),
        ...(folder.connectorService
          ? {
              connectorService: folder.connectorService,
              serviceDisplayName: getServiceDisplayName(folder.connectorService),
            }
          : {}),
        ...(viewTypeByPath ? { viewTypeByPath } : {}),
        ...(existingDestination ? { existingDestination } : {}),
      });
    }

    // The destination's primary-field requirement drives the generator's fallback:
    // when a connector mandates a primary field but the source designated none
    // (its title column wasn't recognized), the generator promotes one so the plan
    // is valid out of the box rather than failing create-time validation.
    const destinationCapabilities = connector.getSchemaCreationCapabilities?.();

    // When the plan creates at least one NEW table, fetch the destination's
    // existing table names (scoped to the create parent) so the generator can
    // resolve name conflicts up front instead of failing opaquely at create time.
    // Skipped for a destination that does NOT enforce unique table names within a
    // parent (Notion — a page may hold many databases sharing a title): renaming a
    // brand-new table against those would append spurious ` 2`/` 3` suffixes even
    // though the name is free (DEV-10943). In-plan duplicates are still deduped by
    // the generator regardless, since the create request rejects same-named tables.
    const destinationRequiresUniqueTableNames = destinationCapabilities?.requiresUniqueTableNames ?? true;
    const createsNewTable = sources.some((source) => !source.existingDestination);
    const existingDestinationTableNames =
      createsNewTable && destinationRequiresUniqueTableNames
        ? await this.existingDestinationTableNamesForParent(connector, dto.remoteParentId)
        : [];

    const { tables, fieldPlans, notes, tableNotes } = generateCreatePlanFromSources({
      sources,
      destinationConnectorAccountId: dto.destinationConnectorAccountId,
      destinationConnectorService: connector.service,
      destinationServiceDisplayName: getServiceDisplayName(connector.service),
      linkedTableMappings: dto.linkedTableMappings,
      existingDestinationTableNames,
      destinationReservedFieldNames: destinationCapabilities?.reservedFieldNames,
      ...(destinationCapabilities?.maxTableNameLength !== undefined
        ? { destinationMaxTableNameLength: destinationCapabilities.maxTableNameLength }
        : {}),
      ...(destinationCapabilities?.maxFieldNameLength !== undefined
        ? { destinationMaxFieldNameLength: destinationCapabilities.maxFieldNameLength }
        : {}),
      destinationRequiresPrimaryField: destinationCapabilities?.primaryField != null,
      ...(destinationCapabilities?.primaryField
        ? { destinationPrimaryFieldKinds: destinationCapabilities.primaryField.kinds }
        : {}),
      // Absent ⇒ true: only a destination that explicitly can't hold a two-way link (Postgres/Supabase)
      // drops both sides of a reciprocal N→N pair from a symmetric source (DEV-10753).
      destinationSupportsManyToManyForeignKeys: destinationCapabilities?.supportsManyToManyForeignKeys ?? true,
    });

    // Sync transforms are NOT computed here: in a create plan every mapped
    // destination field is being created, so its real schema (and the transform
    // hints that drive selection) doesn't exist yet. The transform is picked once
    // the field is real — at sync-draft materialize, from the freshly-created
    // table's live schema (see SyncDraftService).

    const plan: CreateSchemaTablesDto = {
      connectorAccountId: dto.destinationConnectorAccountId,
      ...(dto.remoteParentId ? { remoteParentId: dto.remoteParentId } : {}),
      tables,
      materializeLocally: false,
    };

    return {
      plan,
      fieldPlans,
      notes,
      tableNotes,
      prerequisites: schemaCreationPrerequisitesFromCapabilities(destinationCapabilities),
      destinationSupportsCreation: connector.supportsSchemaCreation(),
    };
  }

  /**
   * Flattened schema fields — with their `x-scratch-*` transform hints — for a
   * remote table identified by `remoteTableId`, fetched live from the connector
   * (no local DataFolder required). Used by the sync-draft materialize step to
   * pick sync transforms for freshly-created destination columns, whose real
   * schema only exists once the table has been created.
   */
  async fetchSchemaFieldsForRemoteTable(
    workbookId: WorkbookId,
    connectorAccountId: string,
    remoteTableId: string[],
    actor: Actor,
  ): Promise<SchemaField[]> {
    const { connector } = await this.resolveConnectorForWorkbook(connectorAccountId, workbookId, actor);
    const spec = await connector.fetchJsonTableSpec({ wsId: remoteTableId[0], remoteId: remoteTableId });
    return extractSchemaFields(spec.schema);
  }

  /**
   * The destination connector's schema-creation capabilities (or undefined when the
   * connector can't create schema at all). Exposes the same object the create-plan
   * generator reads, so callers outside plan generation — e.g. the sync-draft FK
   * transformer attach, which needs `supportsManyToManyForeignKeys` to decide whether
   * a foreignKey column is a single scalar or a list — can consult one connector fact
   * without re-implementing connector resolution.
   */
  async getSchemaCreationCapabilitiesForConnectorAccount(
    workbookId: WorkbookId,
    connectorAccountId: string,
    actor: Actor,
  ): Promise<SchemaCreationCapabilities | undefined> {
    const { connector } = await this.resolveConnectorForWorkbook(connectorAccountId, workbookId, actor);
    return connector.getSchemaCreationCapabilities?.();
  }

  /**
   * Display names of tables that already exist on the destination connection,
   * scoped to the create parent (`remoteParentId`) so we only flag genuine
   * collisions — e.g. tables in the SAME Airtable base / Postgres schema /
   * Supabase (project, schema) / Webflow site, not every table the account can
   * see. The parent is a prefix of `TablePreview.id.remoteId`: single-segment for
   * connectors whose parent is one container (`[base]` / `[schema]`, matching
   * `remoteId[0]`), multi-segment for connectors whose parent nests (Supabase's
   * `[projectRef, schema]`, matching `remoteId[0..1]`). Every segment of the
   * parent must equal the table's remoteId at that position; when no parent is
   * given, every table is considered.
   *
   * Degrades gracefully: if listing fails we log and return `[]` so plan
   * generation still succeeds (in-plan duplicates are still resolved) — we simply
   * can't check the new name against the remote service.
   */
  private async existingDestinationTableNamesForParent(
    connector: Connector,
    remoteParentId: string[] | undefined,
  ): Promise<string[]> {
    let tables: Awaited<ReturnType<Connector['listTables']>>;
    try {
      tables = await connector.listTables();
    } catch (error) {
      WSLogger.warn({
        source: SOURCE,
        message: 'Could not list destination tables for create-plan conflict detection; skipping',
        error: errorMessage(error),
      });
      return [];
    }
    const scopedTables =
      remoteParentId === undefined || remoteParentId.length === 0
        ? tables
        : tables.filter((table) => remoteParentId.every((segment, index) => table.id.remoteId[index] === segment));
    return scopedTables.map((table) => table.displayName);
  }

  /**
   * Resolve an existing, materialized destination folder for an add-fields plan:
   * assert it belongs to this workbook and the destination connector, then read
   * its stored schema and derive its current fields — name (on the SAME basis the
   * plan generator names fields, `displayLabel ?? lastPathSegment`, so the diff
   * matches), column path, and inferred kind (so a same-named, same-kind field can
   * be adopted rather than recreated). Fails fast rather than silently treating a
   * bad target as "no existing fields" (which would re-create every field and
   * collide remotely).
   */
  private async resolveExistingDestinationTable(
    workbookId: WorkbookId,
    destinationConnectorAccountId: string,
    destinationDataFolderId: string,
    actor: Actor,
  ): Promise<ExistingDestinationTable> {
    const folder = await this.db.client.dataFolder.findUnique({ where: { id: destinationDataFolderId } });
    if (!folder) {
      throw new BadRequestException(`Existing destination data folder ${destinationDataFolderId} not found`);
    }
    if (folder.workbookId !== workbookId) {
      throw new BadRequestException(
        `Existing destination data folder ${destinationDataFolderId} does not belong to this workbook`,
      );
    }
    if (folder.connectorAccountId !== destinationConnectorAccountId) {
      throw new BadRequestException(
        `Existing destination data folder ${destinationDataFolderId} does not belong to the destination connector`,
      );
    }
    const stored = await this.dataFolderService.getStoredSchema(destinationDataFolderId as DataFolderId, actor);
    if (!stored) {
      throw new BadRequestException(
        `Existing destination data folder ${destinationDataFolderId} has no stored schema to diff against`,
      );
    }
    const existingFields = extractSchemaFields(stored.schema as TSchema).map((field) => ({
      name: field.displayLabel ?? lastPathSegment(field.path),
      columnPath: field.path,
      kind: inferLogicalFieldType(field).fieldType.kind,
    }));
    return { dataFolderId: destinationDataFolderId, remoteTableId: folder.tableId, existingFields };
  }

  // ── execution core (BullMQ-wrappable) ──────────────────────────────────────

  private async executeCreateTables(
    connector: Connector,
    dto: CreateSchemaTablesDto,
    workbookId: WorkbookId,
    organizationId: string,
    actor: Actor,
    progressOptions: CreateTablesProgressOptions = {},
  ): Promise<CreateSchemaTablesResponse> {
    const plan = normalizeCreateSchema(dto);
    const refToRemoteTableId = new Map<string, string[]>();
    const results: CreateTableResult[] = [];

    // Best-effort progress side-channel — see {@link CreateTablesProgressOptions}. An observer
    // throw must never fail (or, on retry, duplicate) creation work that already landed remotely.
    const notifyTableResultObserver = async (result: CreateTableResult) => {
      if (!progressOptions.onTableResult) return;
      try {
        await progressOptions.onTableResult(result);
      } catch (error) {
        WSLogger.warn({
          source: SOURCE,
          message: 'createTables progress observer threw; continuing table creation',
          workbookId,
          tableRef: result.ref,
          error: errorMessage(error),
        });
      }
    };

    const createTable = connector.createTable?.bind(connector);
    if (!createTable) {
      return { status: 'not_supported', tables: [], unsupported: this.unsupported(connector) };
    }

    // Phase 1: create each table (and its non-deferred fields) in dependency order.
    for (const tablePlan of plan.tablesInCreationOrder) {
      let tableResult: CreateTableResult;
      try {
        const resolvedPlan: NormalizedCreateTablePlan = {
          ...tablePlan,
          fields: tablePlan.fields.map((field) => this.resolveForeignKeyRefs(field, refToRemoteTableId)),
        };
        tableResult = await createTable(resolvedPlan);
        if (tableResult.remoteTableId) {
          refToRemoteTableId.set(tablePlan.ref, tableResult.remoteTableId);
        }
        results.push(tableResult);
      } catch (error) {
        tableResult = {
          ref: tablePlan.ref,
          name: tablePlan.name,
          status: 'failed',
          fields: [],
          error: errorMessage(error),
        };
        results.push(tableResult);
      }
      await notifyTableResultObserver(tableResult);
    }

    // Phase 2: add deferred (cyclic / self-referential) foreignKey fields now that
    // every table exists.
    const createFields = connector.createFields?.bind(connector);
    for (const tablePlan of plan.tablesInCreationOrder) {
      if (tablePlan.deferredFkFields.length === 0) continue;
      const result = results.find((candidate) => candidate.ref === tablePlan.ref);
      const remoteTableId = refToRemoteTableId.get(tablePlan.ref);
      if (!result || result.status === 'failed' || !remoteTableId || !createFields) continue;
      try {
        const resolvedFields = tablePlan.deferredFkFields.map((field) =>
          this.resolveForeignKeyRefs(field, refToRemoteTableId),
        );
        const fieldResults = await createFields({ remoteTableId, fields: resolvedFields });
        result.fields = [...result.fields, ...fieldResults];
        if (fieldResults.some((fieldResult) => fieldResult.status === 'failed')) {
          result.status = 'partial';
        }
      } catch (error) {
        result.status = 'partial';
        result.error = result.error ?? errorMessage(error);
      }
    }

    // Phase 3: optionally materialize each created table as a local DataFolder.
    if (dto.materializeLocally) {
      for (const result of results) {
        if (result.status === 'failed' || !result.remoteTableId) continue;
        try {
          const folderDto: ValidatedCreateDataFolderDto = {
            name: result.name,
            workbookId,
            connectorAccountId: dto.connectorAccountId,
            tableId: result.remoteTableId,
            parentFolderId: dto.parentFolderId,
          };
          const folder = await this.dataFolderService.createFolder(folderDto, actor, createRunContext('web'));
          result.dataFolderId = folder.id;
        } catch (error) {
          // The remote table genuinely exists; surface a folder-level warning
          // rather than implying a rollback (decision #6).
          result.materializeError = errorMessage(error);
        }
      }
    }

    const createdCount = results.filter((result) => result.status !== 'failed').length;
    if (createdCount > 0) {
      await this.auditLogService.logEvent({
        actor,
        eventType: 'create',
        message: `Created ${createdCount} ${getServiceDisplayName(connector.service)} table(s) via create-schema`,
        entityId: workbookId,
        organizationId,
        context: {
          action: 'schema.create_tables',
          service: connector.service,
          tables: results.map((result) => ({ ref: result.ref, name: result.name, status: result.status })),
        },
      });
    }

    return { status: aggregateTableStatus(results), tables: results };
  }

  /** Replace an in-request `{ ref }` foreignKey target with the created sibling's remote id. */
  private resolveForeignKeyRefs(field: CreateFieldSpec, refToRemoteTableId: Map<string, string[]>): CreateFieldSpec {
    const fieldType = field.fieldType;
    if (fieldType.kind === 'foreignKey' && 'ref' in fieldType.target) {
      const remoteTableId = refToRemoteTableId.get(fieldType.target.ref);
      if (remoteTableId) {
        return { ...field, fieldType: { ...fieldType, target: { existingRemoteTableId: remoteTableId } } };
      }
    }
    return field;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async resolveConnectorForWorkbook(
    connectorAccountId: string,
    workbookId: WorkbookId,
    actor: Actor,
  ): Promise<{ connector: Connector; account: ConnectorAccount }> {
    const account = await this.connectorAccountService.findOneById(connectorAccountId, actor);
    if (!account) {
      throw new NotFoundException('Connector account not found');
    }
    if (account.workbookId !== workbookId) {
      throw new BadRequestException('Connector account does not belong to this workbook');
    }
    const connector = await this.getConnectorForAccount(account);
    return { connector, account };
  }

  private async getConnectorForAccount(account: ConnectorAccount & DecryptedCredentials): Promise<Connector> {
    return this.connectorService.getConnector({
      service: account.service,
      connectorAccount: account as ConnectorAccount,
      decryptedCredentials: account as unknown as DecryptedCredentials,
    });
  }

  /**
   * Field names on a local folder backing the given remote table, or null if no
   * such folder exists (the remote-only existing-name check is the connector
   * pass's responsibility).
   */
  private async existingFieldNamesForLocalFolder(
    workbookId: WorkbookId,
    connectorAccountId: string,
    remoteTableId: string[],
    actor: Actor,
  ): Promise<string[] | null> {
    const folder = await this.db.client.dataFolder.findFirst({
      where: { workbookId, connectorAccountId, tableId: { equals: remoteTableId } },
    });
    if (!folder) return null;
    const stored = await this.dataFolderService.getStoredSchema(folder.id as DataFolderId, actor);
    if (!stored) return null;
    return extractSchemaFields(stored.schema as TSchema).map((field) => lastPathSegment(field.path));
  }

  private unsupported(connector: Connector): { service: string; message: string } {
    return {
      service: connector.service,
      message: `Schema creation is not yet supported for ${getServiceDisplayName(connector.service)}.`,
    };
  }
}

function readConnectorAccountId(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'connectorAccountId' in body) {
    const value = (body as { connectorAccountId?: unknown }).connectorAccountId;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function toDotPath(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.filter((segment) => typeof segment === 'string').join('.');
  if (typeof value === 'string') return value;
  return undefined;
}

function lastPathSegment(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] || path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Project the connector's full SchemaCreationCapabilities down to the subset the
 * client needs to bring a plan into compliance before creating it. The connector's
 * `primaryField` requirement (or `null`) carries straight through, so a connector
 * that declares no capabilities or no primary field yields `{ primaryField: null }`
 * and the client can treat the object uniformly.
 */
function schemaCreationPrerequisitesFromCapabilities(
  capabilities: SchemaCreationCapabilities | undefined,
): CreateSchemaPrerequisites {
  return { primaryField: capabilities?.primaryField ?? null };
}

function aggregateTableStatus(results: CreateTableResult[]): CreateSchemaStatus {
  if (results.length === 0) return 'failed';
  const anyCreated = results.some((result) => result.status !== 'failed');
  const anyIncomplete = results.some((result) => result.status === 'failed' || result.status === 'partial');
  if (!anyCreated) return 'failed';
  return anyIncomplete ? 'partial' : 'ok';
}

function aggregateFieldStatus(results: { status: string }[]): CreateSchemaStatus {
  if (results.length === 0) return 'failed';
  const anyCreated = results.some((result) => result.status === 'created');
  const anyFailed = results.some((result) => result.status === 'failed');
  if (!anyCreated) return 'failed';
  return anyFailed ? 'partial' : 'ok';
}
