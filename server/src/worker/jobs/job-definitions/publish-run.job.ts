import type { WorkbookId } from '@spinner/shared-types';
import type { PublishRunService } from 'src/publish-pipeline/publish-run.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress (UI-facing) ──────────────────────────────────────

export type PublishRunPublicProgress = {
  status: 'running' | 'completed' | 'failed';
  currentPhase: string;
  edits: number;
  creates: number;
  deletes: number;
  backfills: number;
  totalEdits: number;
  totalCreates: number;
  totalDeletes: number;
  totalBackfills: number;
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
    const { jobId, data, checkpoint, abortSignal } = params;

    WSLogger.info({
      source: 'PublishRunJob',
      message: 'Starting publish run job',
      workbookId: data.workbookId,
      jobId,
      pipelineId: data.pipelineId,
    });

    const zeroCounts = {
      edits: 0,
      creates: 0,
      deletes: 0,
      backfills: 0,
      totalEdits: 0,
      totalCreates: 0,
      totalDeletes: 0,
      totalBackfills: 0,
    };

    // Report initial progress
    await checkpoint({
      publicProgress: { status: 'running', currentPhase: '', ...zeroCounts },
      jobProgress: {},
      connectorProgress: {},
    });

    const onProgress = async (counts: {
      edits: number;
      creates: number;
      deletes: number;
      backfills: number;
      totalEdits: number;
      totalCreates: number;
      totalDeletes: number;
      totalBackfills: number;
      currentPhase: string;
    }) => {
      await checkpoint({
        publicProgress: { status: 'running', ...counts },
        jobProgress: {},
        connectorProgress: {},
      });
    };

    try {
      // runPipeline is already resumable — it fetches only 'pending' entries per phase.
      // If this job is retried after a crash, it picks up from where it left off.
      const result = await this.publishRunService.runPipeline(data.pipelineId, data.phase, abortSignal, onProgress);

      await checkpoint({
        publicProgress: {
          status: 'completed',
          currentPhase: 'done',
          edits: result.successByPhase?.edit ?? 0,
          creates: result.successByPhase?.create ?? 0,
          deletes: result.successByPhase?.delete ?? 0,
          backfills: result.successByPhase?.backfill ?? 0,
          totalEdits: result.totalByPhase?.edit ?? 0,
          totalCreates: result.totalByPhase?.create ?? 0,
          totalDeletes: result.totalByPhase?.delete ?? 0,
          totalBackfills: result.totalByPhase?.backfill ?? 0,
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
        publicProgress: { status: 'failed', currentPhase: 'error', ...zeroCounts },
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
