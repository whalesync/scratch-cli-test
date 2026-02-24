import type { WorkbookId } from '@spinner/shared-types';
import type { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import type { PublishPlanRunService } from 'src/publish-plan/publish-plan-run.service';
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
    executeSinglePhase?: boolean; // If only executing a single stage
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
          onPlanProgress,
        );
        pipelineId = plan.pipelineId;
      }

      const plannedTotals = {
        editsPlanned: await getPhaseCount(pipelineId, 'edit'),
        createsPlanned: await getPhaseCount(pipelineId, 'create'),
        deletesPlanned: await getPhaseCount(pipelineId, 'delete'),
        backfillsPlanned: await getPhaseCount(pipelineId, 'backfill'),
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
          ...plannedTotals,
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
      );

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
