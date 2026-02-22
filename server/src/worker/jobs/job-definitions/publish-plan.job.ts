import type { WorkbookId } from '@spinner/shared-types';
import type { PublishPlanService } from 'src/publish-pipeline/publish-plan.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress (UI-facing) ──────────────────────────────────────

export type PublishPlanPublicProgress = {
  status: 'planning' | 'completed' | 'failed';
  step?: string;
  edits: number;
  creates: number;
  deletes: number;
  backfills: number;
};

// ── Job Definition ───────────────────────────────────────────────────

export type PublishPlanJobDefinition = JobDefinitionBuilder<
  'publish-plan',
  {
    workbookId: WorkbookId;
    userId: string;
    pipelineId: string;
    connectorAccountId?: string;
  },
  PublishPlanPublicProgress,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {}, // No checkpoint state needed — planning is a single operation
  void
>;

// ── Handler ──────────────────────────────────────────────────────────

export class PublishPlanJobHandler implements JobHandlerBuilder<PublishPlanJobDefinition> {
  constructor(private readonly publishPlanService: PublishPlanService) {}

  async run(params: {
    jobId: string;
    data: PublishPlanJobDefinition['data'];
    progress: Progress<PublishPlanJobDefinition['publicProgress'], PublishPlanJobDefinition['initialJobProgress']>;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<PublishPlanJobDefinition['publicProgress'], PublishPlanJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;

    WSLogger.info({
      source: 'PublishPlanJob',
      message: 'Starting publish plan job',
      workbookId: data.workbookId,
      jobId,
    });

    // Report initial progress
    await checkpoint({
      publicProgress: {
        status: 'planning',
        edits: 0,
        creates: 0,
        deletes: 0,
        backfills: 0,
      },
      jobProgress: {},
      connectorProgress: {},
    });

    const onProgress = async (step: string) => {
      await checkpoint({
        publicProgress: {
          status: 'planning',
          step,
          edits: 0,
          creates: 0,
          deletes: 0,
          backfills: 0,
        },
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
        onProgress,
      );

      const pipelineId = plan.pipelineId;
      await checkpoint({
        publicProgress: {
          status: 'completed',
          edits: plan.phases?.find((p) => p.type === 'edit')?.recordCount ?? 0,
          creates: plan.phases?.find((p) => p.type === 'create')?.recordCount ?? 0,
          deletes: plan.phases?.find((p) => p.type === 'delete')?.recordCount ?? 0,
          backfills: plan.phases?.find((p) => p.type === 'backfill')?.recordCount ?? 0,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.info({
        source: 'PublishPlanJob',
        message: 'Publish plan job completed',
        workbookId: data.workbookId,
        jobId,
        pipelineId,
      });
    } catch (error) {
      await checkpoint({
        publicProgress: {
          status: 'failed',
          edits: 0,
          creates: 0,
          deletes: 0,
          backfills: 0,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.error({
        source: 'PublishPlanJob',
        message: 'Publish plan job failed',
        workbookId: data.workbookId,
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}
