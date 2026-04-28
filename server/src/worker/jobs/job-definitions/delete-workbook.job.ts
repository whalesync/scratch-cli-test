import { JobType, type WorkbookId } from '@spinner/shared-types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

export type DeleteWorkbookPublicProgress = {
  status: 'running' | 'completed' | 'failed';
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

    WSLogger.info({
      source: 'DeleteWorkbookJobHandler',
      message: 'Starting hard delete for workbook',
      workbookId: data.workbookId,
      jobId,
    });

    await checkpoint({
      publicProgress: { status: 'running' },
      jobProgress: {},
      connectorProgress: {},
    });

    try {
      await this.workbookService.executeHardDeleteWorkbook(data.workbookId);

      await checkpoint({
        publicProgress: { status: 'completed' },
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
        publicProgress: { status: 'failed' },
        jobProgress: {},
        connectorProgress: {},
      });
      throw err;
    }
  }
}
