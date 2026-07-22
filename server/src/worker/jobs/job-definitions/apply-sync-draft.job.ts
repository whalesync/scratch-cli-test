import type { PrismaClient } from '@prisma/client';
import type {
  ApplySyncDraftPublicProgress,
  DraftTableMapping,
  JobTrigger,
  MaterializePlaceholderResult,
  SyncDraftId,
  WorkbookId,
} from '@spinner/shared-types';
import { JobType } from '@spinner/shared-types';
import { UserCluster } from 'src/db/cluster-types';
import { WSLogger } from 'src/logger';
import { SyncDraftService } from 'src/sync-draft/sync-draft.service';
import { Actor, userToActor } from 'src/users/types';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// Re-export the shared progress type so importers can stay on the job-definition path,
// mirroring sync-data-folders.job.
export type { ApplySyncDraftPublicProgress };

/**
 * Background "Save" of a Live Export sync draft (DEV-10875): a thin wrapper around the existing,
 * already-idempotent two-phase saga on SyncDraftService — materialize (create the draft's remote
 * tables/fields, checkpointing each success onto the draft row) then apply (create destination
 * data folders, save the Sync, archive the draft). The draft row itself is the checkpoint store,
 * so a crashed/retried job resumes convergently: materialize skips resolved placeholders, apply
 * skips folders whose dataFolderId is already recorded.
 *
 * Deliberately `attempts: 1` at the BullMQ level (the queue default): creation against external
 * services should stay deliberate, so retry is a user action (calling save again), never an
 * automatic re-run.
 */
export type ApplySyncDraftJobDefinition = JobDefinitionBuilder<
  typeof JobType.ApplySyncDraft,
  {
    workbookId: WorkbookId;
    draftId: SyncDraftId;
    userId: string;
    organizationId: string;
    /** Threaded through to apply: also generate a routine file for the created sync (best-effort). */
    createRoutine: boolean;
    trigger?: JobTrigger;
  },
  ApplySyncDraftPublicProgress,
  Record<string, never>, // jobProgress - empty
  void
>;

/** All placeholder refs (tables + field additions) a draft wants created, and which are already resolved. */
function collectPlaceholderRefs(tableMappings: DraftTableMapping[]): {
  allPlaceholderRefs: string[];
  alreadyResolvedRefs: string[];
} {
  const allPlaceholderRefs: string[] = [];
  const alreadyResolvedRefs: string[] = [];
  for (const tableMapping of tableMappings) {
    if (tableMapping.destination.kind === 'placeholderTable') {
      allPlaceholderRefs.push(tableMapping.destination.ref);
      if (tableMapping.destination.resolved?.remoteTableId) alreadyResolvedRefs.push(tableMapping.destination.ref);
    }
    for (const addition of tableMapping.fieldAdditions ?? []) {
      allPlaceholderRefs.push(addition.ref);
      if (addition.resolved?.remoteFieldId) alreadyResolvedRefs.push(addition.ref);
    }
  }
  return { allPlaceholderRefs, alreadyResolvedRefs };
}

export class ApplySyncDraftJobHandler implements JobHandlerBuilder<ApplySyncDraftJobDefinition> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly syncDraftService: SyncDraftService,
    private readonly workbookEventService: WorkbookEventService,
  ) {}

  async run(params: {
    jobId: string;
    data: ApplySyncDraftJobDefinition['data'];
    progress: Progress<
      ApplySyncDraftJobDefinition['publicProgress'],
      ApplySyncDraftJobDefinition['initialJobProgress']
    >;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<ApplySyncDraftJobDefinition['publicProgress'], ApplySyncDraftJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }): Promise<void> {
    const { jobId, data, checkpoint } = params;
    const { draftId, workbookId } = data;

    WSLogger.info({
      source: 'ApplySyncDraftJob',
      message: 'Starting apply-sync-draft (background save) job',
      draftId,
      workbookId,
      userId: data.userId,
    });

    this.workbookEventService.sendWorkbookEvent(workbookId, {
      type: 'job-started',
      data: { source: 'job', entityId: draftId, message: 'Saving sync', jobId },
    });

    try {
      // Reload the user to populate workspacePermissions on the actor — the queue payload only
      // carries userId/organizationId, but materialize/apply run assertWritableWorkbook, which
      // requires the permissions list. Mirrors sync-data-folders.job.
      const user = await this.prisma.user.findUnique({
        where: { id: data.userId },
        include: UserCluster._validator.include,
      });
      if (!user) {
        throw new Error(`User ${data.userId} not found`);
      }
      const actor: Actor = userToActor(user);

      // Seed the counters from the draft row so a resumed save starts at its checkpoint
      // ("14 of 23 already created"), not at zero.
      const draftRow = await this.prisma.syncDraft.findUnique({ where: { id: draftId } });
      if (!draftRow) {
        throw new Error(`Sync draft ${draftId} not found`);
      }
      const tableMappings = (draftRow.tableMappings ?? []) as unknown as DraftTableMapping[];
      const { allPlaceholderRefs, alreadyResolvedRefs } = collectPlaceholderRefs(tableMappings);

      const totalPlaceholders = allPlaceholderRefs.length;
      const resolvedRefs = new Set<string>(alreadyResolvedRefs);
      let failedRefs: ApplySyncDraftPublicProgress['failedRefs'] = [];
      let phase: ApplySyncDraftPublicProgress['phase'] = 'materializing_tables';

      const checkpointCurrentProgress = async (syncId?: string) => {
        await checkpoint({
          publicProgress: {
            phase,
            totalPlaceholders,
            resolvedPlaceholders: resolvedRefs.size,
            failedRefs,
            ...(syncId ? { syncId } : {}),
          },
          jobProgress: {},
          connectorProgress: {},
        });
      };

      await checkpointCurrentProgress();

      // Phase 1: materialize. The per-table callback ticks the running count as EACH table lands
      // inside a creation batch (the long single-base case would otherwise jump 0 → N at batch
      // end); the batch callback then delivers the authoritative per-ref results, including
      // failures. A batch-callback checkpoint throw (cancellation) propagates out of materialize
      // and fails the job; the per-table observer is best-effort (throws are swallowed upstream).
      const materializeResponse = await this.syncDraftService.materialize(draftId, actor, {
        calledByActiveSaveJob: true,
        onPlaceholderCreatedInBatch: async (placeholderRef: string) => {
          phase = 'materializing_tables';
          resolvedRefs.add(placeholderRef);
          await checkpointCurrentProgress();
        },
        onBatchProgress: async (
          materializePhase: 'tables' | 'fields',
          cumulativeResults: MaterializePlaceholderResult[],
        ) => {
          phase = materializePhase === 'tables' ? 'materializing_tables' : 'materializing_fields';
          for (const result of cumulativeResults) {
            if (result.status !== 'failed') resolvedRefs.add(result.ref);
          }
          failedRefs = cumulativeResults
            .filter((result) => result.status === 'failed')
            .map((result) => ({ ref: result.ref, error: result.error ?? 'Creation failed' }));
          await checkpointCurrentProgress();
        },
      });

      // Fold the final per-ref results into the counters too (not just the batch callbacks), so
      // the terminal progress is correct even for refs whose batch produced no callback.
      for (const result of materializeResponse.results) {
        if (result.status !== 'failed') resolvedRefs.add(result.ref);
      }

      // Any placeholder still unresolved ⇒ the draft cannot apply. Fail the job with the per-ref
      // errors already in publicProgress; retrying the save skips everything that DID resolve.
      const failedResults = materializeResponse.results.filter((result) => result.status === 'failed');
      if (failedResults.length > 0) {
        failedRefs = failedResults.map((result) => ({ ref: result.ref, error: result.error ?? 'Creation failed' }));
        await checkpointCurrentProgress();
        throw new Error(
          `Failed to create ${failedResults.length} of ${totalPlaceholders} tables/fields on the destination: ` +
            failedResults.map((result) => `${result.ref}: ${result.error ?? 'Creation failed'}`).join('; '),
        );
      }

      // Phase 2: apply — creates destination data folders, saves the sync, archives the draft.
      phase = 'creating_folders';
      await checkpointCurrentProgress();
      const sync = await this.syncDraftService.apply(draftId, actor, {
        createRoutine: data.createRoutine,
        calledByActiveSaveJob: true,
        onPhaseChange: async (applyPhase: 'creating_folders' | 'saving_sync') => {
          phase = applyPhase;
          await checkpointCurrentProgress();
        },
      });

      phase = 'done';
      await checkpointCurrentProgress(sync.id);
      await this.clearActiveSaveJobIdForThisJob(jobId, draftId);

      this.workbookEventService.sendWorkbookEvent(workbookId, {
        type: 'job-completed',
        data: { source: 'job', entityId: draftId, message: 'Sync saved', jobId },
      });

      WSLogger.info({
        source: 'ApplySyncDraftJob',
        message: 'Completed apply-sync-draft job',
        draftId,
        workbookId,
        syncId: sync.id,
        totalPlaceholders,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      WSLogger.error({
        source: 'ApplySyncDraftJob',
        message: 'Apply-sync-draft job failed',
        draftId,
        workbookId,
        error: errorMessage,
      });
      // The draft's activeSaveJobId must not outlive the job — a stale id would make the client
      // reopen a dead progress view. Best-effort: a stale id is also self-healing (save() checks
      // the referenced job's state), so a failed clear is logged, not rethrown over the real error.
      await this.clearActiveSaveJobIdForThisJob(jobId, draftId).catch((clearError) => {
        WSLogger.warn({
          source: 'ApplySyncDraftJob',
          message: 'Failed to clear activeSaveJobId after job failure',
          draftId,
          error: clearError instanceof Error ? clearError.message : 'Unknown error',
        });
      });
      this.workbookEventService.sendWorkbookEvent(workbookId, {
        type: 'job-failed',
        data: { source: 'job', entityId: draftId, message: `Saving sync failed: ${errorMessage}`, jobId },
      });
      throw error;
    }
  }

  /**
   * Clear the draft's `activeSaveJobId` if it still points at THIS job. The draft stores the BullMQ
   * job id (what clients poll), while the handler only knows its DbJob id — resolve one from the
   * other via the DbJob row.
   */
  private async clearActiveSaveJobIdForThisJob(dbJobId: string, draftId: SyncDraftId): Promise<void> {
    const dbJobRow = await this.prisma.dbJob.findUnique({ where: { id: dbJobId }, select: { bullJobId: true } });
    if (!dbJobRow?.bullJobId) return;
    await this.syncDraftService.clearActiveSaveJobIdIfOwnedByJob(draftId, dbJobRow.bullJobId);
  }
}
