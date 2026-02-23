import type { WorkbookId } from '@spinner/shared-types';
import type { PublishPlanService } from 'src/publish-pipeline/publish-plan.service';
import type { PublishRunService } from 'src/publish-pipeline/publish-run.service';
import type { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { WSLogger } from '../../../logger';
import { JobCanceledError } from '../../bull-worker.service';
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
  editsPlanned: number;
  createsPlanned: number;
  deletesPlanned: number;
  backfillsPlanned: number;
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
    phase?: string; // If resuming a specific phase
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
    private readonly publishPlanService: PublishPlanService,
    private readonly publishRunService: PublishRunService,
    private readonly bullEnqueuerService?: BullEnqueuerService,
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

    const zeroCounts = {
      editsExecuted: 0,
      createsExecuted: 0,
      deletesExecuted: 0,
      backfillsExecuted: 0,
      editsPlanned: 0,
      createsPlanned: 0,
      deletesPlanned: 0,
      backfillsPlanned: 0,
    };

    // Report initial progress
    await checkpoint({
      publicProgress: {
        status: 'planning',
        ...zeroCounts,
      },
      jobProgress: {},
      connectorProgress: {},
    });

    const onPlanProgress = async (counts: {
      editsPlanned: number;
      createsPlanned: number;
      deletesPlanned: number;
      backfillsPlanned: number;
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
        },
        jobProgress: {},
        connectorProgress: {},
      });
    };

    const onRunProgress = async (counts: {
      editsExecuted: number;
      createsExecuted: number;
      deletesExecuted: number;
      backfillsExecuted: number;
      editsPlanned: number;
      createsPlanned: number;
      deletesPlanned: number;
      backfillsPlanned: number;
      currentPhase: string;
    }) => {
      await checkpoint({
        publicProgress: { status: 'running', ...counts },
        jobProgress: {},
        connectorProgress: {},
      });
    };

    try {
      const plan = await this.publishPlanService.buildPipeline(
        data.workbookId,
        data.userId,
        data.connectorAccountId,
        data.pipelineId,
        onPlanProgress,
      );

      const pipelineId = plan.pipelineId;
      const plannedTotals = {
        editsPlanned: plan.phases?.find((p) => p.type === 'edit')?.recordCount ?? 0,
        createsPlanned: plan.phases?.find((p) => p.type === 'create')?.recordCount ?? 0,
        deletesPlanned: plan.phases?.find((p) => p.type === 'delete')?.recordCount ?? 0,
        backfillsPlanned: plan.phases?.find((p) => p.type === 'backfill')?.recordCount ?? 0,
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
            ...plannedTotals,
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

      // Proceed into the RUN phase immediately within the same job context
      WSLogger.info({
        source: 'PublishJob',
        message: 'runAfterPlan=true, transitioning to run phase',
        workbookId: data.workbookId,
        jobId,
        pipelineId,
      });

      await checkpoint({
        publicProgress: {
          status: 'running',
          currentPhase: 'starting',
          editsExecuted: 0,
          createsExecuted: 0,
          deletesExecuted: 0,
          backfillsExecuted: 0,
          ...plannedTotals,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      // Run it
      const runResult = await this.publishRunService.runPipeline(pipelineId, data.phase, abortSignal, onRunProgress);

      await checkpoint({
        publicProgress: {
          status: 'completed',
          currentPhase: 'done',
          editsExecuted: runResult.successByPhase?.edit ?? 0,
          createsExecuted: runResult.successByPhase?.create ?? 0,
          deletesExecuted: runResult.successByPhase?.delete ?? 0,
          backfillsExecuted: runResult.successByPhase?.backfill ?? 0,
          editsPlanned: runResult.totalByPhase?.edit ?? 0,
          createsPlanned: runResult.totalByPhase?.create ?? 0,
          deletesPlanned: runResult.totalByPhase?.delete ?? 0,
          backfillsPlanned: runResult.totalByPhase?.backfill ?? 0,
        },
        jobProgress: {},
        connectorProgress: {},
      });

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
