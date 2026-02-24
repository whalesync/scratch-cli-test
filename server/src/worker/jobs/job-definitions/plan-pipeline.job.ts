import type { WorkbookId } from '@spinner/shared-types';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
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
  renameFilesPlanned: number;
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
  constructor(
    private readonly pipelinePlanService: PublishPlanBuildService,
    private readonly db: import('src/db/db.service').DbService,
  ) {}

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
        renameFilesPlanned: 0,
      },
      jobProgress: {},
      connectorProgress: {},
    });

    const onProgress = async (counts: {
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

    try {
      const plan = await this.pipelinePlanService.buildPipeline(
        data.workbookId,
        data.userId,
        data.connectorAccountId,
        data.pipelineId,
        onProgress,
      );

      const pipelineId = plan.pipelineId;

      // Count entries by phase from the returned plan
      // We need to query DB for entry counts since buildPipeline returns PublishPlanInfo
      const getPhaseCount = async (phase: string) =>
        this.db.client.publishPlanOperation.count({
          where: { planId: pipelineId, phase },
        });

      await checkpoint({
        publicProgress: {
          status: 'completed',
          editsPlanned: await getPhaseCount('edit'),
          createsPlanned: await getPhaseCount('create'),
          deletesPlanned: await getPhaseCount('delete'),
          backfillsPlanned: await getPhaseCount('backfill'),
          renameFilesPlanned: await getPhaseCount('rename-files'),
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
          renameFilesPlanned: 0,
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
