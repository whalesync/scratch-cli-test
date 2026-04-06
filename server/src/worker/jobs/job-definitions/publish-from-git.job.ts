import { JobType, type WorkbookId } from '@spinner/shared-types';
import { PublishFromGitService } from 'src/publish-plan/publish-from-git.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// ── Public Progress ────────────────────────────────────────────────────────

export type PublishFromGitPublicProgress = {
  status: 'running' | 'completed' | 'failed';
  planId: string;
  connectionName: string;
  tableName: string;
  currentTableName: string;
  tableCount: number;
  currentPhase: string;
  processedCount: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  editsPlanned: number;
  createsPlanned: number;
  deletesPlanned: number;
  backfillsPlanned: number;
  renameFilesPlanned: number;
};

// ── Job Definition ─────────────────────────────────────────────────────────

export type PublishFromGitJobDefinition = JobDefinitionBuilder<
  typeof JobType.PublishFromGit,
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
    const emptyProgress = {
      planId: '',
      connectionName: '',
      tableName: '',
      currentTableName: '',
      tableCount: 0,
      currentPhase: '',
      processedCount: 0,
      totalCount: 0,
      successCount: 0,
      failedCount: 0,
      editsPlanned: 0,
      createsPlanned: 0,
      deletesPlanned: 0,
      backfillsPlanned: 0,
      renameFilesPlanned: 0,
    } satisfies Omit<PublishFromGitPublicProgress, 'status'>;
    let latestProgress = emptyProgress;

    WSLogger.info({
      source: 'PublishFromGitJobHandler',
      message: 'Starting publish-from-git job',
      workbookId: data.workbookId,
      jobId,
      data: { planPath: data.planPath },
    });

    await checkpoint({
      publicProgress: { status: 'running', ...latestProgress },
      jobProgress: {},
      connectorProgress: {},
    });

    try {
      const onProgress = async (progress: Omit<PublishFromGitPublicProgress, 'status'>) => {
        latestProgress = progress;
        await checkpoint({
          publicProgress: { status: 'running', ...progress },
          jobProgress: {},
          connectorProgress: {},
        });
      };

      const result = await this.publishFromGitService.runFromGit(
        data.workbookId,
        data.connectorAccountId,
        data.planPath,
        onProgress,
      );

      latestProgress = result;

      await checkpoint({
        publicProgress: {
          status: 'completed',
          ...result,
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
        publicProgress: { status: 'failed', ...latestProgress },
        jobProgress: {},
        connectorProgress: {},
      });
      throw err;
    }
  }
}
