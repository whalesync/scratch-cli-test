import { JobType, type WorkbookId } from '@spinner/shared-types';
import { HardDeleteWorkbookPhase, HardDeleteWorkbookProgress, WorkbookService } from 'src/workbook/workbook.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

export type DeleteWorkbookPublicProgress = {
  status: 'pending' | 'active' | 'completed' | 'failed';
  phase: HardDeleteWorkbookPhase;
  connectionsDeleted: number;
  totalConnections: number;
  reposDeleted: number;
  dataFoldersDeleted: number;
  totalDataFolders: number;
};

export type DeleteWorkbookJobDefinition = JobDefinitionBuilder<
  typeof JobType.DeleteWorkbook,
  {
    workbookId: WorkbookId;
    userId: string;
    organizationId: string;
  },
  DeleteWorkbookPublicProgress,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {},
  void
>;

export class DeleteWorkbookJobHandler implements JobHandlerBuilder<DeleteWorkbookJobDefinition> {
  constructor(private readonly workbookService: WorkbookService) {}

  async run(params: {
    jobId: string;
    data: DeleteWorkbookJobDefinition['data'];
    progress: Progress<
      DeleteWorkbookJobDefinition['publicProgress'],
      DeleteWorkbookJobDefinition['initialJobProgress']
    >;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<DeleteWorkbookJobDefinition['publicProgress'], DeleteWorkbookJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;

    let latestProgress: HardDeleteWorkbookProgress = {
      phase: 'starting',
      connectionsDeleted: 0,
      totalConnections: 0,
      reposDeleted: 0,
      dataFoldersDeleted: 0,
      totalDataFolders: 0,
    };

    WSLogger.info({
      source: 'DeleteWorkbookJobHandler',
      message: 'Starting hard delete for workbook',
      workbookId: data.workbookId,
      jobId,
    });

    await checkpoint({
      publicProgress: { status: 'active', ...latestProgress },
      jobProgress: {},
      connectorProgress: {},
    });

    const onProgress = async (progress: HardDeleteWorkbookProgress): Promise<void> => {
      latestProgress = progress;
      await checkpoint({
        publicProgress: { status: 'active', ...progress },
        jobProgress: {},
        connectorProgress: {},
      });
    };

    try {
      await this.workbookService.executeHardDeleteWorkbook(data.workbookId, { onProgress });

      await checkpoint({
        publicProgress: { status: 'completed', ...latestProgress },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.info({
        source: 'DeleteWorkbookJobHandler',
        message: 'Workbook hard delete complete',
        workbookId: data.workbookId,
        jobId,
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
