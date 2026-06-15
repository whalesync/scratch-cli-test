import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, SyncDraft as PrismaSyncDraft } from '@prisma/client';
import {
  type CreateSchemaFieldsDto,
  type CreateSchemaTablesDto,
  createSyncDraftId,
  type DataFolderId,
  type DraftColumnDestination,
  type DraftFieldAddition,
  type DraftTableDestination,
  type DraftTableMapping,
  type MaterializePlaceholderResult,
  type MaterializeResponse,
  type SaveSyncBody,
  ScheduleAction,
  type Sync,
  type SyncDraft,
  type SyncDraftId,
  type SyncId,
  type SyncMapping,
  SyncState,
  type SyncTablePairId,
  type TableMappingV2,
  transformV1ToV2,
  type WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
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

@Injectable()
export class SyncDraftService {
  constructor(
    private readonly db: DbService,
    private readonly workbookService: WorkbookService,
    private readonly syncService: SyncService,
    private readonly schemaBuilderService: SchemaBuilderService,
    private readonly dataFolderService: DataFolderService,
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
        : { displayName: 'Untitled sync', schedule: null as string | null, tableMappings: [] as DraftTableMapping[] };

      return tx.syncDraft.create({
        data: {
          id: createSyncDraftId(),
          workbookId,
          version: 1,
          displayName: initialized.displayName,
          schedule: initialized.schedule,
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

    const data: Prisma.SyncDraftUpdateInput = { version: { increment: 1 } };
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.schedule !== undefined) data.schedule = dto.schedule;
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
  async apply(draftId: SyncDraftId, actor: Actor): Promise<Sync> {
    const row = await this.loadDraftOrThrow(draftId);
    const workbookId = row.workbookId as WorkbookId;
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
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
          source: { kind: 'column' as const, columnId: columnMapping.source.columnId },
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
      });
    }

    const body: SaveSyncBody = {
      displayName: draft.displayName,
      mappings: { version: 2, tableMappings: v2TableMappings },
      validateMappings: true,
      schedule: draft.schedule ?? '',
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

    return this.buildSharedSync(syncId);
  }

  // ── materialize internals ────────────────────────────────────────────────────

  private async materializePlaceholderTables(
    workbookId: WorkbookId,
    draftId: SyncDraftId,
    tableMappings: DraftTableMapping[],
    results: MaterializePlaceholderResult[],
    actor: Actor,
  ): Promise<void> {
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
          tables: group.placeholders.map((placeholder) => placeholder.createSpec),
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
          results.push({ ref: placeholder.ref, kind: 'table', status: 'failed', error: errorMessage(error) });
        }
      }
    }
  }

  private async materializeFieldAdditions(
    workbookId: WorkbookId,
    draftId: SyncDraftId,
    tableMappings: DraftTableMapping[],
    results: MaterializePlaceholderResult[],
    actor: Actor,
  ): Promise<void> {
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
          fields: unresolved.map((addition) => addition.createFieldSpec),
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
          results.push({ ref: addition.ref, kind: 'field', status: 'failed', error: errorMessage(error) });
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
   * become all-`existing`, zero-placeholder draft mappings. Constructs the draft
   * model can't yet represent (constant column sources, transformers, non-default
   * unmatched policies) are rejected with a 422 rather than silently dropped —
   * surfacing the limitation instead of corrupting the edit on re-apply. Syncs
   * produced by this flow are transformer-free, so they always round-trip.
   */
  private async initializeFromExistingSync(
    workbookId: WorkbookId,
    syncId: SyncId,
  ): Promise<{ displayName: string; schedule: string | null; tableMappings: DraftTableMapping[] }> {
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

    return { displayName: sync.displayName, schedule: scheduleRow?.cronExpression ?? null, tableMappings };
  }

  private convertTableMappingToDraft(tm: TableMappingV2, index: number, syncId: SyncId): DraftTableMapping {
    if (tm.unmatchedSourcePolicy && tm.unmatchedSourcePolicy.type !== 'create') {
      throw this.unsupportedEditError(syncId, 'a non-default unmatched-source policy');
    }
    if (
      tm.unmatchedDestinationPolicy &&
      (tm.unmatchedDestinationPolicy.withMatchKey !== 'ignore' ||
        tm.unmatchedDestinationPolicy.withoutMatchKey !== 'ignore')
    ) {
      throw this.unsupportedEditError(syncId, 'a non-default unmatched-destination policy');
    }

    const columnMappings = tm.columnMappings.map((cm) => {
      if (cm.source.kind !== 'column') {
        throw this.unsupportedEditError(syncId, 'a constant column mapping');
      }
      if (cm.source.transformer || (cm.source.transformers && cm.source.transformers.length > 0)) {
        throw this.unsupportedEditError(syncId, 'a column transformer');
      }
      if (cm.when && cm.when !== 'matched') {
        throw this.unsupportedEditError(syncId, `a column mapping with when='${cm.when}'`);
      }
      return {
        source: { columnId: cm.source.columnId },
        destination: { kind: 'existing' as const, columnId: cm.destinationColumnId },
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
