import type { WorkbookId } from '@spinner/shared-types';
import type { PublishRunService } from 'src/publish-pipeline/publish-run.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress (UI-facing) ──────────────────────────────────────

export type PublishRunPublicProgress = {
  status: 'running' | 'completed' | 'failed';
  currentPhase: string;
  totalEntries: number;
  completedEntries: number;
  failedEntries: number;
};

// ── Job Definition ───────────────────────────────────────────────────

export type PublishRunJobDefinition = JobDefinitionBuilder<
  'publish-run',
  {
    pipelineId: string;
    workbookId: WorkbookId;
    userId: string;
    phase?: string;
  },
  PublishRunPublicProgress,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {}, // No checkpoint state — DB is the checkpoint (entry statuses + plan status)
  void
>;

// ── Handler ──────────────────────────────────────────────────────────

export class PublishRunJobHandler implements JobHandlerBuilder<PublishRunJobDefinition> {
  constructor(private readonly publishRunService: PublishRunService) {}

  async run(params: {
    jobId: string;
    data: PublishRunJobDefinition['data'];
    progress: Progress<PublishRunJobDefinition['publicProgress'], PublishRunJobDefinition['initialJobProgress']>;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<PublishRunJobDefinition['publicProgress'], PublishRunJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;

    WSLogger.info({
      source: 'PublishRunJob',
      message: 'Starting publish run job',
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
      // If this job is retried after a crash, it picks up from where it left off.
      const result = await this.publishRunService.runPipeline(data.pipelineId, data.phase);

      const successCount = result.successCount ?? 0;
      const failedCount = result.failedCount ?? 0;

      await checkpoint({
        publicProgress: {
          status: 'completed',
          currentPhase: 'done',
          totalEntries: successCount + failedCount,
          completedEntries: successCount,
          failedEntries: failedCount,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.info({
        source: 'PublishRunJob',
        message: 'Publish run job completed',
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
        source: 'PublishRunJob',
        message: 'Publish run job failed',
        workbookId: data.workbookId,
        jobId,
        pipelineId: data.pipelineId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}
