import type { WorkbookId } from '@spinner/shared-types';
import { PublishPlanRunService } from 'src/publish-plan/publish-plan-run.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress (UI-facing) ──────────────────────────────────────

export type RunPipelinePublicProgress = {
  status: 'running' | 'completed' | 'failed';
  currentPhase: string;
  totalEntries: number;
  completedEntries: number;
  failedEntries: number;
};

// ── Job Definition ───────────────────────────────────────────────────

export type RunPipelineJobDefinition = JobDefinitionBuilder<
  'run-pipeline',
  {
    pipelineId: string;
    workbookId: WorkbookId;
    userId: string;
    executeSinglePhase?: boolean;
  },
  RunPipelinePublicProgress,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {}, // No checkpoint state — DB is the checkpoint (entry statuses + plan status)
  void
>;

// ── Handler ──────────────────────────────────────────────────────────

export class RunPipelineJobHandler implements JobHandlerBuilder<RunPipelineJobDefinition> {
  constructor(private readonly publishRunService: PublishPlanRunService) {}

  async run(params: {
    jobId: string;
    data: RunPipelineJobDefinition['data'];
    progress: Progress<RunPipelineJobDefinition['publicProgress'], RunPipelineJobDefinition['initialJobProgress']>;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<RunPipelineJobDefinition['publicProgress'], RunPipelineJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;

    WSLogger.info({
      source: 'RunPipelineJob',
      message: 'Starting pipeline run job',
      workbookId: data.workbookId,
      jobId,
      pipelineId: data.pipelineId,
    });

    // Report initial progress
    await checkpoint({
      publicProgress: {
        status: 'running',
        currentPhase: '',
        totalEntries: 0,
        completedEntries: 0,
        failedEntries: 0,
      },
      jobProgress: {},
      connectorProgress: {},
    });

    try {
      // runPipeline is already resumable — it fetches only 'pending' entries per phase.
      await this.publishRunService.runPipeline(data.pipelineId, data.executeSinglePhase);

      await checkpoint({
        publicProgress: {
          status: 'completed',
          currentPhase: 'done',
          totalEntries: 0,
          completedEntries: 0,
          failedEntries: 0,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.info({
        source: 'RunPipelineJob',
        message: 'Pipeline run job completed',
        workbookId: data.workbookId,
        jobId,
        pipelineId: data.pipelineId,
      });
    } catch (error) {
      await checkpoint({
        publicProgress: {
          status: 'failed',
          currentPhase: 'error',
          totalEntries: 0,
          completedEntries: 0,
          failedEntries: 0,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.error({
        source: 'RunPipelineJob',
        message: 'Pipeline run job failed',
        workbookId: data.workbookId,
        jobId,
        pipelineId: data.pipelineId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}
