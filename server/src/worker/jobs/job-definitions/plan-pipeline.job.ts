import type { WorkbookId } from '@spinner/shared-types';
import { PublishPlanService } from 'src/publish-pipeline/publish-plan.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress (UI-facing) ──────────────────────────────────────

export type PlanPipelinePublicProgress = {
  status: 'planning' | 'completed' | 'failed';
  step?: string;
  editsPlanned: number;
  createsPlanned: number;
  deletesPlanned: number;
  backfillsPlanned: number;
};

// ── Job Definition ───────────────────────────────────────────────────

export type PlanPipelineJobDefinition = JobDefinitionBuilder<
  'plan-pipeline',
  {
    workbookId: WorkbookId;
    userId: string;
    pipelineId: string;
    connectorAccountId?: string;
  },
  PlanPipelinePublicProgress,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {}, // No checkpoint state needed — planning is a single operation
  void
>;

// ── Handler ──────────────────────────────────────────────────────────

export class PlanPipelineJobHandler implements JobHandlerBuilder<PlanPipelineJobDefinition> {
  constructor(private readonly pipelinePlanService: PublishPlanService) {}

  async run(params: {
    jobId: string;
    data: PlanPipelineJobDefinition['data'];
    progress: Progress<PlanPipelineJobDefinition['publicProgress'], PlanPipelineJobDefinition['initialJobProgress']>;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<PlanPipelineJobDefinition['publicProgress'], PlanPipelineJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;

    WSLogger.info({
      source: 'PlanPipelineJob',
      message: 'Starting pipeline plan job',
      workbookId: data.workbookId,
      jobId,
    });

    // Report initial progress
    await checkpoint({
      publicProgress: {
        status: 'planning',
        editsPlanned: 0,
        createsPlanned: 0,
        deletesPlanned: 0,
        backfillsPlanned: 0,
      },
      jobProgress: {},
      connectorProgress: {},
    });

    const onProgress = async (counts: {
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
          editsPlanned: counts.editsPlanned,
          createsPlanned: counts.createsPlanned,
          deletesPlanned: counts.deletesPlanned,
          backfillsPlanned: counts.backfillsPlanned,
        },
        jobProgress: {},
        connectorProgress: {},
      });
    };

    try {
      const plan = await this.pipelinePlanService.buildPipeline(
        data.workbookId,
        data.userId,
        data.connectorAccountId,
        data.pipelineId,
        onProgress,
      );

      // Count entries by phase from the returned plan
      // We need to query DB for entry counts since buildPipeline returns PublishPlanInfo
      const pipelineId = plan.pipelineId;
      // The plan is now created in DB — the UI can query entries via the admin endpoints.
      // For progress, we just report completed with the phase counts from the plan.
      await checkpoint({
        publicProgress: {
          status: 'completed',
          editsPlanned: plan.phases?.find((p) => p.type === 'edit')?.recordCount ?? 0,
          createsPlanned: plan.phases?.find((p) => p.type === 'create')?.recordCount ?? 0,
          deletesPlanned: plan.phases?.find((p) => p.type === 'delete')?.recordCount ?? 0,
          backfillsPlanned: plan.phases?.find((p) => p.type === 'backfill')?.recordCount ?? 0,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.info({
        source: 'PlanPipelineJob',
        message: 'Pipeline plan job completed',
        workbookId: data.workbookId,
        jobId,
        pipelineId,
      });
    } catch (error) {
      await checkpoint({
        publicProgress: {
          status: 'failed',
          editsPlanned: 0,
          createsPlanned: 0,
          deletesPlanned: 0,
          backfillsPlanned: 0,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.error({
        source: 'PlanPipelineJob',
        message: 'Pipeline plan job failed',
        workbookId: data.workbookId,
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}
