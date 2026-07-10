import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, SyncDraft as PrismaSyncDraft } from '@prisma/client';
import {
  type CreateFieldSpec,
  type CreateSchemaFieldsDto,
  type CreateSchemaTablesDto,
  createSyncDraftId,
  type CreateTableSpec,
  type DataFolderId,
  type DraftColumnDestination,
  type DraftColumnMapping,
  type DraftFieldAddition,
  type DraftTableDestination,
  type DraftTableMapping,
  type ForeignKeyTarget,
  type MaterializePlaceholderResult,
  type MaterializeResponse,
  pickMappingTransformers,
  type SaveSyncBody,
  ScheduleAction,
  type Sync,
  type SyncDraft,
  type SyncDraftId,
  type SyncDraftMissingForeignKeyTarget,
  type SyncId,
  type SyncMapping,
  SyncState,
  type SyncTablePairId,
  type TableMappingV2,
  type TableView,
  type TableViewCol,
  type TransformerConfig,
  TransformerTypes,
  transformV1ToV2,
  type ValidateSchemaIssue,
  type WorkbookId,
} from '@spinner/shared-types';
import { WorkbookCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { buildSyncRoutineFile } from 'src/routine/routine-generator';
import { RoutineService } from 'src/routine/routine.service';
import { SchemaBuilderService } from 'src/schema-builder/schema-builder.service';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import { extractSchemaFields, SchemaField } from 'src/utils/schema-helpers';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { CreateSyncDraftDtoClass, PatchSyncDraftDtoClass } from './dto/sync-draft.dto';
import { SyncDraftEntity } from './entities/sync-draft.entity';

/** The placeholder-table variant of a draft table destination (carries the create plan + resolution). */
type PlaceholderTableDestination = Extract<DraftTableDestination, { kind: 'placeholderTable' }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DraftForeignKeyReference {
  /** The `ref` of the table mapping that holds the foreignKey field. */
  tableMappingRef: string;
  fieldName: string;
  target: ForeignKeyTarget;
}

/** Find a view column (including inside banner groups) by its JSON path. */
function findViewColumnByPath(view: TableView, path: string): TableViewCol | undefined {
  for (const entry of view.cols) {
    if (entry.kind === 'banner-group') {
      const found = entry.cols.find((col) => col.path === path);
      if (found) return found;
    } else if (entry.path === path) {
      return entry;
    }
  }
  return undefined;
}

/** Every foreignKey field across a draft's placeholder create-specs and field additions. */
function collectDraftForeignKeyReferences(tableMappings: DraftTableMapping[]): DraftForeignKeyReference[] {
  const references: DraftForeignKeyReference[] = [];
  for (const tableMapping of tableMappings) {
    if (tableMapping.destination.kind === 'placeholderTable') {
      for (const field of tableMapping.destination.createSpec.fields) {
        if (field.fieldType.kind === 'foreignKey') {
          references.push({ tableMappingRef: tableMapping.ref, fieldName: field.name, target: field.fieldType.target });
        }
      }
    }
    for (const addition of tableMapping.fieldAdditions ?? []) {
      const fieldType = addition.createFieldSpec.fieldType;
      if (fieldType.kind === 'foreignKey') {
        references.push({
          tableMappingRef: tableMapping.ref,
          fieldName: addition.createFieldSpec.name,
          target: fieldType.target,
        });
      }
    }
  }
  return references;
}

/**
 * Replace a field's pending `{ unresolvedLinkedTableId }` foreignKey target with the
 * destination target it resolves to within the draft (see
 * {@link SyncDraftService.buildForeignKeyResolutionMap}). A target with no entry in
 * the map is left pending — create then rejects it, surfacing the unmet requirement
 * instead of dropping the column. Non-foreignKey / already-bound fields pass through.
 */
function resolveFieldForeignKeyTarget(
  field: CreateFieldSpec,
  resolutionBySourceRemoteTableId: Map<string, ForeignKeyTarget>,
): CreateFieldSpec {
  const fieldType = field.fieldType;
  if (fieldType.kind !== 'foreignKey' || !('unresolvedLinkedTableId' in fieldType.target)) {
    return field;
  }
  const resolvedTarget = resolutionBySourceRemoteTableId.get(fieldType.target.unresolvedLinkedTableId);
  return resolvedTarget ? { ...field, fieldType: { ...fieldType, target: resolvedTarget } } : field;
}

/** Resolve every pending foreignKey target across a create-table spec's fields. */
function resolveCreateSpecForeignKeyTargets(
  createSpec: CreateTableSpec,
  resolutionBySourceRemoteTableId: Map<string, ForeignKeyTarget>,
): CreateTableSpec {
  return {
    ...createSpec,
    fields: createSpec.fields.map((field) => resolveFieldForeignKeyTarget(field, resolutionBySourceRemoteTableId)),
  };
}

/**
 * A user-facing message for an error thrown by the schema-builder create
 * endpoints. Those throw a `BadRequestException` carrying a structured `issues`
 * array (the actual per-field reasons, e.g. `a field named "Country" already
 * exists on the target table`); the generic `.message` ("create-schema validation
 * failed") is useless on its own, so surface the issue messages when present.
 */
function schemaCreationErrorMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null) {
      const issues = (response as { issues?: unknown }).issues;
      if (Array.isArray(issues) && issues.length > 0) {
        const messages = (issues as ValidateSchemaIssue[]).map((issue) => issue.message).filter(Boolean);
        if (messages.length > 0) return messages.join('; ');
      }
    }
  }
  return errorMessage(error);
}

/** Resolves the non-null connector account ids for a set of folder ids (scratch folders → null → dropped). */
function collectConnectorAccountIds(
  folderIds: string[],
  connectorAccountIdByFolderId: Map<string, string | null>,
): string[] {
  return folderIds
    .map((folderId) => connectorAccountIdByFolderId.get(folderId) ?? null)
    .filter((connectorAccountId): connectorAccountId is string => connectorAccountId !== null);
}

@Injectable()
export class SyncDraftService {
  constructor(
    private readonly db: DbService,
    private readonly workbookService: WorkbookService,
    private readonly syncService: SyncService,
    private readonly schemaBuilderService: SchemaBuilderService,
    private readonly dataFolderService: DataFolderService,
    private readonly routineService: RoutineService,
  ) {}

  /**
   * Opens the editor for a target, identified by a **durable key the caller
   * already has** — the workbook (new bridge) or the sync being edited
   * (`fromSyncId`). Get-or-create keyed by `(workbookId, sourceSyncId ?? null)`
   * over *active* (non-archived) drafts: returns the existing active draft for
   * that target if one exists, otherwise creates one (blank, or initialized from
   * the existing sync). This is the cold-load "open" call — the client never has
   * to persist or rediscover the draft id.
   *
   * Race-safety: a transaction-scoped Postgres advisory lock keyed by the target
   * serializes concurrent opens, so two browser tabs converge on a single draft
   * instead of creating duplicates (PATCH `version` then arbitrates their edits).
   * Every draft is created through here, so this one guard is sufficient — we
   * deliberately avoid a partial unique index (Prisma can't represent
   * `WHERE archivedAt IS NULL` / `COALESCE`, so it would drift on `migrate dev`).
   */
  async getOrCreate(workbookId: WorkbookId, dto: CreateSyncDraftDtoClass, actor: Actor): Promise<SyncDraft> {
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    const sourceSyncId: SyncId | null = dto.fromSyncId ? (dto.fromSyncId as SyncId) : null;

    const row = await this.db.client.$transaction(async (tx) => {
      // Transaction-scoped lock (auto-released on commit/rollback), keyed by the
      // open target. Concurrent opens for the same target queue behind it.
      const lockKey = `sync-draft:${workbookId}:${sourceSyncId ?? ''}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

      const existing = await tx.syncDraft.findFirst({
        where: { workbookId, sourceSyncId, archivedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (existing) return existing;

      // Only resolve the source sync (and pay that read) when actually creating.
      const initialized = sourceSyncId
        ? await this.initializeFromExistingSync(workbookId, sourceSyncId)
        : {
            displayName: 'Untitled sync',
            schedule: null as string | null,
            publishAfterSync: false,
            tableMappings: [] as DraftTableMapping[],
          };

      return tx.syncDraft.create({
        data: {
          id: createSyncDraftId(),
          workbookId,
          version: 1,
          displayName: initialized.displayName,
          schedule: initialized.schedule,
          publishAfterSync: initialized.publishAfterSync,
          sourceSyncId,
          tableMappings: initialized.tableMappings as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return SyncDraftEntity.from(row);
  }

  async get(draftId: SyncDraftId, actor: Actor): Promise<SyncDraft> {
    const row = await this.loadDraftOrThrow(draftId);
    await this.workbookService.assertReadableWorkbook(actor, row.workbookId as WorkbookId);
    return SyncDraftEntity.from(row);
  }

  /**
   * Replace-merges the draft's editable contents. Optimistic concurrency: the
   * update is conditional on the supplied `version`; a mismatch (or an archived
   * draft) is a 409 so the client refetches + reconciles rather than clobbering.
   */
  async patch(draftId: SyncDraftId, dto: PatchSyncDraftDtoClass, actor: Actor): Promise<SyncDraft> {
    const row = await this.loadDraftOrThrow(draftId);
    await this.workbookService.assertWritableWorkbook(actor, row.workbookId as WorkbookId);

    if (row.archivedAt) {
      throw new ConflictException({
        error: 'SYNC_DRAFT_ARCHIVED',
        message: `Sync draft ${draftId} has been applied and can no longer be edited.`,
      });
    }

    // Reject a save that would strand a foreignKey field on a table no longer in the
    // draft (e.g. the user removed the table another table's FK points at) — forcing
    // the reference to be unmapped before it can dangle into materialize.
    if (dto.tableMappings !== undefined) {
      await this.validateForeignKeyTargetsSatisfiable(dto.tableMappings);
    }

    const data: Prisma.SyncDraftUpdateInput = { version: { increment: 1 } };
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.schedule !== undefined) data.schedule = dto.schedule;
    if (dto.publishAfterSync !== undefined) data.publishAfterSync = dto.publishAfterSync;
    if (dto.tableMappings !== undefined) {
      data.tableMappings = dto.tableMappings as unknown as Prisma.InputJsonValue;
    }

    // Conditional update is the atomic concurrency guard — 0 rows means the
    // version moved under us (or the row vanished).
    const result = await this.db.client.syncDraft.updateMany({
      where: { id: draftId, version: dto.version },
      data,
    });
    if (result.count === 0) {
      const current = await this.loadDraftOrThrow(draftId);
      throw new ConflictException({
        error: 'SYNC_DRAFT_VERSION_CONFLICT',
        message: `Sync draft ${draftId} was modified concurrently. Refetch and retry.`,
        currentVersion: current.version,
      });
    }

    const updated = await this.loadDraftOrThrow(draftId);
    return SyncDraftEntity.from(updated);
  }

  async delete(draftId: SyncDraftId, actor: Actor): Promise<void> {
    const row = await this.loadDraftOrThrow(draftId);
    await this.workbookService.assertWritableWorkbook(actor, row.workbookId as WorkbookId);
    await this.db.client.syncDraft.delete({ where: { id: draftId } });
  }

  /**
   * Phase 1 (materialize) — creates the still-unresolved remote tables/fields and
   * checkpoints each success back into the stored draft per `ref` the instant it
   * lands. Best-effort and re-callable: only unresolved placeholders are
   * attempted, so a retry never re-creates what already succeeded (the resume
   * primitive). A lost response leaves an orphan remote table (litter), never a
   * mapping pointing at one.
   */
  async materialize(draftId: SyncDraftId, actor: Actor): Promise<MaterializeResponse> {
    const row = await this.loadDraftOrThrow(draftId);
    const workbookId = row.workbookId as WorkbookId;
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    if (row.archivedAt) {
      throw new ConflictException({
        error: 'SYNC_DRAFT_ARCHIVED',
        message: `Sync draft ${draftId} has been applied and can no longer be materialized.`,
      });
    }

    const tableMappings = SyncDraftEntity.from(row).tableMappings;
    const results: MaterializePlaceholderResult[] = [];

    await this.materializePlaceholderTables(workbookId, draftId, tableMappings, results, actor);
    await this.materializeFieldAdditions(workbookId, draftId, tableMappings, results, actor);
    // Give every foreignKey column whose related table is ALSO synced here the pipeline
    // that resolves source FK ids → destination linked-record ids. Runs BEFORE the generic
    // picker so those columns end up with the FK pipeline (the picker then skips them).
    await this.attachForeignKeyResolutionTransformers(draftId, tableMappings, actor);
    // Now the destination fields are real: pick the sync transform for each remaining
    // newly-created column from its actual schema hints and write it to the draft.
    await this.attachTransformersToMaterializedColumns(workbookId, draftId, tableMappings, actor);

    const fresh = await this.loadDraftOrThrow(draftId);
    return { draft: SyncDraftEntity.from(fresh), results, status: aggregateMaterializeStatus(results) };
  }

  /**
   * Phase 2 (apply) — reconciles the placeholder-free draft into a live Sync in
   * our system. Refuses (422) if any placeholder is still unresolved. Creates
   * destination data folders for materialized tables, resolves field refs → real
   * column path ids by name from the destination schema, builds the native v2
   * mapping, and create-or-updates the sync (diffing against `sourceSyncId`).
   * Archives the draft afterward (kept for debugging).
   */
  async apply(draftId: SyncDraftId, actor: Actor, options: { createRoutine?: boolean } = {}): Promise<Sync> {
    const row = await this.loadDraftOrThrow(draftId);
    const workbookId = row.workbookId as WorkbookId;
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);
    if (row.archivedAt) {
      throw new ConflictException({
        error: 'SYNC_DRAFT_ARCHIVED',
        message: `Sync draft ${draftId} has already been applied.`,
      });
    }

    const draft = SyncDraftEntity.from(row);
    const tableMappings = draft.tableMappings;

    const unresolvedRefs = collectUnresolvedPlaceholderRefs(tableMappings);
    if (unresolvedRefs.length > 0) {
      throw new UnprocessableEntityException({
        error: 'SYNC_DRAFT_UNRESOLVED_PLACEHOLDERS',
        message: `Sync draft ${draftId} has unresolved placeholders; run materialize first.`,
        unresolvedRefs,
      });
    }

    // Create destination data folders for materialized placeholder tables. Done
    // before the sync save and checkpointed per folder so a crash mid-apply
    // leaves orphan folders (litter), not duplicate folders on retry.
    for (const tableMapping of tableMappings) {
      if (tableMapping.destination.kind !== 'placeholderTable') continue;
      const destination = tableMapping.destination;
      const resolved = destination.resolved;
      if (!resolved?.remoteTableId) continue; // guarded by the precondition above
      if (resolved.dataFolderId) continue; // already created on a prior attempt
      const folder = await this.dataFolderService.createFolder(
        {
          name: resolved.actualName ?? destination.createSpec.name,
          workbookId,
          connectorAccountId: destination.connectorAccountId,
          tableId: resolved.remoteTableId,
        },
        actor,
        createRunContext('web'),
      );
      resolved.dataFolderId = folder.id;
      await this.persistTableMappings(draftId, tableMappings);
    }

    // Build the native v2 mapping, resolving placeholder field refs → real column
    // path ids by name against each destination folder's (live) schema.
    const schemaFieldsByFolderId = new Map<string, SchemaField[]>();
    const v2TableMappings: TableMappingV2[] = [];
    for (const tableMapping of tableMappings) {
      const destinationDataFolderId = this.destinationFolderId(tableMapping.destination);
      const columnMappings = [];
      for (const columnMapping of tableMapping.columnMappings) {
        const destinationColumnId = await this.resolveColumnDestination(
          columnMapping.destination,
          tableMapping,
          destinationDataFolderId,
          schemaFieldsByFolderId,
          actor,
        );
        columnMappings.push({
          destinationColumnId,
          source: {
            kind: 'column' as const,
            columnId: columnMapping.source.columnId,
            // Carry the create-plan's transformer pipeline (e.g. wrapping a string
            // into Notion's rich_text envelope) verbatim onto the sync mapping.
            ...(columnMapping.transformers && columnMapping.transformers.length > 0
              ? { transformers: columnMapping.transformers }
              : {}),
          },
        });
      }
      const recordMatching = tableMapping.recordMatching
        ? {
            sourceColumnId: tableMapping.recordMatching.source.columnId,
            destinationColumnId: await this.resolveColumnDestination(
              tableMapping.recordMatching.destination,
              tableMapping,
              destinationDataFolderId,
              schemaFieldsByFolderId,
              actor,
            ),
          }
        : undefined;

      v2TableMappings.push({
        sourceDataFolderId: tableMapping.source.dataFolderId as DataFolderId,
        destinationDataFolderId: destinationDataFolderId as DataFolderId,
        columnMappings,
        ...(recordMatching ? { recordMatching } : {}),
        // Carry the unmatched-record policies (incl. withMatchKey: 'delete') verbatim
        // onto the sync. Omitted-on-draft → omitted-on-sync → today's default behavior.
        ...(tableMapping.unmatchedSourcePolicy ? { unmatchedSourcePolicy: tableMapping.unmatchedSourcePolicy } : {}),
        ...(tableMapping.unmatchedDestinationPolicy
          ? { unmatchedDestinationPolicy: tableMapping.unmatchedDestinationPolicy }
          : {}),
      });
    }

    const body: SaveSyncBody = {
      displayName: draft.displayName,
      mappings: { version: 2, tableMappings: v2TableMappings },
      validateMappings: true,
      schedule: draft.schedule ?? '',
      publishAfterSync: draft.publishAfterSync,
    };

    let syncId: SyncId;
    if (draft.sourceSyncId) {
      await this.syncService.updateSync(workbookId, draft.sourceSyncId, body, actor);
      syncId = draft.sourceSyncId;
    } else {
      const created = await this.syncService.createSync(workbookId, body, actor);
      syncId = (created as { id: SyncId }).id;
    }

    // Archive (don't delete) — keep the draft for debugging.
    await this.db.client.syncDraft.update({
      where: { id: draftId },
      data: {
        archivedAt: new Date(),
        appliedSyncId: syncId,
        tableMappings: tableMappings as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });

    if (options.createRoutine) {
      await this.tryCreateSyncRoutine(workbook, syncId, draft.displayName, v2TableMappings, actor);
    }

    return this.buildSharedSync(syncId);
  }

  /**
   * Best-effort: writes a `routines/run-<syncId>.yaml` file describing how to run the just-created
   * sync, then records its path on the workbook (`settings.sync_routine`). Resolves the source/
   * destination connections from the v2 mapping's folder ids (a Sync doesn't store connections;
   * `DataFolder.connectorAccountId` does — null for scratch folders, which contribute no pull/publish
   * steps). NEVER throws: apply has already created the sync and archived the draft (one-shot — a
   * re-apply throws SYNC_DRAFT_ARCHIVED), so a routine failure is logged and swallowed rather than
   * failing the whole apply. The settings write runs only after the routine file commits, so a failed
   * routine never records a dangling path.
   */
  private async tryCreateSyncRoutine(
    workbook: WorkbookCluster.Workbook,
    syncId: SyncId,
    syncDisplayName: string,
    v2TableMappings: TableMappingV2[],
    actor: Actor,
  ): Promise<void> {
    const workbookId = workbook.id as WorkbookId;
    try {
      const sourceDataFolderIds = [...new Set(v2TableMappings.map((tableMapping) => tableMapping.sourceDataFolderId))];
      const destinationDataFolderIds = [
        ...new Set(v2TableMappings.map((tableMapping) => tableMapping.destinationDataFolderId)),
      ];

      const folders = await this.db.client.dataFolder.findMany({
        where: { id: { in: [...sourceDataFolderIds, ...destinationDataFolderIds] } },
        select: { id: true, connectorAccountId: true },
      });
      const connectorAccountIdByFolderId = new Map(folders.map((folder) => [folder.id, folder.connectorAccountId]));

      const file = buildSyncRoutineFile({
        syncDisplayName,
        syncId,
        sourceConnectorAccountIds: collectConnectorAccountIds(sourceDataFolderIds, connectorAccountIdByFolderId),
        destinationConnectorAccountIds: collectConnectorAccountIds(
          destinationDataFolderIds,
          connectorAccountIdByFolderId,
        ),
      });

      await this.routineService.createRoutineFile(workbookId, file, actor);
      // Record the routine path on the workbook so other surfaces can find this sync's routine.
      await this.workbookService.updateWorkbookSettings(workbook, { updates: { sync_routine: file.path } });
    } catch (error) {
      WSLogger.warn({
        source: 'SyncDraftService.apply',
        message: `Sync ${syncId} created, but routine generation failed: ${errorMessage(error)}`,
        workbookId,
        syncId,
      });
    }
  }

  // ── materialize internals ────────────────────────────────────────────────────

  private async materializePlaceholderTables(
    workbookId: WorkbookId,
    draftId: SyncDraftId,
    tableMappings: DraftTableMapping[],
    results: MaterializePlaceholderResult[],
    actor: Actor,
  ): Promise<void> {
    // Resolve any pending `{ unresolvedLinkedTableId }` foreignKey targets the plan
    // generator left on these placeholders, binding each to the destination chosen
    // for that source table within this draft (a sibling placeholder → `{ ref }`, or
    // an existing destination table → `{ existingRemoteTableId }`). Targets that still
    // can't be bound stay pending and are rejected by createTables below, so the
    // requirement surfaces rather than the foreign key being silently dropped.
    const foreignKeyResolutionMap = await this.buildForeignKeyResolutionMap(tableMappings, {
      resolvePlaceholdersToRemoteId: false,
    });

    // Group unresolved placeholder tables by (connectorAccountId, remoteParentId)
    // so each createTables call is one batch against one destination base.
    const groups = new Map<
      string,
      { connectorAccountId: string; remoteParentId?: string[]; placeholders: PlaceholderTableDestination[] }
    >();
    for (const tableMapping of tableMappings) {
      if (tableMapping.destination.kind !== 'placeholderTable') continue;
      const destination = tableMapping.destination;
      if (destination.resolved?.remoteTableId) {
        results.push({
          ref: destination.ref,
          kind: 'table',
          status: 'alreadyResolved',
          actualName: destination.resolved.actualName,
          remoteTableId: destination.resolved.remoteTableId,
        });
        continue;
      }
      const key = `${destination.connectorAccountId}::${JSON.stringify(destination.remoteParentId ?? [])}`;
      const group = groups.get(key) ?? {
        connectorAccountId: destination.connectorAccountId,
        remoteParentId: destination.remoteParentId,
        placeholders: [],
      };
      group.placeholders.push(destination);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      try {
        const dto: CreateSchemaTablesDto = {
          connectorAccountId: group.connectorAccountId,
          ...(group.remoteParentId ? { remoteParentId: group.remoteParentId } : {}),
          tables: group.placeholders.map((placeholder) =>
            resolveCreateSpecForeignKeyTargets(placeholder.createSpec, foreignKeyResolutionMap),
          ),
          materializeLocally: false,
        };
        const response = await this.schemaBuilderService.createTables(workbookId, dto, actor);
        for (const placeholder of group.placeholders) {
          const tableResult = response.tables.find((table) => table.ref === placeholder.createSpec.ref);
          if (tableResult && tableResult.status !== 'failed' && tableResult.remoteTableId) {
            placeholder.resolved = { remoteTableId: tableResult.remoteTableId, actualName: tableResult.name };
            results.push({
              ref: placeholder.ref,
              kind: 'table',
              status: 'created',
              actualName: tableResult.name,
              remoteTableId: tableResult.remoteTableId,
            });
          } else {
            results.push({
              ref: placeholder.ref,
              kind: 'table',
              status: 'failed',
              error: tableResult?.error ?? response.unsupported?.message ?? 'Table creation failed',
            });
          }
        }
        // Checkpoint the whole batch's successes the instant they land.
        await this.persistTableMappings(draftId, tableMappings);
      } catch (error) {
        for (const placeholder of group.placeholders) {
          results.push({
            ref: placeholder.ref,
            kind: 'table',
            status: 'failed',
            error: schemaCreationErrorMessage(error),
          });
        }
      }
    }
  }

  /**
   * Map each source table's remote id → the create-side foreignKey target the
   * destination chosen for it (within this draft) resolves to. The plan generator
   * emits an unbound foreignKey as `{ unresolvedLinkedTableId: <source remote id> }`,
   * and this binds it against the source→destination mapping the draft already
   * carries. A source whose destination supplies no target is simply absent from the
   * map, leaving its foreignKey pending so create rejects it (surfacing, not dropping).
   *
   * The binding differs by phase (`resolvePlaceholdersToRemoteId`):
   *  - new-tables phase (false): a sibling placeholder binds to `{ ref }` — both
   *    tables are created in the same createTables batch, where the ref resolves.
   *  - add-fields phase (true): the sibling placeholder has ALREADY been created, so
   *    it binds to its real `{ existingRemoteTableId }` (the /schema/fields endpoint
   *    can't take a `{ ref }`); an unresolved placeholder is skipped (left pending).
   * An existing-destination table always binds to its `{ existingRemoteTableId }`.
   */
  private async buildForeignKeyResolutionMap(
    tableMappings: DraftTableMapping[],
    options: { resolvePlaceholdersToRemoteId: boolean },
  ): Promise<Map<string, ForeignKeyTarget>> {
    const sourceFolderIds = tableMappings.map((tableMapping) => tableMapping.source.dataFolderId);
    const existingDestinationFolderIds = tableMappings
      .map((tableMapping) =>
        tableMapping.destination.kind === 'existing' ? tableMapping.destination.dataFolderId : null,
      )
      .filter((dataFolderId): dataFolderId is string => dataFolderId !== null);
    const folders = await this.db.client.dataFolder.findMany({
      where: { id: { in: [...new Set([...sourceFolderIds, ...existingDestinationFolderIds])] } },
      select: { id: true, tableId: true },
    });
    const remoteTableIdByFolderId = new Map(folders.map((folder) => [folder.id, folder.tableId]));

    const resolutionBySourceRemoteTableId = new Map<string, ForeignKeyTarget>();
    for (const tableMapping of tableMappings) {
      const sourceRemoteTableId = remoteTableIdByFolderId.get(tableMapping.source.dataFolderId);
      if (!sourceRemoteTableId || sourceRemoteTableId.length === 0) continue;

      let resolvedTarget: ForeignKeyTarget | null = null;
      if (tableMapping.destination.kind === 'placeholderTable') {
        if (options.resolvePlaceholdersToRemoteId) {
          const resolvedRemoteTableId = tableMapping.destination.resolved?.remoteTableId;
          if (resolvedRemoteTableId && resolvedRemoteTableId.length > 0) {
            resolvedTarget = { existingRemoteTableId: resolvedRemoteTableId };
          }
        } else {
          resolvedTarget = { ref: tableMapping.destination.createSpec.ref };
        }
      } else {
        const existingRemoteTableId = remoteTableIdByFolderId.get(tableMapping.destination.dataFolderId);
        if (existingRemoteTableId && existingRemoteTableId.length > 0) {
          resolvedTarget = { existingRemoteTableId };
        }
      }
      if (!resolvedTarget) continue;

      // A foreignKey's `unresolvedLinkedTableId` is a single source remote-id string;
      // index every segment of the source table's remote id so either form resolves.
      for (const remoteTableIdSegment of sourceRemoteTableId) {
        if (!resolutionBySourceRemoteTableId.has(remoteTableIdSegment)) {
          resolutionBySourceRemoteTableId.set(remoteTableIdSegment, resolvedTarget);
        }
      }
    }
    return resolutionBySourceRemoteTableId;
  }

  /**
   * Reject a draft state whose foreignKey fields point at a table no longer present in
   * the draft — the "deleting the table a foreignKey points at forces you to unmap"
   * guard, and more generally the no-broken-draft-saved check. A sibling `{ ref }` must
   * match a placeholder table in the draft; a `{ unresolvedLinkedTableId }` token must
   * match some mapping's source remote table id (the same binding {@link
   * buildForeignKeyResolutionMap} uses at materialize). A concrete `{ existingRemoteTableId }`
   * always resolves (the remote table exists regardless of the draft) and is never
   * flagged. Throws 422 `SYNC_DRAFT_FK_TARGET_MISSING` listing each stranded field so
   * the client unmaps it — or restores the target table — before saving.
   */
  private async validateForeignKeyTargetsSatisfiable(tableMappings: DraftTableMapping[]): Promise<void> {
    const foreignKeyReferences = collectDraftForeignKeyReferences(tableMappings);
    if (foreignKeyReferences.length === 0) return;

    const placeholderCreateSpecRefs = new Set<string>();
    for (const tableMapping of tableMappings) {
      if (tableMapping.destination.kind === 'placeholderTable') {
        placeholderCreateSpecRefs.add(tableMapping.destination.createSpec.ref);
      }
    }

    const sourceFolderIds = [...new Set(tableMappings.map((tableMapping) => tableMapping.source.dataFolderId))];
    const folders = await this.db.client.dataFolder.findMany({
      where: { id: { in: sourceFolderIds } },
      select: { tableId: true },
    });
    const draftSourceRemoteTableIds = new Set<string>();
    for (const folder of folders) {
      for (const remoteTableIdSegment of folder.tableId) draftSourceRemoteTableIds.add(remoteTableIdSegment);
    }

    const missingTargets: SyncDraftMissingForeignKeyTarget[] = [];
    for (const reference of foreignKeyReferences) {
      if ('ref' in reference.target) {
        if (!placeholderCreateSpecRefs.has(reference.target.ref)) {
          missingTargets.push({
            tableMappingRef: reference.tableMappingRef,
            fieldName: reference.fieldName,
            target: { ref: reference.target.ref },
          });
        }
      } else if ('unresolvedLinkedTableId' in reference.target) {
        if (!draftSourceRemoteTableIds.has(reference.target.unresolvedLinkedTableId)) {
          missingTargets.push({
            tableMappingRef: reference.tableMappingRef,
            fieldName: reference.fieldName,
            target: { unresolvedLinkedTableId: reference.target.unresolvedLinkedTableId },
          });
        }
      }
      // `existingRemoteTableId` always resolves — the remote table exists regardless of the draft.
    }

    if (missingTargets.length > 0) {
      throw new UnprocessableEntityException({
        error: 'SYNC_DRAFT_FK_TARGET_MISSING',
        message: `${missingTargets.length} foreign key field(s) point at a table that is not in this draft. Unmap them — or restore the target table — before saving.`,
        missingTargets,
      });
    }
  }

  private async materializeFieldAdditions(
    workbookId: WorkbookId,
    draftId: SyncDraftId,
    tableMappings: DraftTableMapping[],
    results: MaterializePlaceholderResult[],
    actor: Actor,
  ): Promise<void> {
    // Bind any pending `{ unresolvedLinkedTableId }` foreignKey target carried on a
    // field addition to its destination within this draft. Placeholder siblings have
    // already been created by this phase, so they bind to their real remote id (not a
    // `{ ref }`, which /schema/fields rejects); an existing-destination table binds to
    // its id. Unbound targets stay pending so createFields surfaces the requirement.
    const foreignKeyResolutionMap = await this.buildForeignKeyResolutionMap(tableMappings, {
      resolvePlaceholdersToRemoteId: true,
    });

    for (const tableMapping of tableMappings) {
      const additions = tableMapping.fieldAdditions ?? [];
      for (const addition of additions) {
        if (addition.resolved?.remoteFieldId) {
          results.push({
            ref: addition.ref,
            kind: 'field',
            status: 'alreadyResolved',
            actualName: addition.resolved.actualName,
            remoteFieldId: addition.resolved.remoteFieldId,
          });
        }
      }

      // Field additions only apply to an existing destination table.
      if (tableMapping.destination.kind !== 'existing') continue;
      const unresolved = additions.filter((addition) => !addition.resolved?.remoteFieldId);
      if (unresolved.length === 0) continue;

      const folder = await this.db.client.dataFolder.findFirst({
        where: { id: tableMapping.destination.dataFolderId },
        select: { connectorAccountId: true, tableId: true },
      });
      if (!folder?.connectorAccountId || !folder.tableId || folder.tableId.length === 0) {
        for (const addition of unresolved) {
          results.push({
            ref: addition.ref,
            kind: 'field',
            status: 'failed',
            error: 'Destination folder has no connector account or remote table id.',
          });
        }
        continue;
      }

      try {
        const dto: CreateSchemaFieldsDto = {
          connectorAccountId: folder.connectorAccountId,
          remoteTableId: folder.tableId,
          fields: unresolved.map((addition) =>
            resolveFieldForeignKeyTarget(addition.createFieldSpec, foreignKeyResolutionMap),
          ),
          refreshLocalSchema: true,
        };
        const response = await this.schemaBuilderService.createFields(workbookId, dto, actor);
        for (const addition of unresolved) {
          const fieldResult = response.fields.find((field) => field.name === addition.createFieldSpec.name);
          if (fieldResult && fieldResult.status === 'created' && fieldResult.remoteFieldId) {
            addition.resolved = { remoteFieldId: fieldResult.remoteFieldId, actualName: fieldResult.name };
            results.push({
              ref: addition.ref,
              kind: 'field',
              status: 'created',
              actualName: fieldResult.name,
              remoteFieldId: fieldResult.remoteFieldId,
            });
          } else {
            results.push({
              ref: addition.ref,
              kind: 'field',
              status: 'failed',
              error: fieldResult?.error ?? response.unsupported?.message ?? 'Field creation failed',
            });
          }
        }
        await this.persistTableMappings(draftId, tableMappings);
      } catch (error) {
        for (const addition of unresolved) {
          results.push({
            ref: addition.ref,
            kind: 'field',
            status: 'failed',
            error: schemaCreationErrorMessage(error),
          });
        }
      }
    }
  }

  private async persistTableMappings(draftId: SyncDraftId, tableMappings: DraftTableMapping[]): Promise<void> {
    await this.db.client.syncDraft.update({
      where: { id: draftId },
      data: { tableMappings: tableMappings as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
    });
  }

  // ── materialize: transform selection ─────────────────────────────────────────

  /**
   * After materialize has created the real tables/fields, pick the sync transform
   * for each newly-created (`placeholderField`) destination column from its now-real
   * schema hints and write it onto the draft column mapping; apply later threads it
   * onto the sync. This is computed here — not in the create plan — because a
   * created field's real schema (and the `x-scratch-suggested-(in-)transformer`
   * hints that drive selection) only exists once the field has been created.
   *
   * Only `placeholderField` (newly-created) columns are touched, and only when they
   * carry no transformer yet, so a transformer a user set or that came back via the
   * `fromSyncId` edit flow is never clobbered. Best-effort: a fetch/pick failure for
   * one table is logged and skipped rather than failing materialize.
   */
  private async attachTransformersToMaterializedColumns(
    workbookId: WorkbookId,
    draftId: SyncDraftId,
    tableMappings: DraftTableMapping[],
    actor: Actor,
  ): Promise<void> {
    const sourceFieldsByFolderId = new Map<string, SchemaField[]>();
    const sourceFieldsFor = async (dataFolderId: string): Promise<SchemaField[]> => {
      const cached = sourceFieldsByFolderId.get(dataFolderId);
      if (cached) return cached;
      const fields = await this.dataFolderService.getSchemaPaths(dataFolderId as DataFolderId, actor);
      sourceFieldsByFolderId.set(dataFolderId, fields);
      return fields;
    };

    let changed = false;
    for (const tableMapping of tableMappings) {
      const needsTransform = tableMapping.columnMappings.some(
        (columnMapping) =>
          columnMapping.destination.kind === 'placeholderField' &&
          !(columnMapping.transformers && columnMapping.transformers.length > 0),
      );
      if (!needsTransform) continue;

      try {
        const destinationFields = await this.materializedDestinationFields(workbookId, tableMapping, actor);
        if (!destinationFields) continue; // table didn't materialize
        const sourceFields = await sourceFieldsFor(tableMapping.source.dataFolderId);

        for (const columnMapping of tableMapping.columnMappings) {
          if (columnMapping.destination.kind !== 'placeholderField') continue;
          if (columnMapping.transformers && columnMapping.transformers.length > 0) continue;

          const fieldName = this.resolvePlaceholderFieldName(columnMapping.destination.ref, tableMapping);
          if (!fieldName) continue;
          const destinationField = destinationFields.find(
            (field) => field.path.split('.').pop() === fieldName || field.displayLabel === fieldName,
          );
          const sourceField = sourceFields.find((field) => field.path === columnMapping.source.columnId);
          const transformers = pickMappingTransformers(sourceField, destinationField);
          if (transformers.length > 0) {
            columnMapping.transformers = transformers;
            changed = true;
          }
        }
      } catch (error) {
        WSLogger.warn({
          source: 'SyncDraftService.materialize',
          message: 'Failed to pick sync transforms for a materialized table; skipping',
          draftId,
          tableMappingRef: tableMapping.ref,
          error: errorMessage(error),
        });
      }
    }

    if (changed) await this.persistTableMappings(draftId, tableMappings);
  }

  /**
   * Attach the sync transformer pipeline that turns a foreignKey column's raw source
   * value into destination linked-record ids — for every FK column whose related table
   * is ALSO synced in this draft. The pipeline is an id-extraction (lifted from the
   * source view column's display transformer, e.g. HubSpot's `$[*].id`) followed by
   * `source_fk_to_dest_fk`, which the sync's FOREIGN_KEY_MAPPING phase resolves against
   * the related table's synced records. Without it an FK column copies raw source ids
   * straight into the destination link field and nothing links.
   *
   * Only `placeholderField` columns pointing at a created foreignKey field are
   * considered, and only when the FK's related table has a SOURCE mapping in this draft
   * (so there are synced records to resolve against). A column that already carries
   * transformers (user-set, or from the `fromSyncId` edit flow) is left untouched.
   */
  private async attachForeignKeyResolutionTransformers(
    draftId: SyncDraftId,
    tableMappings: DraftTableMapping[],
    actor: Actor,
  ): Promise<void> {
    const foreignKeyColumns: {
      tableMapping: DraftTableMapping;
      columnMapping: DraftColumnMapping;
      linkedTableId: string;
    }[] = [];
    for (const tableMapping of tableMappings) {
      for (const columnMapping of tableMapping.columnMappings) {
        if (columnMapping.destination.kind !== 'placeholderField') continue;
        if (columnMapping.transformers && columnMapping.transformers.length > 0) continue;
        const linkedTableId = this.foreignKeyLinkedTableIdForColumn(columnMapping.destination.ref, tableMapping);
        if (linkedTableId) foreignKeyColumns.push({ tableMapping, columnMapping, linkedTableId });
      }
    }
    if (foreignKeyColumns.length === 0) return;

    const sourceFolderIdByRemoteTableId = await this.buildSourceFolderByRemoteTableIdMap(tableMappings);
    const viewByFolderId = new Map<string, TableView | null>();
    let changed = false;
    for (const { tableMapping, columnMapping, linkedTableId } of foreignKeyColumns) {
      const referencedDataFolderId = sourceFolderIdByRemoteTableId.get(linkedTableId);
      if (!referencedDataFolderId) continue; // the related table isn't synced here — can't resolve.

      const extraction = await this.foreignKeyIdExtractionTransformer(
        tableMapping.source.dataFolderId,
        columnMapping.source.columnId,
        viewByFolderId,
        actor,
      );
      const transformers: TransformerConfig[] = [];
      if (extraction) transformers.push(extraction);
      transformers.push({
        type: TransformerTypes.SourceFkToDestFk,
        options: { referencedDataFolderId, outputType: 'array' },
      });
      columnMapping.transformers = transformers;
      changed = true;
    }
    if (changed) await this.persistTableMappings(draftId, tableMappings);
  }

  /** Map each source table's remote id → the draft source folder that pulls it (an FK's `referencedDataFolderId`). */
  private async buildSourceFolderByRemoteTableIdMap(
    tableMappings: DraftTableMapping[],
  ): Promise<Map<string, DataFolderId>> {
    const sourceFolderIds = [...new Set(tableMappings.map((tableMapping) => tableMapping.source.dataFolderId))];
    const folders = await this.db.client.dataFolder.findMany({
      where: { id: { in: sourceFolderIds } },
      select: { id: true, tableId: true },
    });
    const sourceFolderIdByRemoteTableId = new Map<string, DataFolderId>();
    for (const folder of folders) {
      for (const remoteTableIdSegment of folder.tableId) {
        if (!sourceFolderIdByRemoteTableId.has(remoteTableIdSegment)) {
          sourceFolderIdByRemoteTableId.set(remoteTableIdSegment, folder.id as DataFolderId);
        }
      }
    }
    return sourceFolderIdByRemoteTableId;
  }

  /**
   * The source linked-table id a placeholderField column's foreignKey points at, or
   * null when the column isn't a foreignKey (or its target isn't a pending source link
   * id). Reads the created field spec the ref names — a field addition or a placeholder
   * table's create spec — which materialize leaves carrying `{ unresolvedLinkedTableId }`.
   */
  private foreignKeyLinkedTableIdForColumn(ref: string, tableMapping: DraftTableMapping): string | null {
    const additionSpec = tableMapping.fieldAdditions?.find((field) => field.ref === ref)?.createFieldSpec;
    const placeholderSpec =
      tableMapping.destination.kind === 'placeholderTable'
        ? tableMapping.destination.createSpec.fields.find((spec) => spec.name === ref)
        : undefined;
    const fieldType = (additionSpec ?? placeholderSpec)?.fieldType;
    if (fieldType?.kind === 'foreignKey' && 'unresolvedLinkedTableId' in fieldType.target) {
      return fieldType.target.unresolvedLinkedTableId;
    }
    return null;
  }

  /**
   * The id-extraction transformer for a foreignKey column, lifted from the source view
   * column's display transformer (e.g. HubSpot associations flatten
   * `associations.<type>.results` via `$[*].id`) and reused as a sync `jsonpath`
   * transformer producing an id ARRAY for `source_fk_to_dest_fk`. Null when the source
   * view has no jsonpath display transformer for the column (the value is assumed to
   * already be ids). The view is cached per folder across the pass.
   */
  private async foreignKeyIdExtractionTransformer(
    sourceDataFolderId: string,
    sourceColumnId: string,
    viewByFolderId: Map<string, TableView | null>,
    actor: Actor,
  ): Promise<TransformerConfig | null> {
    if (!viewByFolderId.has(sourceDataFolderId)) {
      viewByFolderId.set(
        sourceDataFolderId,
        await this.dataFolderService.getStoredView(sourceDataFolderId as DataFolderId, actor),
      );
    }
    const view = viewByFolderId.get(sourceDataFolderId);
    if (!view) return null;
    const displayTransformer = findViewColumnByPath(view, sourceColumnId)?.displayTransformer;
    if (displayTransformer?.type !== 'jsonpath') return null;
    return {
      type: TransformerTypes.JSONPath,
      options: { expression: displayTransformer.options.expression, arrayHandling: 'array' },
    };
  }

  /**
   * The destination table's flattened schema fields (with transform hints), fetched
   * live so just-created tables and just-added fields are reflected — a placeholder
   * table by its newly-assigned remote id (no local folder exists yet), an existing
   * table by its data folder. Returns null when the table didn't materialize.
   */
  private async materializedDestinationFields(
    workbookId: WorkbookId,
    tableMapping: DraftTableMapping,
    actor: Actor,
  ): Promise<SchemaField[] | null> {
    const destination = tableMapping.destination;
    if (destination.kind === 'placeholderTable') {
      const remoteTableId = destination.resolved?.remoteTableId;
      if (!remoteTableId) return null;
      return this.schemaBuilderService.fetchSchemaFieldsForRemoteTable(
        workbookId,
        destination.connectorAccountId,
        remoteTableId,
        actor,
      );
    }
    const spec = await this.dataFolderService.fetchSchemaSpec(destination.dataFolderId as DataFolderId, actor);
    return spec?.schema ? extractSchemaFields(spec.schema) : null;
  }

  /**
   * The created field's name a placeholder-field `ref` points at — a field addition
   * (its actual created name) or a placeholder table's create spec. Mirrors
   * {@link resolvePlaceholderFieldTarget} but needs only the name. Null when the ref
   * is dangling.
   */
  private resolvePlaceholderFieldName(ref: string, tableMapping: DraftTableMapping): string | null {
    const addition = tableMapping.fieldAdditions?.find((field) => field.ref === ref);
    if (addition) return addition.resolved?.actualName ?? addition.createFieldSpec.name;
    if (tableMapping.destination.kind === 'placeholderTable') {
      const field = tableMapping.destination.createSpec.fields.find((spec) => spec.name === ref);
      if (field) return field.name;
    }
    return null;
  }

  // ── apply internals ──────────────────────────────────────────────────────────

  private destinationFolderId(destination: DraftTableDestination): string {
    if (destination.kind === 'existing') return destination.dataFolderId;
    const dataFolderId = destination.resolved?.dataFolderId;
    if (!dataFolderId) {
      // Unreachable: the precondition + folder-creation pass guarantee this.
      throw new UnprocessableEntityException({
        error: 'SYNC_DRAFT_UNRESOLVED_PLACEHOLDERS',
        message: `Placeholder table ${destination.ref} has no destination data folder.`,
        unresolvedRefs: [destination.ref],
      });
    }
    return dataFolderId;
  }

  private async resolveColumnDestination(
    destination: DraftColumnDestination,
    tableMapping: DraftTableMapping,
    destinationDataFolderId: string,
    schemaFieldsByFolderId: Map<string, SchemaField[]>,
    actor: Actor,
  ): Promise<string> {
    if (destination.kind === 'existing') return destination.columnId;

    const target = this.resolvePlaceholderFieldTarget(destination.ref, tableMapping, destinationDataFolderId);
    const fields = await this.getSchemaFields(target.dataFolderId, schemaFieldsByFolderId, actor);
    const match = fields.find(
      (field) => field.path.split('.').pop() === target.fieldName || field.displayLabel === target.fieldName,
    );
    if (!match) {
      throw new UnprocessableEntityException({
        error: 'SYNC_DRAFT_FIELD_RESOLUTION_FAILED',
        message: `Could not resolve created field "${target.fieldName}" (ref ${destination.ref}) to a column in the destination schema.`,
      });
    }
    return match.path;
  }

  /** A placeholder field ref resolves to a created field's name + the folder it now lives in. */
  private resolvePlaceholderFieldTarget(
    ref: string,
    tableMapping: DraftTableMapping,
    destinationDataFolderId: string,
  ): { dataFolderId: string; fieldName: string } {
    const addition: DraftFieldAddition | undefined = tableMapping.fieldAdditions?.find((field) => field.ref === ref);
    if (addition) {
      return {
        dataFolderId: destinationDataFolderId,
        fieldName: addition.resolved?.actualName ?? addition.createFieldSpec.name,
      };
    }
    if (tableMapping.destination.kind === 'placeholderTable') {
      const field = tableMapping.destination.createSpec.fields.find((spec) => spec.name === ref);
      if (field) {
        return { dataFolderId: destinationDataFolderId, fieldName: field.name };
      }
    }
    throw new UnprocessableEntityException({
      error: 'SYNC_DRAFT_DANGLING_PLACEHOLDER_FIELD',
      message: `Column mapping references placeholder field "${ref}" with no matching field addition or created field.`,
    });
  }

  private async getSchemaFields(
    dataFolderId: string,
    schemaFieldsByFolderId: Map<string, SchemaField[]>,
    actor: Actor,
  ): Promise<SchemaField[]> {
    const cached = schemaFieldsByFolderId.get(dataFolderId);
    if (cached) return cached;
    // Live fetch (also rewrites the git schema) so just-created tables and
    // just-added fields are both reflected — createFields does not refresh git.
    const spec = await this.dataFolderService.fetchSchemaSpec(dataFolderId as DataFolderId, actor);
    if (!spec?.schema) {
      throw new UnprocessableEntityException({
        error: 'SYNC_DRAFT_SCHEMA_UNAVAILABLE',
        message: `Could not read the destination schema for data folder ${dataFolderId}.`,
      });
    }
    const fields = extractSchemaFields(spec.schema);
    schemaFieldsByFolderId.set(dataFolderId, fields);
    return fields;
  }

  private async buildSharedSync(syncId: SyncId): Promise<Sync> {
    const full = await this.syncService.getSyncForExecution(syncId);
    if (!full) {
      throw new NotFoundException(`Sync ${syncId} not found after apply`);
    }
    const sentinelV1: SyncMapping = { version: 1, tableMappings: [] };
    return {
      id: full.id as SyncId,
      createdAt: full.createdAt.toISOString(),
      updatedAt: full.updatedAt.toISOString(),
      displayName: full.displayName,
      displayOrder: full.displayOrder,
      mappings: sentinelV1,
      mappingsV2: full.mappings.version === 2 ? full.mappings : null,
      syncState: full.syncState as SyncState,
      syncStateLastChanged: full.syncStateLastChanged?.toISOString() ?? null,
      lastSyncTime: full.lastSyncTime?.toISOString() ?? null,
      publishAfterSync: full.publishAfterSync,
      syncTablePairs: full.syncTablePairs.map((pair) => ({
        id: pair.id as SyncTablePairId,
        syncId: pair.syncId as SyncId,
        sourceDataFolderId: pair.sourceDataFolderId as DataFolderId,
        destinationDataFolderId: pair.destinationDataFolderId as DataFolderId,
        createdAt: pair.createdAt.toISOString(),
        updatedAt: pair.updatedAt.toISOString(),
      })),
    };
  }

  // ── shared internals ─────────────────────────────────────────────────────────

  private async loadDraftOrThrow(draftId: SyncDraftId): Promise<PrismaSyncDraft> {
    const row = await this.db.client.syncDraft.findFirst({ where: { id: draftId } });
    if (!row) {
      throw new NotFoundException(`Sync draft ${draftId} not found`);
    }
    return row;
  }

  /**
   * Converts an existing sync into blank-slate draft form: its v2 table mappings
   * become all-`existing`, zero-placeholder draft mappings. A source column's
   * transformer pipeline is carried back onto the draft mapping, so a transform-
   * bearing sync (e.g. one built by CRM Mirror into Notion) round-trips through the
   * editor instead of being locked out. Constructs the draft model still can't
   * represent — a constant column source, a per-column `when` other than `matched`,
   * or a non-default unmatched-source/-destination policy — are rejected with a 422
   * rather than silently dropped, surfacing the limitation instead of corrupting the
   * edit on re-apply.
   */
  private async initializeFromExistingSync(
    workbookId: WorkbookId,
    syncId: SyncId,
  ): Promise<{
    displayName: string;
    schedule: string | null;
    publishAfterSync: boolean;
    tableMappings: DraftTableMapping[];
  }> {
    const sync = await this.syncService.getSync(syncId);
    if (!sync || sync.workbookId !== workbookId) {
      throw new NotFoundException(`Sync ${syncId} not found in workbook ${workbookId}`);
    }

    const v2 = sync.mappings.version === 2 ? sync.mappings : transformV1ToV2(sync.mappings);
    const tableMappings = v2.tableMappings.map((tm, index) => this.convertTableMappingToDraft(tm, index, syncId));

    const scheduleRow = await this.db.client.schedule.findFirst({
      where: { workbookId, action: ScheduleAction.SYNC, entityId: syncId },
      select: { cronExpression: true },
    });

    return {
      displayName: sync.displayName,
      schedule: scheduleRow?.cronExpression ?? null,
      publishAfterSync: sync.publishAfterSync,
      tableMappings,
    };
  }

  private convertTableMappingToDraft(tm: TableMappingV2, index: number, syncId: SyncId): DraftTableMapping {
    const columnMappings = tm.columnMappings.map((cm) => {
      if (cm.source.kind !== 'column') {
        throw this.unsupportedEditError(syncId, 'a constant column mapping');
      }
      if (cm.when && cm.when !== 'matched') {
        throw this.unsupportedEditError(syncId, `a column mapping with when='${cm.when}'`);
      }
      // Carry the source transformer(s) back so a transform-bearing sync round-trips.
      // The draft model holds a pipeline, so a single `transformer` normalizes to a
      // one-element `transformers`; apply threads it back onto the sync's source.
      const transformers = cm.source.transformers ?? (cm.source.transformer ? [cm.source.transformer] : undefined);
      return {
        source: { columnId: cm.source.columnId },
        destination: { kind: 'existing' as const, columnId: cm.destinationColumnId },
        ...(transformers && transformers.length > 0 ? { transformers } : {}),
      };
    });

    return {
      ref: `t${index}`,
      source: { dataFolderId: tm.sourceDataFolderId },
      destination: { kind: 'existing', dataFolderId: tm.destinationDataFolderId },
      columnMappings,
      ...(tm.recordMatching
        ? {
            recordMatching: {
              source: { columnId: tm.recordMatching.sourceColumnId },
              destination: { kind: 'existing' as const, columnId: tm.recordMatching.destinationColumnId },
            },
          }
        : {}),
      // Round-trip the unmatched-record policies (incl. withMatchKey: 'delete') back
      // onto the draft so an edit re-applies them rather than silently dropping them.
      ...(tm.unmatchedSourcePolicy ? { unmatchedSourcePolicy: tm.unmatchedSourcePolicy } : {}),
      ...(tm.unmatchedDestinationPolicy ? { unmatchedDestinationPolicy: tm.unmatchedDestinationPolicy } : {}),
    };
  }

  private unsupportedEditError(syncId: SyncId, reason: string): UnprocessableEntityException {
    return new UnprocessableEntityException({
      error: 'SYNC_DRAFT_UNSUPPORTED_SOURCE_SYNC',
      message: `Sync ${syncId} cannot be edited as a draft yet: it uses ${reason}.`,
    });
  }
}

/** Refs of placeholders (tables + field additions) that still need materialize. */
function collectUnresolvedPlaceholderRefs(tableMappings: DraftTableMapping[]): string[] {
  const refs: string[] = [];
  for (const tableMapping of tableMappings) {
    if (tableMapping.destination.kind === 'placeholderTable' && !tableMapping.destination.resolved?.remoteTableId) {
      refs.push(tableMapping.destination.ref);
    }
    for (const addition of tableMapping.fieldAdditions ?? []) {
      if (!addition.resolved?.remoteFieldId) refs.push(addition.ref);
    }
  }
  return refs;
}

function aggregateMaterializeStatus(results: MaterializePlaceholderResult[]): MaterializeResponse['status'] {
  const attempted = results.filter((result) => result.status !== 'alreadyResolved');
  if (attempted.length === 0) return 'noop';
  const failed = attempted.filter((result) => result.status === 'failed');
  if (failed.length === 0) return 'ok';
  const created = attempted.filter((result) => result.status === 'created');
  return created.length === 0 ? 'failed' : 'partial';
}
