import type { WorkbookId } from '@spinner/shared-types';
import type { PostHogService } from 'src/posthog/posthog.service';
import type { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import type { PublishPlanRunService } from 'src/publish-plan/publish-plan-run.service';
import type { WorkbookEventService } from 'src/workbook/workbook-event.service';
import type { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { WSLogger } from '../../../logger';
import { JobCanceledError } from '../../job-errors';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress (UI-facing) ──────────────────────────────────────

export type PublishPublicProgress = {
  status: 'planning' | 'running' | 'completed' | 'failed';
  step?: string;
  currentPhase?: string;
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
  lastSyncError?: string;
  errorCount: number;
};

// ── Job Definition ───────────────────────────────────────────────────

export type PublishJobDefinition = JobDefinitionBuilder<
  'publish',
  {
    workbookId: WorkbookId;
    userId: string;
    pipelineId: string;
    connectorAccountId?: string;
    runAfterPlan?: boolean;
    folderPath?: string;
    filePath?: string;
    executeSinglePhase?: boolean; // If only executing a single stage
    trigger?: 'web' | 'scheduler' | 'cli' | 'job';
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

    try {
      const getPhaseCount = async (pipelineId: string, phase: string) =>
        this.db.client.publishPlanOperation.count({ where: { planId: pipelineId, phase } });

      let pipelineId: string;

      // If the pipeline is already planned/partially-run, skip replanning to avoid duplicate entries.
      const existingPlan = data.pipelineId
        ? await this.db.client.publishPlan.findUnique({ where: { id: data.pipelineId } })
        : null;
      // Skip replanning if the pipeline has already been planned (any status except 'planning').
      const isAlreadyPlanned = existingPlan && existingPlan.status !== 'planning';

      if (isAlreadyPlanned) {
        pipelineId = existingPlan.id;
      } else {
        const plan = await this.publishPlanService.buildPipeline(
          data.workbookId,
          data.userId,
          data.connectorAccountId,
          data.pipelineId,
          data.folderPath,
          data.filePath,
          onPlanProgress,
        );
        pipelineId = plan.pipelineId;
      }

      const plannedTotals = {
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
            editsExecuted: 0,
            createsExecuted: 0,
            deletesExecuted: 0,
            backfillsExecuted: 0,
            renameFilesExecuted: 0,
            ...plannedTotals,
            errorCount: 0,
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
      );

      await checkpoint({
        publicProgress: {
          status: 'completed',
          currentPhase: 'done',
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

      if (isCanceled) {
        // If aborted during plan, cancelPipeline is safe. The UI handles resuming.
        await this.publishPlanService.cancelPipeline(data.pipelineId);
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
