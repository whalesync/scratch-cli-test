import type { WorkbookId } from '@spinner/shared-types';
import { PublishFromGitService } from 'src/publish-plan/publish-from-git.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress ────────────────────────────────────────────────────────

export type PublishFromGitPublicProgress = {
  status: 'running' | 'completed' | 'failed';
  planId: string;
  successCount: number;
  failedCount: number;
};

// ── Job Definition ─────────────────────────────────────────────────────────

export type PublishFromGitJobDefinition = JobDefinitionBuilder<
  'publish-from-git',
  {
    workbookId: WorkbookId;
    connectorAccountId: string;
    /** Relative path within dirty branch to the plan folder */
    planPath: string;
    userId: string;
  },
  PublishFromGitPublicProgress,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {},
  void
>;

// ── Handler ────────────────────────────────────────────────────────────────

export class PublishFromGitJobHandler implements JobHandlerBuilder<PublishFromGitJobDefinition> {
  constructor(private readonly publishFromGitService: PublishFromGitService) {}

  async run(params: {
    jobId: string;
    data: PublishFromGitJobDefinition['data'];
    progress: Progress<
      PublishFromGitJobDefinition['publicProgress'],
      PublishFromGitJobDefinition['initialJobProgress']
    >;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<PublishFromGitJobDefinition['publicProgress'], PublishFromGitJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;

    WSLogger.info({
      source: 'PublishFromGitJobHandler',
      message: 'Starting publish-from-git job',
      workbookId: data.workbookId,
      jobId,
      data: { planPath: data.planPath },
    });

    await checkpoint({
      publicProgress: { status: 'running', planId: '', successCount: 0, failedCount: 0 },
      jobProgress: {},
      connectorProgress: {},
    });

    try {
      const result = await this.publishFromGitService.runFromGit(
        data.workbookId,
        data.connectorAccountId,
        data.planPath,
      );

      await checkpoint({
        publicProgress: {
          status: 'completed',
          planId: result.planId,
          successCount: result.successCount,
          failedCount: result.failedCount,
        },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.info({
        source: 'PublishFromGitJobHandler',
        message: 'Publish-from-git job completed',
        workbookId: data.workbookId,
        jobId,
        data: { planId: result.planId, successCount: result.successCount, failedCount: result.failedCount },
      });
    } catch (err) {
      await checkpoint({
        publicProgress: { status: 'failed', planId: '', successCount: 0, failedCount: 0 },
        jobProgress: {},
        connectorProgress: {},
      });
      throw err;
    }
  }
}
