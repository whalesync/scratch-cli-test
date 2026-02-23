import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { FileIndexService } from 'src/publish-pipeline/file-index.service';
import { FileReferenceService } from 'src/publish-pipeline/file-reference.service';
import { PublishPlanService } from 'src/publish-pipeline/publish-plan.service';
import { PublishRunService } from 'src/publish-pipeline/publish-run.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { SyncService } from 'src/sync/sync.service';
import { DataFolderPublishingService } from 'src/workbook/data-folder-publishing.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { ScratchConfigService } from '../config/scratch-config.service';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { PublishDataFolderJobHandler } from './jobs/job-definitions/publish-data-folder.job';
import { PublishJobHandler } from './jobs/job-definitions/publish.job';
import { PullLinkedFolderFilesJobHandler } from './jobs/job-definitions/pull-linked-folder-files.job';
import { SyncDataFoldersJobHandler } from './jobs/job-definitions/sync-data-folders.job';
import { JobData, JobDefinition, JobHandler } from './jobs/union-types';

@Injectable()
export class JobHandlerService {
  constructor(
    private readonly connectorService: ConnectorsService,
    private readonly config: ScratchConfigService,
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly workbookEventService: WorkbookEventService,
    private readonly scratchGitService: ScratchGitService,
    private readonly dataFolderPublishingService: DataFolderPublishingService,
    private readonly syncService: SyncService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly pipelinePlanService: PublishPlanService,
    private readonly pipelineRunService: PublishRunService,
    private readonly dbService: DbService,
  ) {
    WSLogger.info({ source: 'JobHandlerService', message: 'Job handler services initializing... 🔄' });
  }

  getHandler = (data: JobData): JobHandler<JobDefinition> => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });

    switch (data.type) {
      case 'pull-linked-folder-files':
        return new PullLinkedFolderFilesJobHandler(
          prisma,
          this.connectorService,
          this.connectorAccountService,
          this.workbookEventService,
          this.scratchGitService,
          this.fileIndexService,
          this.fileReferenceService,
        ) as JobHandler<JobDefinition>;

      case 'publish-data-folder':
        return new PublishDataFolderJobHandler(
          prisma,
          this.connectorService,
          this.connectorAccountService,
          this.workbookEventService,
          this.dataFolderPublishingService,
          this.bullEnqueuerService,
        ) as JobHandler<JobDefinition>;

      case 'sync-data-folders':
        return new SyncDataFoldersJobHandler(
          prisma,
          this.syncService,
          this.workbookEventService,
        ) as JobHandler<JobDefinition>;

      case 'publish':
        return new PublishJobHandler(
          this.pipelinePlanService,
          this.pipelineRunService,
          this.dbService,
          this.bullEnqueuerService,
        ) as JobHandler<JobDefinition>;

      default:
        throw new Error(`Unknown job type. Data: ${JSON.stringify(data)}`);
    }
  };
}
