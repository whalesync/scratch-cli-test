import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, SyncDraft as PrismaSyncDraft } from '@prisma/client';
import type { TSchema } from '@sinclair/typebox';
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
  getSuggestedTransform,
  type MaterializePlaceholderResult,
  type MaterializeResponse,
  type SaveSyncBody,
  type SaveSyncDraftResponse,
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
  type TransformerConfig,
  TransformerTypes,
  transformV1ToV2,
  type ValidateSchemaIssue,
  type WorkbookId,
} from '@spinner/shared-types';
import { WorkbookCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { buildSyncRoutineFile } from 'src/routine/routine-generator';
import { RoutineService } from 'src/routine/routine.service';
import { linkedTableIdCandidateTokensForRemoteTableId } from 'src/schema-builder/foreign-key-linked-table-id';
import { SchemaBuilderService } from 'src/schema-builder/schema-builder.service';
import {
  columnTransformInputFromSchemaField,
  resolveColumnTransformInput,
} from 'src/sync/resolve-column-transform-input';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import { extractSchemaFields, findCreatedDestinationField, SchemaField } from 'src/utils/schema-helpers';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { CreateSyncDraftDtoClass, PatchSyncDraftDtoClass } from './dto/sync-draft.dto';
import { SyncDraftEntity } from './entities/sync-draft.entity';

/** The placeholder-table variant of a draft table destination (carries the create plan + resolution). */
type PlaceholderTableDestination = Extract<DraftTableDestination, { kind: 'placeholderTable' }>;

/**
 * Invoked by materialize after each remote-creation batch lands (and after a batch fails), with the
 * cumulative per-ref results so far. `phase` says which materialize pass produced the batch —
 * placeholder tables first, then field additions. This is how the background save job
 * (apply-sync-draft) feeds its running "created 7 of 23" progress; the synchronous endpoint passes
 * no callback and behaves exactly as before (DEV-10875).
 */
export type MaterializeBatchProgressCallback = (
  phase: 'tables' | 'fields',
  cumulativeResults: MaterializePlaceholderResult[],
) => Promise<void> | void;

export interface MaterializeSyncDraftOptions {
  onBatchProgress?: MaterializeBatchProgressCallback;
  /**
   * Invoked as EACH individual table lands inside a placeholder-table creation batch (threaded
   * through the schema builder's per-table observer), with the placeholder's draft `ref`. This is
   * what makes a per-table progress bar tick during the long single-batch case (all new tables into
   * one destination base) instead of jumping 0 → N at batch end. Early notice only: the
   * authoritative per-ref results — and the draft-row checkpoint persistence — still arrive with
   * the batch via {@link onBatchProgress}, and failures are only reported there.
   */
  onPlaceholderCreatedInBatch?: (placeholderRef: string) => Promise<void> | void;
  /**
   * Set ONLY by the apply-sync-draft job itself: skips the "another save job is running" 409 guard,
   * which would otherwise reject the job's own materialize/apply calls.
   */
  calledByActiveSaveJob?: boolean;
}

export interface ApplySyncDraftOptions {
  createRoutine?: boolean;
  /**
   * Invoked as apply advances through its phases — creating destination data folders, then saving
   * the sync. Feeds the background save job's progress; the synchronous endpoint passes none.
   */
  onPhaseChange?: (phase: 'creating_folders' | 'saving_sync') => Promise<void> | void;
  /** Set ONLY by the apply-sync-draft job itself — see {@link MaterializeSyncDraftOptions}. */
  calledByActiveSaveJob?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DraftForeignKeyReference {
  /** The `ref` of the table mapping that holds the foreignKey field. */
  tableMappingRef: string;
  fieldName: string;
  target: ForeignKeyTarget;
}

/**
 * A source folder resolved for transform picking: its raw JSON schema (to read a drilled path's type past
 * the connector envelope), its flattened fields (for the ancestor-walk hint fallback), and its stored View
 * (the transform authority). Shared by the value picker and the FK id-extraction below; `null` marks a
 * folder with no schema. Built by {@link SyncDraftService.resolveSourceContext}.
 */
type SourceContext = { schema: TSchema; fieldsByPath: Map<string, SchemaField>; view: TableView | null };

/**
 * The id-extraction transformer for a foreignKey column: the column's `toCore` extract, resolved
 * View-first (a view `displayTransformer` like HubSpot's `$[*].id`, OR a schema hint like Notion's relation
 * `$.relation[*].id` reached by ancestor-walk), reused as a jsonpath that yields the id ARRAY the
 * `source_fk_to_dest_fk` phase resolves against the linked table's synced records. Null when the column's
 * extract isn't a jsonpath (the raw value is assumed to already be ids). Forcing `arrayHandling: 'array'`
 * keeps the FK id list intact regardless of how the same column renders for display.
 */
function foreignKeyIdExtractionTransformer(
  sourceContext: SourceContext,
  sourceColumnId: string,
): TransformerConfig | null {
  const { toCore } = resolveColumnTransformInput({
    columnId: sourceColumnId,
    schema: sourceContext.schema,
    fieldsByPath: sourceContext.fieldsByPath,
    view: sourceContext.view,
  });
  if (toCore?.type !== 'jsonpath') return null;
  return {
    type: TransformerTypes.JSONPath,
    options: { expression: toCore.options.expression, arrayHandling: 'array' },
  };
}

/**
 * Stable string key for a connector remote table id (an ordered id-segment array,
 * e.g. `['base1', 'tblComp']` or `['public', 'companies']`). Used to match a
 * foreignKey `{ existingRemoteTableId }` target against a sibling table mapping's
 * destination remote table id. A NUL byte can't appear in a real id segment, so it
 * is an unambiguous join separator.
 */
function remoteTableIdKey(remoteTableId: string[]): string {
  return remoteTableId.join('\u0000');
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
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly jobService: JobService,
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
   * Save the draft as a background job (DEV-10875): enqueue `apply-sync-draft` (which runs
   * materialize then apply with progress reporting) and return its job id as a 202
   * acknowledgement. Single-flight per draft: a transaction-scoped advisory lock serializes
   * concurrent saves, and a save while the draft's `activeSaveJobId` still points at a running job
   * returns that same job id instead of enqueuing a second one — a double-click or two tabs
   * collapse into "watch the same job". A stale id (finished job, or a worker crash that never
   * cleared it) is simply replaced by the new enqueue.
   */
  async save(draftId: SyncDraftId, dto: { createRoutine?: boolean }, actor: Actor): Promise<SaveSyncDraftResponse> {
    const row = await this.loadDraftOrThrow(draftId);
    const workbookId = row.workbookId as WorkbookId;
    await this.workbookService.assertWritableWorkbook(actor, workbookId);

    const bullJobId = await this.db.client.$transaction(
      async (tx) => {
        // Transaction-scoped lock (auto-released on commit/rollback), keyed by the draft.
        // Concurrent saves for the same draft queue behind it, so the check-then-enqueue
        // below can't race itself.
        const lockKey = `sync-draft-save:${draftId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

        const lockedRow = await tx.syncDraft.findFirst({ where: { id: draftId } });
        if (!lockedRow) {
          throw new NotFoundException(`Sync draft ${draftId} not found`);
        }
        if (lockedRow.archivedAt) {
          throw new ConflictException({
            error: 'SYNC_DRAFT_ARCHIVED',
            message: `Sync draft ${draftId} has already been applied.`,
          });
        }
        if (lockedRow.activeSaveJobId && (await this.isBackgroundSaveJobStillRunning(lockedRow.activeSaveJobId))) {
          return lockedRow.activeSaveJobId;
        }

        const job = await this.bullEnqueuerService.enqueueApplySyncDraftJob(
          workbookId,
          draftId,
          actor,
          { createRoutine: dto.createRoutine ?? false },
          createRunContext('web'),
        );
        const enqueuedBullJobId = job.id?.toString();
        if (!enqueuedBullJobId) {
          throw new Error(`Apply-sync-draft job for draft ${draftId} was enqueued without an id`);
        }
        await tx.syncDraft.update({ where: { id: draftId }, data: { activeSaveJobId: enqueuedBullJobId } });
        return enqueuedBullJobId;
      },
      // The enqueue inside the lock does a few DB + Redis round-trips; give it headroom beyond
      // Prisma's 5s interactive-transaction default.
      { timeout: 30_000 },
    );

    return { jobId: bullJobId };
  }

  /**
   * Clear `activeSaveJobId` after the save job finishes — but only if it still points at THAT
   * job, so a newer save's id (enqueued after this job was already observed finished) is never
   * wiped. Called by the apply-sync-draft job handler on completion and failure.
   */
  async clearActiveSaveJobIdIfOwnedByJob(draftId: SyncDraftId, bullJobId: string): Promise<void> {
    await this.db.client.syncDraft.updateMany({
      where: { id: draftId, activeSaveJobId: bullJobId },
      data: { activeSaveJobId: null },
    });
  }

  /**
   * The run-time single-flight guard for the legacy synchronous endpoints during rollout: reject
   * a direct materialize/apply while a background save job is running the same phases, so the two
   * paths can't interleave (e.g. both creating remote tables from the same unresolved
   * placeholders). 409 with the running job's id so the client can watch it instead.
   */
  private async assertNoRunningBackgroundSaveJob(row: PrismaSyncDraft): Promise<void> {
    if (!row.activeSaveJobId) return;
    if (await this.isBackgroundSaveJobStillRunning(row.activeSaveJobId)) {
      throw new ConflictException({
        error: 'SYNC_DRAFT_SAVE_IN_PROGRESS',
        message: `Sync draft ${row.id} is being saved by background job ${row.activeSaveJobId}; watch that job instead of retrying.`,
        jobId: row.activeSaveJobId,
      });
    }
  }

  /**
   * Whether the save job a draft's `activeSaveJobId` points at is still pending/running. Reads the
   * DbJob row (by bull job id) rather than Redis; a job that finished, failed, was canceled, or
   * whose record has vanished counts as not running — its stale id is safe to replace.
   */
  private async isBackgroundSaveJobStillRunning(bullJobId: string): Promise<boolean> {
    const [jobEntity] = await this.jobService.getJobsProgress([bullJobId]);
    if (!jobEntity) return false;
    const terminalStates: string[] = ['completed', 'failed', 'canceled', 'unknown'];
    return !terminalStates.includes(jobEntity.state);
  }

  /**
   * Phase 1 (materialize) — creates the still-unresolved remote tables/fields and
   * checkpoints each success back into the stored draft per `ref` the instant it
   * lands. Best-effort and re-callable: only unresolved placeholders are
   * attempted, so a retry never re-creates what already succeeded (the resume
   * primitive). A lost response leaves an orphan remote table (litter), never a
   * mapping pointing at one.
   */
  async materialize(
    draftId: SyncDraftId,
    actor: Actor,
    options: MaterializeSyncDraftOptions = {},
  ): Promise<MaterializeResponse> {
    const row = await this.loadDraftOrThrow(draftId);
    const workbookId = row.workbookId as WorkbookId;
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    if (row.archivedAt) {
      throw new ConflictException({
        error: 'SYNC_DRAFT_ARCHIVED',
        message: `Sync draft ${draftId} has been applied and can no longer be materialized.`,
      });
    }
    if (!options.calledByActiveSaveJob) {
      await this.assertNoRunningBackgroundSaveJob(row);
    }

    const tableMappings = SyncDraftEntity.from(row).tableMappings;
    const results: MaterializePlaceholderResult[] = [];

    await this.materializePlaceholderTables(workbookId, draftId, tableMappings, results, actor, options);
    await this.materializeFieldAdditions(workbookId, draftId, tableMappings, results, actor, options.onBatchProgress);
    // ONE source-context cache shared by both transformer-attach passes below, so each
    // distinct source folder pays its live connector schema fetch (and the git schema/view
    // rewrite fetchSchemaSpec performs as a side effect) once per materialize, not once per
    // pass (DEV-10875).
    const sourceContextByFolderId = new Map<string, SourceContext | null>();
    // Likewise ONE destination-fields cache (per table mapping ref) shared by both passes —
    // the FK pass reads the created FK field's pack hint from the same live-fetched schema
    // the transform picker reads its hints from.
    const destinationFieldsByTableMappingRef = new Map<string, SchemaField[] | null>();
    // Give every foreignKey column whose related table is ALSO synced here the pipeline
    // that resolves source FK ids → destination linked-record ids. Runs BEFORE the generic
    // picker so those columns end up with the FK pipeline (the picker then skips them).
    await this.attachForeignKeyResolutionTransformers(
      workbookId,
      draftId,
      tableMappings,
      sourceContextByFolderId,
      destinationFieldsByTableMappingRef,
      actor,
    );
    // Now the destination fields are real: pick the sync transform for each remaining
    // newly-created column from its actual schema hints and write it to the draft.
    await this.attachTransformersToMaterializedColumns(
      workbookId,
      draftId,
      tableMappings,
      sourceContextByFolderId,
      destinationFieldsByTableMappingRef,
      actor,
    );

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
  async apply(draftId: SyncDraftId, actor: Actor, options: ApplySyncDraftOptions = {}): Promise<Sync> {
    const row = await this.loadDraftOrThrow(draftId);
    const workbookId = row.workbookId as WorkbookId;
    const workbook = await this.workbookService.assertWritableWorkbook(actor, workbookId);
    if (row.archivedAt) {
      throw new ConflictException({
        error: 'SYNC_DRAFT_ARCHIVED',
        message: `Sync draft ${draftId} has already been applied.`,
      });
    }
    if (!options.calledByActiveSaveJob) {
      await this.assertNoRunningBackgroundSaveJob(row);
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
    //
    // Every folder backing a placeholder table went through createFolder — which fetches
    // the table's live schema and writes it to git — AFTER materialize finished creating
    // the table's fields. So for these folders the stored git schema already reflects
    // every created field, and column resolution below reads that stored copy instead of
    // paying a second live connector fetch per just-created table (DEV-10875).
    const dataFolderIdsWithFreshStoredSchema = new Set<string>();
    await options.onPhaseChange?.('creating_folders');
    for (const tableMapping of tableMappings) {
      if (tableMapping.destination.kind !== 'placeholderTable') continue;
      const destination = tableMapping.destination;
      const resolved = destination.resolved;
      if (!resolved?.remoteTableId) continue; // guarded by the precondition above
      if (resolved.dataFolderId) {
        dataFolderIdsWithFreshStoredSchema.add(resolved.dataFolderId);
        continue; // already created on a prior attempt
      }
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
      dataFolderIdsWithFreshStoredSchema.add(folder.id);
      await this.persistTableMappings(draftId, tableMappings);
    }

    // Build the native v2 mapping, resolving placeholder field refs → real column
    // path ids by name against each destination folder's (live) schema.
    await options.onPhaseChange?.('saving_sync');
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
          dataFolderIdsWithFreshStoredSchema,
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
              dataFolderIdsWithFreshStoredSchema,
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

    // Validate against the STORED git schemas, not live connector fetches — the default
    // live validation re-fetches source+destination per table pair, the dominant cost of
    // saving a many-table draft (DEV-10875). Stored is fresh for every folder this draft
    // touches: created tables' schemas were written by createFolder above; an existing
    // destination with created fields was live-refreshed by the column resolution above
    // (getSchemaFields' fetchSchemaSpec rewrites git); and source / untouched-destination
    // schemas are maintained by pull and are what the draft's mappings were built from.
    const saveOptions = { validateAgainstStoredSchemas: true };
    let syncId: SyncId;
    if (draft.sourceSyncId) {
      await this.syncService.updateSync(workbookId, draft.sourceSyncId, body, actor, saveOptions);
      syncId = draft.sourceSyncId;
    } else {
      const created = await this.syncService.createSync(workbookId, body, actor, saveOptions);
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
    progressOptions: Pick<MaterializeSyncDraftOptions, 'onBatchProgress' | 'onPlaceholderCreatedInBatch'> = {},
  ): Promise<void> {
    const { onBatchProgress, onPlaceholderCreatedInBatch } = progressOptions;
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

    // Report the already-resolved refs up front so a resumed save's progress starts from the
    // checkpoint, not from zero.
    if (results.length > 0) await onBatchProgress?.('tables', results);

    for (const group of groups.values()) {
      // Early per-table ticks for the progress bar: tables in this batch are created sequentially
      // on the remote service, and the schema builder notifies us as each one lands — the batch
      // response below stays authoritative for results and checkpoint persistence.
      const placeholderRefByCreateSpecRef = new Map(
        group.placeholders.map((placeholder) => [placeholder.createSpec.ref, placeholder.ref]),
      );
      try {
        const dto: CreateSchemaTablesDto = {
          connectorAccountId: group.connectorAccountId,
          ...(group.remoteParentId ? { remoteParentId: group.remoteParentId } : {}),
          tables: group.placeholders.map((placeholder) =>
            resolveCreateSpecForeignKeyTargets(placeholder.createSpec, foreignKeyResolutionMap),
          ),
          materializeLocally: false,
        };
        const response = await this.schemaBuilderService.createTables(workbookId, dto, actor, {
          onTableResult: async (tableResult) => {
            if (tableResult.status === 'failed' || !tableResult.remoteTableId) return;
            const placeholderRef = placeholderRefByCreateSpecRef.get(tableResult.ref);
            if (placeholderRef) await onPlaceholderCreatedInBatch?.(placeholderRef);
          },
        });
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
      await onBatchProgress?.('tables', results);
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
        const resolvedRemoteTableId = tableMapping.destination.resolved?.remoteTableId;
        if (resolvedRemoteTableId && resolvedRemoteTableId.length > 0) {
          // The sibling placeholder is ALREADY materialized (a prior run, or earlier this run).
          // Bind to its real remote id even in the new-tables phase: a `{ ref }` only resolves
          // for a sibling created in the SAME createTables batch, but an already-resolved sibling
          // is skipped from the batch — so the ref would dangle and the connector would silently
          // drop the foreignKey field (leaving the column uncreated and unresolvable at apply).
          resolvedTarget = { existingRemoteTableId: resolvedRemoteTableId };
        } else if (!options.resolvePlaceholdersToRemoteId) {
          // New-tables phase: an unresolved sibling IS created in this batch, where its ref resolves.
          resolvedTarget = { ref: tableMapping.destination.createSpec.ref };
        }
        // Add-fields phase with an unresolved sibling: leave pending (handled by the `continue` below).
      } else {
        const existingRemoteTableId = remoteTableIdByFolderId.get(tableMapping.destination.dataFolderId);
        if (existingRemoteTableId && existingRemoteTableId.length > 0) {
          resolvedTarget = { existingRemoteTableId };
        }
      }
      if (!resolvedTarget) continue;

      // A foreignKey's `unresolvedLinkedTableId` is a single source remote-id string; index every
      // token the source table's compound remote id can be named by so either form resolves.
      for (const candidateToken of linkedTableIdCandidateTokensForRemoteTableId(sourceRemoteTableId)) {
        if (!resolutionBySourceRemoteTableId.has(candidateToken)) {
          resolutionBySourceRemoteTableId.set(candidateToken, resolvedTarget);
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
      for (const candidateToken of linkedTableIdCandidateTokensForRemoteTableId(folder.tableId)) {
        draftSourceRemoteTableIds.add(candidateToken);
      }
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
    onBatchProgress?: MaterializeBatchProgressCallback,
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
      // One progress report per table mapping that produced new per-ref results this iteration
      // (created, alreadyResolved, or failed) — the field-additions analogue of the per-batch
      // report in materializePlaceholderTables.
      const resultsCountBeforeThisMapping = results.length;
      const reportBatchProgressIfAnyNewResults = async () => {
        if (results.length > resultsCountBeforeThisMapping) await onBatchProgress?.('fields', results);
      };

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
      if (tableMapping.destination.kind !== 'existing') {
        await reportBatchProgressIfAnyNewResults();
        continue;
      }
      const unresolved = additions.filter((addition) => !addition.resolved?.remoteFieldId);
      if (unresolved.length === 0) {
        await reportBatchProgressIfAnyNewResults();
        continue;
      }

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
        await reportBatchProgressIfAnyNewResults();
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
      await reportBatchProgressIfAnyNewResults();
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
   * Load a source folder's {@link SourceContext} — raw schema, flattened fields, stored View — memoized in
   * `cache`. Returns `null` when the folder has no schema. Shared by the value picker and the FK id-extraction.
   */
  private async resolveSourceContext(
    dataFolderId: string,
    cache: Map<string, SourceContext | null>,
    actor: Actor,
  ): Promise<SourceContext | null> {
    const cached = cache.get(dataFolderId);
    if (cached !== undefined) return cached;
    const spec = await this.dataFolderService.fetchSchemaSpec(dataFolderId as DataFolderId, actor);
    const schema = spec?.schema;
    if (!schema) {
      cache.set(dataFolderId, null);
      return null;
    }
    const fieldsByPath = new Map(extractSchemaFields(schema).map((field) => [field.path, field]));
    const view = await this.dataFolderService.getStoredView(dataFolderId as DataFolderId, actor);
    const context: SourceContext = { schema, fieldsByPath, view };
    cache.set(dataFolderId, context);
    return context;
  }

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
    sourceContextByFolderId: Map<string, SourceContext | null>,
    destinationFieldsByTableMappingRef: Map<string, SchemaField[] | null>,
    actor: Actor,
  ): Promise<void> {
    let changed = false;
    for (const tableMapping of tableMappings) {
      const needsTransform = tableMapping.columnMappings.some(
        (columnMapping) =>
          columnMapping.destination.kind === 'placeholderField' &&
          !(columnMapping.transformers && columnMapping.transformers.length > 0),
      );
      if (!needsTransform) continue;

      try {
        const destinationFields = await this.resolveMaterializedDestinationFieldsCached(
          workbookId,
          tableMapping,
          destinationFieldsByTableMappingRef,
          actor,
        );
        if (!destinationFields) continue; // table didn't materialize
        const sourceContext = await this.resolveSourceContext(
          tableMapping.source.dataFolderId,
          sourceContextByFolderId,
          actor,
        );
        if (!sourceContext) continue; // no source schema; can't resolve

        for (const columnMapping of tableMapping.columnMappings) {
          if (columnMapping.destination.kind !== 'placeholderField') continue;
          if (columnMapping.transformers && columnMapping.transformers.length > 0) continue;

          const createdFieldTarget = this.resolveCreatedFieldTarget(columnMapping.destination.ref, tableMapping);
          if (!createdFieldTarget) continue;
          const destinationField = findCreatedDestinationField(destinationFields, createdFieldTarget);

          // Resolve the SOURCE column View-first at the exact path the mapping references — this dissolves
          // the Notion inner-path mole (a drilled `properties.X.multi_select` / subfield leaf now finds its
          // codec/hint via the view + ancestor-walk). The DESTINATION is built from its just-created field's
          // own type + pack hint.
          const sourceInput = resolveColumnTransformInput({
            columnId: columnMapping.source.columnId,
            schema: sourceContext.schema,
            fieldsByPath: sourceContext.fieldsByPath,
            view: sourceContext.view,
          });
          const destinationInput = columnTransformInputFromSchemaField(destinationField);

          const suggestion = getSuggestedTransform(sourceInput, destinationInput);
          if (suggestion.result === 'valid' && suggestion.options[0].transformerChain.length > 0) {
            columnMapping.transformers = suggestion.options[0].transformerChain;
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
    workbookId: WorkbookId,
    draftId: SyncDraftId,
    tableMappings: DraftTableMapping[],
    sourceContextByFolderId: Map<string, SourceContext | null>,
    destinationFieldsByTableMappingRef: Map<string, SchemaField[] | null>,
    actor: Actor,
  ): Promise<void> {
    // A source table's remote id → the draft source folder that pulls it — the folder an
    // `{ unresolvedLinkedTableId }` foreignKey target resolves against. Built up front so the
    // collection loop can turn each column's target into its referenced source folder.
    const sourceFolderIdByRemoteTableId = await this.buildSourceFolderByRemoteTableIdMap(tableMappings);
    // A placeholder table's create-spec ref → that table mapping's SOURCE folder — the folder a
    // sibling `{ ref }` foreignKey target resolves against (the ref names a table created in this
    // same draft, and its source records are what `source_fk_to_dest_fk` resolves ids against).
    const sourceDataFolderIdByPlaceholderCreateSpecRef = new Map<string, DataFolderId>();
    for (const tableMapping of tableMappings) {
      if (tableMapping.destination.kind === 'placeholderTable') {
        sourceDataFolderIdByPlaceholderCreateSpecRef.set(
          tableMapping.destination.createSpec.ref,
          tableMapping.source.dataFolderId as DataFolderId,
        );
      }
    }
    // A sibling mapping's DESTINATION remote table id → that mapping's SOURCE folder — the folder a
    // concrete `{ existingRemoteTableId }` foreignKey target resolves against when the referenced
    // table is itself synced in this draft (Attio→Supabase: each destination table is provisioned
    // up front, so a cross-table reference is persisted as `{ existingRemoteTableId }`, not `{ ref }`).
    const sourceDataFolderIdByDestinationRemoteTableIdKey =
      await this.buildSourceFolderIdByDestinationRemoteTableIdKeyMap(tableMappings);

    const foreignKeyColumns: {
      tableMapping: DraftTableMapping;
      columnMapping: DraftColumnMapping;
      destinationRef: string;
      referencedDataFolderId: DataFolderId;
    }[] = [];
    for (const tableMapping of tableMappings) {
      for (const columnMapping of tableMapping.columnMappings) {
        if (columnMapping.destination.kind !== 'placeholderField') continue;
        if (columnMapping.transformers && columnMapping.transformers.length > 0) continue;
        const referencedDataFolderId = this.foreignKeyReferencedSourceFolderIdForColumn(
          columnMapping.destination.ref,
          tableMapping,
          sourceFolderIdByRemoteTableId,
          sourceDataFolderIdByPlaceholderCreateSpecRef,
          sourceDataFolderIdByDestinationRemoteTableIdKey,
        );
        if (referencedDataFolderId) {
          foreignKeyColumns.push({
            tableMapping,
            columnMapping,
            destinationRef: columnMapping.destination.ref,
            referencedDataFolderId,
          });
        }
      }
    }
    if (foreignKeyColumns.length === 0) return;

    // Destination connector-account id per FK-carrying table, so we can ask each whether a foreignKey
    // column is a single scalar (Postgres/Supabase) or a multi-valued list (Airtable/Notion).
    const connectorAccountIdByExistingDestinationFolderId =
      await this.buildConnectorAccountIdByExistingDestinationFolderId(
        foreignKeyColumns.map(({ tableMapping }) => tableMapping),
      );
    const destinationSupportsManyToManyByConnectorAccountId = new Map<string, boolean>();
    let changed = false;
    for (const { tableMapping, columnMapping, destinationRef, referencedDataFolderId } of foreignKeyColumns) {
      const sourceContext = await this.resolveSourceContext(
        tableMapping.source.dataFolderId,
        sourceContextByFolderId,
        actor,
      );
      const extraction = sourceContext
        ? foreignKeyIdExtractionTransformer(sourceContext, columnMapping.source.columnId)
        : null;
      // A destination whose foreignKey is a single scalar column (Postgres/Supabase, whose FK references
      // one primary key) can't hold an array of linked ids: writing one fails at publish (an empty list
      // serializes to the `{}` array literal a `uuid` column rejects; a non-empty list overflows a scalar).
      // So emit `single` — the first resolved id crosses, the rest are dropped — and `array` only where the
      // destination genuinely holds a list. (TODO: warn the user that the extra links are dropped; and,
      // longer term, model a multi-valued destination association as its own join table.)
      const destinationSupportsManyToMany = await this.destinationSupportsManyToManyForeignKeys(
        workbookId,
        tableMapping,
        connectorAccountIdByExistingDestinationFolderId,
        destinationSupportsManyToManyByConnectorAccountId,
        actor,
      );
      const outputType = destinationSupportsManyToMany ? 'array' : 'single';
      const transformers: TransformerConfig[] = [];
      if (extraction) transformers.push(extraction);
      transformers.push({
        type: TransformerTypes.SourceFkToDestFk,
        options: { referencedDataFolderId, outputType },
      });
      // `source_fk_to_dest_fk` emits a RAW id array (ids and/or `@/…` pseudo-refs) — the
      // native link shape for a service like Airtable, but not for one whose link field is
      // an envelope (Notion relation: `{ type: 'relation', relation: [{ id }] }`). Append the
      // created destination field's declared pack (its `x-scratch-suggested-in-transformer`
      // hint) so the resolved ids land in the field's native shape; a connector whose link
      // field IS the raw array declares no pack and nothing is appended (DEV-10942).
      // Best-effort: a failed destination-schema fetch skips the pack rather than failing
      // materialize — matching this pass's overall stance.
      try {
        const destinationFields = await this.resolveMaterializedDestinationFieldsCached(
          workbookId,
          tableMapping,
          destinationFieldsByTableMappingRef,
          actor,
        );
        const createdFieldTarget = this.resolveCreatedFieldTarget(destinationRef, tableMapping);
        const destinationField =
          destinationFields && createdFieldTarget
            ? findCreatedDestinationField(destinationFields, createdFieldTarget)
            : undefined;
        if (destinationField?.suggestedInTransformer) {
          transformers.push(destinationField.suggestedInTransformer);
        }
      } catch (error) {
        WSLogger.warn({
          source: 'SyncDraftService.materialize',
          message: 'Failed to resolve the destination pack for a foreignKey column; leaving the raw id pipeline',
          draftId,
          tableMappingRef: tableMapping.ref,
          columnRef: destinationRef,
          error: errorMessage(error),
        });
      }
      columnMapping.transformers = transformers;
      changed = true;
    }
    if (changed) await this.persistTableMappings(draftId, tableMappings);
  }

  /**
   * {@link materializedDestinationFields} memoized per table mapping `ref` — shared by the
   * FK-transformer pass and the transform-picking pass so each destination table pays its
   * (live, for placeholder tables) schema fetch once per materialize.
   */
  private async resolveMaterializedDestinationFieldsCached(
    workbookId: WorkbookId,
    tableMapping: DraftTableMapping,
    destinationFieldsByTableMappingRef: Map<string, SchemaField[] | null>,
    actor: Actor,
  ): Promise<SchemaField[] | null> {
    const cached = destinationFieldsByTableMappingRef.get(tableMapping.ref);
    if (cached !== undefined) return cached;
    const fields = await this.materializedDestinationFields(workbookId, tableMapping, actor);
    destinationFieldsByTableMappingRef.set(tableMapping.ref, fields);
    return fields;
  }

  /**
   * `DataFolder.connectorAccountId` for each FK-carrying table whose destination is an EXISTING folder,
   * fetched in one query. Placeholder-table destinations carry their connector-account id inline, so they
   * are not looked up here. A scratch folder (no connection) maps to null.
   */
  private async buildConnectorAccountIdByExistingDestinationFolderId(
    tableMappings: DraftTableMapping[],
  ): Promise<Map<string, string | null>> {
    const existingDestinationFolderIds = [
      ...new Set(
        tableMappings
          .map((tableMapping) => tableMapping.destination)
          .filter((destination) => destination.kind === 'existing')
          .map((destination) => destination.dataFolderId),
      ),
    ];
    if (existingDestinationFolderIds.length === 0) return new Map();
    const folders = await this.db.client.dataFolder.findMany({
      where: { id: { in: existingDestinationFolderIds } },
      select: { id: true, connectorAccountId: true },
    });
    return new Map(folders.map((folder) => [folder.id, folder.connectorAccountId]));
  }

  /**
   * Whether a table mapping's DESTINATION connector can represent a many-to-many foreign key (a link
   * field holding a list of ids) rather than a single scalar FK column. Reads the connector's
   * `SchemaCreationCapabilities.supportsManyToManyForeignKeys`, cached per connector account. Absent
   * capabilities (or a scratch destination with no connection) ⇒ true, matching the create-plan
   * generator's default of "no special N→N handling".
   */
  private async destinationSupportsManyToManyForeignKeys(
    workbookId: WorkbookId,
    tableMapping: DraftTableMapping,
    connectorAccountIdByExistingDestinationFolderId: Map<string, string | null>,
    supportsManyToManyByConnectorAccountId: Map<string, boolean>,
    actor: Actor,
  ): Promise<boolean> {
    const destination = tableMapping.destination;
    const connectorAccountId =
      destination.kind === 'placeholderTable'
        ? destination.connectorAccountId
        : (connectorAccountIdByExistingDestinationFolderId.get(destination.dataFolderId) ?? null);
    if (!connectorAccountId) return true;
    const cached = supportsManyToManyByConnectorAccountId.get(connectorAccountId);
    if (cached !== undefined) return cached;
    const capabilities = await this.schemaBuilderService.getSchemaCreationCapabilitiesForConnectorAccount(
      workbookId,
      connectorAccountId,
      actor,
    );
    const supportsManyToMany = capabilities?.supportsManyToManyForeignKeys ?? true;
    supportsManyToManyByConnectorAccountId.set(connectorAccountId, supportsManyToMany);
    return supportsManyToMany;
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
      for (const candidateToken of linkedTableIdCandidateTokensForRemoteTableId(folder.tableId)) {
        if (!sourceFolderIdByRemoteTableId.has(candidateToken)) {
          sourceFolderIdByRemoteTableId.set(candidateToken, folder.id as DataFolderId);
        }
      }
    }
    return sourceFolderIdByRemoteTableId;
  }

  /**
   * Map each table mapping's DESTINATION remote table id (keyed via {@link remoteTableIdKey}) →
   * that mapping's SOURCE folder — used to resolve a foreignKey `{ existingRemoteTableId }` target
   * whose table is itself synced in this draft. A placeholder table's remote id comes from its
   * materialize writeback (`resolved.remoteTableId`, populated before this pass runs); an existing
   * destination's comes from its data folder's `tableId`, fetched in one query. First mapping wins
   * on the rare chance two mappings target the same destination table.
   */
  private async buildSourceFolderIdByDestinationRemoteTableIdKeyMap(
    tableMappings: DraftTableMapping[],
  ): Promise<Map<string, DataFolderId>> {
    const existingDestinationFolderIds = [
      ...new Set(
        tableMappings
          .map((tableMapping) => tableMapping.destination)
          .filter((destination) => destination.kind === 'existing')
          .map((destination) => destination.dataFolderId),
      ),
    ];
    const remoteTableIdByExistingDestinationFolderId = new Map<string, string[]>();
    if (existingDestinationFolderIds.length > 0) {
      const folders = await this.db.client.dataFolder.findMany({
        where: { id: { in: existingDestinationFolderIds } },
        select: { id: true, tableId: true },
      });
      for (const folder of folders) {
        remoteTableIdByExistingDestinationFolderId.set(folder.id, folder.tableId);
      }
    }

    const sourceDataFolderIdByDestinationRemoteTableIdKey = new Map<string, DataFolderId>();
    for (const tableMapping of tableMappings) {
      const destination = tableMapping.destination;
      const destinationRemoteTableId =
        destination.kind === 'placeholderTable'
          ? destination.resolved?.remoteTableId
          : remoteTableIdByExistingDestinationFolderId.get(destination.dataFolderId);
      if (!destinationRemoteTableId || destinationRemoteTableId.length === 0) continue;
      const key = remoteTableIdKey(destinationRemoteTableId);
      if (!sourceDataFolderIdByDestinationRemoteTableIdKey.has(key)) {
        sourceDataFolderIdByDestinationRemoteTableIdKey.set(key, tableMapping.source.dataFolderId as DataFolderId);
      }
    }
    return sourceDataFolderIdByDestinationRemoteTableIdKey;
  }

  /**
   * The foreignKey target a placeholderField column points at, or null when the column
   * isn't a foreignKey. Reads the created field spec the ref names — a field addition or
   * a placeholder table's create spec. The target is whichever branch the plan generator
   * or client persisted: `{ unresolvedLinkedTableId }` (a pending source link id), `{ ref }`
   * (a sibling placeholder table created in this same draft), or `{ existingRemoteTableId }`.
   */
  private foreignKeyTargetForColumn(ref: string, tableMapping: DraftTableMapping): ForeignKeyTarget | null {
    const additionSpec = tableMapping.fieldAdditions?.find((field) => field.ref === ref)?.createFieldSpec;
    const placeholderSpec =
      tableMapping.destination.kind === 'placeholderTable'
        ? tableMapping.destination.createSpec.fields.find((spec) => spec.name === ref)
        : undefined;
    const fieldType = (additionSpec ?? placeholderSpec)?.fieldType;
    return fieldType?.kind === 'foreignKey' ? fieldType.target : null;
  }

  /**
   * The draft SOURCE folder a placeholderField foreignKey column resolves its related
   * records against — the `referencedDataFolderId` for `source_fk_to_dest_fk` — or null
   * when the column isn't a resolvable-in-draft foreignKey. Both target shapes the draft
   * can carry map to the same source folder:
   *  - `{ unresolvedLinkedTableId }` — the source's own linked-table remote id, mapped
   *    via the draft source folder that pulls that remote table.
   *  - `{ ref }` — a sibling placeholder table created in this same draft; resolved to
   *    that sibling mapping's source folder (whose synced records the FK resolves against).
   *    Without this, a schema-valid `{ ref }` target was accepted at save but never got
   *    resolution transformers, so the sync published raw source ids (DEV-10954).
   *  - `{ existingRemoteTableId }` — a concrete destination table. When that table is ALSO
   *    synced by a sibling mapping in this same draft (its destination resolves to the same
   *    remote table id), resolve to that sibling's source folder — the FK IS resolvable
   *    in-draft. This is the Attio→Supabase create-destination shape: each destination table
   *    is provisioned first, so a cross-table reference is persisted as `{ existingRemoteTableId }`
   *    (not a sibling `{ ref }`); without this branch the sync published the raw source ids
   *    into the destination's real FK column and the connector rejected them. A target whose
   *    table is not synced here maps to nothing (null) — a pre-existing table with no source
   *    folder to resolve against, as before.
   */
  private foreignKeyReferencedSourceFolderIdForColumn(
    ref: string,
    tableMapping: DraftTableMapping,
    sourceFolderIdByRemoteTableId: Map<string, DataFolderId>,
    sourceDataFolderIdByPlaceholderCreateSpecRef: Map<string, DataFolderId>,
    sourceDataFolderIdByDestinationRemoteTableIdKey: Map<string, DataFolderId>,
  ): DataFolderId | null {
    const target = this.foreignKeyTargetForColumn(ref, tableMapping);
    if (!target) return null;
    if ('unresolvedLinkedTableId' in target) {
      return sourceFolderIdByRemoteTableId.get(target.unresolvedLinkedTableId) ?? null;
    }
    if ('ref' in target) {
      return sourceDataFolderIdByPlaceholderCreateSpecRef.get(target.ref) ?? null;
    }
    return sourceDataFolderIdByDestinationRemoteTableIdKey.get(remoteTableIdKey(target.existingRemoteTableId)) ?? null;
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
   * The created field a placeholder-field `ref` points at — a field addition (its
   * actual created name, plus the remote field id materialize wrote back) or a
   * placeholder table's create spec (name only; a newly-created table's per-field
   * remote ids are not stored on the draft). Mirrors {@link resolvePlaceholderFieldTarget}
   * but without the destination folder. Null when the ref is dangling.
   */
  private resolveCreatedFieldTarget(
    ref: string,
    tableMapping: DraftTableMapping,
  ): { fieldName: string; remoteFieldId?: string } | null {
    const addition = tableMapping.fieldAdditions?.find((field) => field.ref === ref);
    if (addition) {
      return {
        fieldName: addition.resolved?.actualName ?? addition.createFieldSpec.name,
        remoteFieldId: addition.resolved?.remoteFieldId,
      };
    }
    if (tableMapping.destination.kind === 'placeholderTable') {
      const field = tableMapping.destination.createSpec.fields.find((spec) => spec.name === ref);
      if (field) return { fieldName: field.name };
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
    dataFolderIdsWithFreshStoredSchema: Set<string>,
    actor: Actor,
  ): Promise<string> {
    if (destination.kind === 'existing') return destination.columnId;

    const target = this.resolvePlaceholderFieldTarget(destination.ref, tableMapping, destinationDataFolderId);
    const fields = await this.getSchemaFields(
      target.dataFolderId,
      schemaFieldsByFolderId,
      dataFolderIdsWithFreshStoredSchema,
      actor,
    );
    const match = findCreatedDestinationField(fields, target);
    if (!match) {
      throw new UnprocessableEntityException({
        error: 'SYNC_DRAFT_FIELD_RESOLUTION_FAILED',
        message: `Could not resolve created field "${target.fieldName}" (ref ${destination.ref}) to a column in the destination schema.`,
      });
    }
    return match.path;
  }

  /** A placeholder field ref resolves to a created field's name (+ remote id, for a
   * field addition) + the folder it now lives in. */
  private resolvePlaceholderFieldTarget(
    ref: string,
    tableMapping: DraftTableMapping,
    destinationDataFolderId: string,
  ): { dataFolderId: string; fieldName: string; remoteFieldId?: string } {
    const addition: DraftFieldAddition | undefined = tableMapping.fieldAdditions?.find((field) => field.ref === ref);
    if (addition) {
      return {
        dataFolderId: destinationDataFolderId,
        fieldName: addition.resolved?.actualName ?? addition.createFieldSpec.name,
        remoteFieldId: addition.resolved?.remoteFieldId,
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
    dataFolderIdsWithFreshStoredSchema: Set<string>,
    actor: Actor,
  ): Promise<SchemaField[]> {
    const cached = schemaFieldsByFolderId.get(dataFolderId);
    if (cached) return cached;
    // A folder created for a materialized placeholder table had its live schema fetched and
    // written to git by createFolder AFTER the table's fields were all created, so the
    // stored copy is already complete — read it instead of a second live connector fetch.
    // Falls through to the live fetch when the stored copy is missing (e.g. the git write
    // failed non-fatally at creation).
    if (dataFolderIdsWithFreshStoredSchema.has(dataFolderId)) {
      const storedSpec = await this.dataFolderService.getStoredSchema(dataFolderId as DataFolderId, actor);
      const storedSchema = storedSpec?.schema;
      if (storedSchema && typeof storedSchema === 'object') {
        const fields = extractSchemaFields(storedSchema as TSchema);
        schemaFieldsByFolderId.set(dataFolderId, fields);
        return fields;
      }
    }
    // Live fetch (also rewrites the git schema) so just-added fields on an EXISTING
    // destination table are reflected — createFields does not refresh git.
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
