import {
  type JobTrigger,
  JobType,
  type PublishOrigin,
  type PublishPublicProgress,
  type WorkbookId,
} from '@spinner/shared-types';
import type { PostHogService } from 'src/posthog/posthog.service';
import { PublishDirtyDriftError, type PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import type { PublishPlanRunService } from 'src/publish-plan/publish-plan-run.service';
import { getServiceDisplayName } from 'src/remote-service/connectors/display-names';
import type { WorkbookEventService } from 'src/workbook/workbook-event.service';
import type { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { WSLogger } from '../../../logger';
import { JobCanceledError } from '../../job-errors';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress (UI-facing) ──────────────────────────────────────

// `PublishPublicProgress` now lives in `@spinner/shared-types` so the web client, desktop app, and
// CLI render it without a shadow copy. Re-exported here so existing `from '...publish.job'` importers
// are unchanged.
export type { PublishPublicProgress };

// ── Job Definition ───────────────────────────────────────────────────

export type PublishJobDefinition = JobDefinitionBuilder<
  typeof JobType.Publish,
  {
    workbookId: WorkbookId;
    userId: string;
    /**
     * The PublishPlan to plan/run. Omitted for a "self-planning" publish job
     * (DEV-10436, routines): when empty, the handler creates its own pipeline via
     * `createPipeline()` instead of relying on a caller to pre-create one.
     */
    pipelineId?: string;
    connectorAccountId?: string;
    runAfterPlan?: boolean;
    folderPath?: string;
    filePath?: string;
    /** DEV-10316 TOCTOU token — see PublishPlanBuildDto.expectedBaseDirtyHead. */
    expectedBaseDirtyHead?: string;
    executeSinglePhase?: boolean; // If only executing a single stage
    /**
     * Surface that initiated the publish; routes a record's *failed* edit during
     * the post-publish reconcile (`'desktop'` strips failed paths from server
     * `dirty`; `'web'` keeps them). Set on the explicit run-job; absent (the
     * `runAfterPlan` web path and legacy callers) ⇒ `'web'`. See PublishOrigin.
     */
    publishOrigin?: PublishOrigin;
    trigger?: JobTrigger;
  },
  PublishPublicProgress,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {}, // No checkpoint state needed — planning is single operation, db is checkpoint for running
  void
>;

// ── Handler ──────────────────────────────────────────────────────────

// ── Handler ──────────────────────────────────────────────────────────

export class PublishJobHandler implements JobHandlerBuilder<PublishJobDefinition> {
  constructor(
    private readonly publishPlanService: PublishPlanBuildService,
    private readonly publishRunService: PublishPlanRunService,
    private readonly db: import('src/db/db.service').DbService,
    private readonly workbookEventService: WorkbookEventService,
    private readonly bullEnqueuerService?: BullEnqueuerService,
    private readonly postHogService?: PostHogService,
  ) {}

  async run(params: {
    jobId: string;
    data: PublishJobDefinition['data'];
    progress: Progress<PublishJobDefinition['publicProgress'], PublishJobDefinition['initialJobProgress']>;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<PublishJobDefinition['publicProgress'], PublishJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint, abortSignal } = params;

    WSLogger.info({
      source: 'PublishJob',
      message: 'Starting publish job',
      workbookId: data.workbookId,
      jobId,
    });
    console.log(
      `[DEBUG Worker] PublishJobHandler running with filePath: ${data.filePath}, folderPath: ${data.folderPath}`,
    );

    const zeroCounts = {
      assetUploadsExecuted: 0,
      assetUploadsPlanned: 0,
      editsExecuted: 0,
      createsExecuted: 0,
      deletesExecuted: 0,
      backfillsExecuted: 0,
      renameFilesExecuted: 0,
      editsPlanned: 0,
      createsPlanned: 0,
      deletesPlanned: 0,
      backfillsPlanned: 0,
      renameFilesPlanned: 0,
      errorCount: 0,
    };

    const onPlanProgress = async (counts: {
      assetUploadsPlanned: number;
      editsPlanned: number;
      createsPlanned: number;
      deletesPlanned: number;
      backfillsPlanned: number;
      renameFilesPlanned: number;
      step?: string;
    }) => {
      await checkpoint({
        publicProgress: {
          status: 'planning',
          step: counts.step,
          ...zeroCounts,
          assetUploadsPlanned: counts.assetUploadsPlanned,
          editsPlanned: counts.editsPlanned,
          createsPlanned: counts.createsPlanned,
          deletesPlanned: counts.deletesPlanned,
          backfillsPlanned: counts.backfillsPlanned,
          renameFilesPlanned: counts.renameFilesPlanned,
        },
        jobProgress: {},
        connectorProgress: {},
      });
    };

    let latestErrorInfo: { lastSyncError?: string; errorCount: number } = { errorCount: 0 };

    const onRunProgress = async (counts: {
      assetUploadsExecuted: number;
      assetUploadsPlanned: number;
      editsExecuted: number;
      createsExecuted: number;
      deletesExecuted: number;
      backfillsExecuted: number;
      renameFilesExecuted: number;
      editsPlanned: number;
      createsPlanned: number;
      deletesPlanned: number;
      backfillsPlanned: number;
      renameFilesPlanned: number;
      currentPhase: string;
    }) => {
      await checkpoint({
        publicProgress: { status: 'running', ...counts, ...latestErrorInfo },
        jobProgress: {},
        connectorProgress: {},
      });
    };

    const onError = (errorInfo: { lastSyncError: string; errorCount: number }) => {
      latestErrorInfo = errorInfo;
    };

    // The resolved PublishPlan id. Hoisted out of the try so the catch block can cancel
    // the right pipeline — including one this job creates itself (self-planning).
    let pipelineId: string | undefined;

    try {
      const getPhaseCount = async (planId: string, phase: string) =>
        this.db.client.publishPlanOperation.count({ where: { planId, phase } });

      // The plan this job will work on, however it was resolved (caller-supplied, adopted
      // from an earlier delivery of this same job, or created fresh below).
      let existingPlan = data.pipelineId
        ? await this.db.client.publishPlan.findUnique({ where: { id: data.pipelineId } })
        : null;

      if (!data.pipelineId) {
        // Self-planning publish (DEV-10436, routines): no caller pre-created a pipeline
        // (the UI/CLI/scheduler create one up front so they can navigate to it
        // immediately; a routine step has no such need).
        //
        // activeJobId stores the BullMQ job id (consumers look up the DbJob via
        // `where: { bullJobId: activeJobId }`), but params.jobId is the DbJob id — so
        // resolve our own bullJobId from the DbJob row the enqueuer already created.
        // Read BEFORE planning (DEV-11254): it is both the resume key below and the
        // value stamped onto a newly created plan.
        const selfDbJob = await this.db.client.dbJob.findUnique({
          where: { id: jobId },
          select: { bullJobId: true },
        });
        const selfBullJobId = selfDbJob?.bullJobId;

        // DEV-11254: a stalled job is redelivered by BullMQ under its ORIGINAL id, and
        // re-enters here with the same (empty) `pipelineId`. Without this lookup it
        // created a SECOND plan and replanned from scratch, abandoning everything the
        // first delivery had already published — prod run `rrn_I7VfxGpZ38` stranded
        // 47,179 successful operations that way, then died replanning them. Adopt the
        // live plan this job already owns; only plan fresh when there isn't one.
        const resumablePlan = selfBullJobId
          ? await this.publishPlanService.findResumablePlanForJob(data.workbookId, selfBullJobId)
          : null;

        if (resumablePlan) {
          existingPlan = resumablePlan;
          pipelineId = resumablePlan.id;

          WSLogger.info({
            source: 'PublishJob',
            message: 'Resuming the publish plan this job already created (redelivered job)',
            workbookId: data.workbookId,
            data: { pipelineId, bullJobId: selfBullJobId, planStatus: resumablePlan.status },
          });
        } else {
          const created = await this.publishPlanService.createPipeline(
            data.workbookId,
            data.userId,
            data.connectorAccountId,
          );
          pipelineId = created.pipelineId;

          // Link the running job back to the new pipeline (the 3rd call of the caller's
          // createPipeline → enqueue → setActiveJob shape, relocated into the job).
          // Gated on the self-planning case so existing callers (which set activeJobId
          // themselves) are untouched and we never double-write it. This is also what
          // makes the plan findable by the resume lookup above on a later delivery.
          if (selfBullJobId) {
            await this.publishPlanService.setActiveJob(pipelineId, selfBullJobId);
          }
        }
      }

      // Whether the plan is finished being built and can go straight to execution — any status
      // except `planning`. Covers both a caller-supplied pipeline and an adopted one: a
      // redelivered job whose plan reached a run phase skips replanning entirely, and its
      // per-operation `success` rows make the remaining work self-evident.
      let planIsAlreadyBuilt = Boolean(existingPlan) && existingPlan?.status !== 'planning';

      // DEV-11254: about to plan into a row that ALREADY EXISTED, which means an earlier
      // delivery of this job may have died mid-build. `buildPipeline` appends operations in
      // chunks and only flips the status off `planning` at the very end, so a partial set can
      // be sitting here — and it appends rather than replaces, so replanning would queue the
      // same record twice in one phase and publish it twice. Drop the partial set first.
      //
      // Covers BOTH redelivery paths: a web/CLI/desktop job carries its caller's `pipelineId`
      // across a redelivery and lands here identically. Skipped when `existingPlan` is null —
      // a plan this job just created has no operations to clear.
      if (existingPlan && !planIsAlreadyBuilt) {
        const clearResult = await this.publishPlanService.clearOperationsForReplan(existingPlan.id);

        if (clearResult.outcome === 'plan-advanced' && clearResult.clearedOperationCount > 0) {
          // We deleted rows — which proves the plan was still `planning` when the DELETE ran —
          // and another delivery advanced it immediately afterwards. Those two events can only
          // interleave in the window between that delivery's last operation insert and its
          // final `status = planned` update, so the operations it had built up to our delete
          // are GONE and what remains is a suffix at best.
          //
          // Running it would publish a fraction of the records and checkpoint `completed`:
          // a silent under-publish, the one outcome worse than failing. Cancel the plan so
          // nothing else can run it (canceled is terminal, so the resume lookup skips it and
          // `runPipeline` refuses it) and fail loudly. The next publish plans fresh.
          //
          // The catch below only cancels for drift/cancel errors, so cancel explicitly here.
          await this.publishPlanService.cancelPipeline(existingPlan.id);
          WSLogger.error({
            source: 'PublishJob',
            message: 'Concurrent deliveries left the publish plan incomplete — canceled it rather than under-publish',
            workbookId: data.workbookId,
            jobId,
            data: {
              pipelineId: existingPlan.id,
              planStatus: clearResult.status,
              clearedOperationCount: clearResult.clearedOperationCount,
            },
          });
          throw new Error(
            `Publish aborted: another delivery of this job finished planning while this one cleared ` +
              `${clearResult.clearedOperationCount} operation(s), leaving plan ${existingPlan.id} incomplete. ` +
              'The plan was canceled — re-run the publish to build a fresh one.',
          );
        }

        if (clearResult.outcome === 'plan-advanced') {
          // Nothing was deleted, so the other delivery's plan is intact — it simply finished
          // the build first. Run it rather than rebuilding on top of it.
          planIsAlreadyBuilt = true;
          WSLogger.warn({
            source: 'PublishJob',
            message: 'Another delivery of this job finished planning first — running its plan instead of replanning',
            workbookId: data.workbookId,
            data: { pipelineId: existingPlan.id, planStatus: clearResult.status },
          });
        } else if (clearResult.outcome === 'cleared' && clearResult.clearedOperationCount > 0) {
          WSLogger.info({
            source: 'PublishJob',
            message: 'Cleared a partially-built operation set before replanning',
            workbookId: data.workbookId,
            data: { pipelineId: existingPlan.id, clearedOperationCount: clearResult.clearedOperationCount },
          });
        }
        // `plan-missing` falls through to buildPipeline, which reports it as the missing
        // pipeline it is rather than surfacing a confusing error from the clear.
      }

      if (planIsAlreadyBuilt && existingPlan) {
        pipelineId = existingPlan.id;
      } else {
        const plan = await this.publishPlanService.buildPipeline(
          data.workbookId,
          data.userId,
          data.connectorAccountId,
          // Self-created id for a self-planning job, otherwise the caller's id. Always
          // set here, so buildPipeline reuses this 'planning' row rather than taking its
          // own inline-create branch.
          pipelineId ?? data.pipelineId,
          data.folderPath,
          data.filePath,
          data.expectedBaseDirtyHead,
          onPlanProgress,
        );
        pipelineId = plan.pipelineId;
      }

      const plannedTotals = {
        assetUploadsPlanned: await getPhaseCount(pipelineId, 'asset-upload'),
        editsPlanned: await getPhaseCount(pipelineId, 'edit'),
        createsPlanned: await getPhaseCount(pipelineId, 'create'),
        deletesPlanned: await getPhaseCount(pipelineId, 'delete'),
        backfillsPlanned: await getPhaseCount(pipelineId, 'backfill'),
        renameFilesPlanned: await getPhaseCount(pipelineId, 'rename-files'),
      };

      if (!data.runAfterPlan) {
        // Complete the plan job, we don't proceed to run
        await checkpoint({
          publicProgress: {
            status: 'completed',
            assetUploadsExecuted: 0,
            editsExecuted: 0,
            createsExecuted: 0,
            deletesExecuted: 0,
            backfillsExecuted: 0,
            renameFilesExecuted: 0,
            ...plannedTotals,
            errorCount: 0,
            pipelineId,
          },
          jobProgress: {},
          connectorProgress: {},
        });

        WSLogger.info({
          source: 'PublishJob',
          message: 'Publish plan job completed (runAfterPlan=false)',
          workbookId: data.workbookId,
          jobId,
          pipelineId,
        });
        return;
      }

      // Proceed into the RUN phase
      WSLogger.info({
        source: 'PublishJob',
        message: 'Transitioning to run phase',
        workbookId: data.workbookId,
        jobId,
        pipelineId,
      });

      const getSuccessCount = async (phase: string) =>
        this.db.client.publishPlanOperation.count({ where: { planId: pipelineId, phase, status: 'success' } });

      await checkpoint({
        publicProgress: {
          status: 'running',
          currentPhase: 'starting',
          assetUploadsExecuted: await getSuccessCount('asset-upload'),
          editsExecuted: await getSuccessCount('edit'),
          createsExecuted: await getSuccessCount('create'),
          deletesExecuted: await getSuccessCount('delete'),
          backfillsExecuted: await getSuccessCount('backfill'),
          renameFilesExecuted: await getSuccessCount('rename-files'),
          ...plannedTotals,
          errorCount: 0,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      // Run it
      const runResult = await this.publishRunService.runPipeline(
        pipelineId,
        data.executeSinglePhase,
        abortSignal,
        onRunProgress,
        onError,
        data.publishOrigin,
      );

      // Resolve the destination service's display name so the terminal checkpoint can attribute any
      // per-record rejections to the service that rejected them ("… rejected by PostgreSQL").
      const planConnectorAccount = await this.db.client.publishPlan.findUnique({
        where: { id: pipelineId },
        select: { connectorAccount: { select: { service: true } } },
      });
      const destinationServiceName = planConnectorAccount?.connectorAccount
        ? getServiceDisplayName(planConnectorAccount.connectorAccount.service)
        : undefined;

      await checkpoint({
        publicProgress: {
          status: 'completed',
          currentPhase: 'done',
          assetUploadsExecuted: runResult.successByPhase?.['asset-upload'] ?? 0,
          assetUploadsPlanned: runResult.totalByPhase?.['asset-upload'] ?? 0,
          editsExecuted: runResult.successByPhase?.edit ?? 0,
          createsExecuted: runResult.successByPhase?.create ?? 0,
          deletesExecuted: runResult.successByPhase?.delete ?? 0,
          backfillsExecuted: runResult.successByPhase?.backfill ?? 0,
          renameFilesExecuted: runResult.successByPhase?.['rename-files'] ?? 0,
          editsPlanned: runResult.totalByPhase?.edit ?? 0,
          createsPlanned: runResult.totalByPhase?.create ?? 0,
          deletesPlanned: runResult.totalByPhase?.delete ?? 0,
          backfillsPlanned: runResult.totalByPhase?.backfill ?? 0,
          renameFilesPlanned: runResult.totalByPhase?.['rename-files'] ?? 0,
          ...latestErrorInfo,
          // DEV-10243: surface per-row connector rejections (failed-batch) so the
          // CLI/desktop don't read this terminal `completed` checkpoint as a clean
          // success. `failedCount` is the count; `failedOperations` carries the
          // connector's own per-record message (the actionable "why", e.g.
          // Pipedrive's "'person_id' is a read-only field…") so the desktop/CLI
          // show why a record failed, not just that something did.
          failedCount: runResult.failedCount ?? 0,
          failedOperations: runResult.failedOperations ?? [],
          destinationServiceName,
          pipelineId,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      this.workbookEventService.sendWorkbookEvent(data.workbookId, {
        type: 'changes-published',
        data: {
          source: 'job',
          entityId: data.workbookId,
          message: 'Publish completed',
          jobId,
        },
      });

      try {
        const totalRecordsPushed =
          (runResult.successByPhase?.create ?? 0) +
          (runResult.successByPhase?.edit ?? 0) +
          (runResult.successByPhase?.delete ?? 0);
        this.postHogService?.trackPublishCompleted(data.userId, {
          workbookId: data.workbookId,
          trigger: data.trigger,
          result: 'success',
          totalRecordsPushed,
          creates: runResult.successByPhase?.create ?? 0,
          edits: runResult.successByPhase?.edit ?? 0,
          deletes: runResult.successByPhase?.delete ?? 0,
        });
      } catch (err) {
        WSLogger.warn({
          source: 'PublishJob',
          message: 'Failed to track publish completed event',
          error: err,
        });
      }

      WSLogger.info({
        source: 'PublishJob',
        message: 'Publish run phase completed',
        workbookId: data.workbookId,
        jobId,
        pipelineId,
      });
    } catch (error) {
      const isCanceled = error instanceof JobCanceledError || abortSignal.aborted;

      if (error instanceof PublishDirtyDriftError) {
        // DEV-10316 publish-time TOCTOU abort. The dirty branch drifted past the
        // client's `expectedBaseDirtyHead` since upload (the web sync staged
        // changes while the user reviewed). Discard the half-built pipeline and
        // surface a structured `blockedDirtyDrift` discriminator on the job's
        // progress so the desktop routes into its count-only `dirty` redirect
        // (with the "server changed while you were reviewing" lead) rather than a
        // generic failure. The job still ends `failed` (we re-throw) so it never
        // proceeds to a run phase.
        if (pipelineId) await this.publishPlanService.cancelPipeline(pipelineId);
        await checkpoint({
          publicProgress: {
            status: 'failed',
            ...zeroCounts,
            blockedDirtyDrift: { connectorAccountId: error.connectorAccountId, dirtyCount: error.dirtyCount },
            ...(pipelineId && { pipelineId }),
          },
          jobProgress: {},
          connectorProgress: {},
        });
        try {
          this.postHogService?.trackPublishAbortedDirtyDrift(data.userId, {
            workbookId: data.workbookId,
            connectorAccountId: error.connectorAccountId,
            dirtyCount: error.dirtyCount,
          });
        } catch {
          // PostHog tracking should never break the error flow.
        }
        WSLogger.warn({
          source: 'PublishJob',
          message: 'Publish job aborted — dirty HEAD drifted since upload (DEV-10316)',
          workbookId: data.workbookId,
          jobId,
          data: { connectorAccountId: error.connectorAccountId, dirtyCount: error.dirtyCount },
        });
      } else if (isCanceled) {
        // If aborted during plan, cancelPipeline is safe. The UI handles resuming.
        if (pipelineId) await this.publishPlanService.cancelPipeline(pipelineId);
        WSLogger.warn({
          source: 'PublishJob',
          message: 'Publish job canceled',
          workbookId: data.workbookId,
          jobId,
        });
      } else {
        await checkpoint({
          publicProgress: {
            status: 'failed',
            ...zeroCounts,
            ...(pipelineId && { pipelineId }),
          },
          jobProgress: {},
          connectorProgress: {},
        });

        try {
          this.postHogService?.trackPublishCompleted(data.userId, {
            workbookId: data.workbookId,
            trigger: data.trigger,
            result: 'failure',
            totalRecordsPushed: 0,
            creates: 0,
            edits: 0,
            deletes: 0,
          });
        } catch {
          // PostHog tracking should never break the error flow
        }

        WSLogger.error({
          source: 'PublishJob',
          message: 'Publish job failed',
          workbookId: data.workbookId,
          jobId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      throw error;
    }
  }
}
