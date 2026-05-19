import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { JobType } from '@spinner/shared-types';
import { AssetDownloadService } from 'src/asset/asset-download.service';
import { AssetExtractorService } from 'src/asset/asset-extractor.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { WSLogger } from 'src/logger';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ApplyPatchesService } from 'src/publish-plan/apply-patches.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { PublishFromGitService } from 'src/publish-plan/publish-from-git.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { PublishPlanRunService } from 'src/publish-plan/publish-plan-run.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { SyncService } from 'src/sync/sync.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { ScratchConfigService } from '../config/scratch-config.service';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { ApplyPatchesJobHandler } from './jobs/job-definitions/apply-patches.job';
import { DeleteWorkbookJobHandler } from './jobs/job-definitions/delete-workbook.job';
import { PublishFromGitJobHandler } from './jobs/job-definitions/publish-from-git.job';
import { PublishJobHandler } from './jobs/job-definitions/publish.job';
import { PullFilesJobHandler } from './jobs/job-definitions/pull-files.job';
import { PullLinkedFolderFilesJobHandler } from './jobs/job-definitions/pull-linked-folder-files.job';
import { RehostAssetsJobHandler } from './jobs/job-definitions/rehost-assets.job';
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
    private readonly syncService: SyncService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly assetExtractorService: AssetExtractorService,
    private readonly assetIndexService: AssetIndexService,
    private readonly assetDownloadService: AssetDownloadService,
    private readonly pipelinePlanService: PublishPlanBuildService,
    private readonly pipelineRunService: PublishPlanRunService,
    private readonly publishFromGitService: PublishFromGitService,
    private readonly applyPatchesService: ApplyPatchesService,
    private readonly dbService: DbService,
    private readonly postHogService: PostHogService,
    private readonly workbookService: WorkbookService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
    private readonly experimentsService: ExperimentsService,
  ) {
    WSLogger.info({ source: 'JobHandlerService', message: 'Job handler services initializing... 🔄' });
  }

  getHandler = (data: JobData): JobHandler<JobDefinition> => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });

    switch (data.type) {
      case JobType.PullLinkedFolderFiles:
        return new PullLinkedFolderFilesJobHandler(
          prisma,
          this.connectorService,
          this.connectorAccountService,
          this.workbookEventService,
          this.scratchGitService,
          this.fileIndexService,
          this.fileReferenceService,
          this.assetExtractorService,
          this.assetIndexService,
          this.postHogService,
          this.experimentsService,
        ) as JobHandler<JobDefinition>;

      case JobType.RefreshRecords:
        return new PullFilesJobHandler(
          prisma,
          this.connectorService,
          this.connectorAccountService,
          this.workbookEventService,
          this.scratchGitService,
          this.fileIndexService,
          this.fileReferenceService,
          this.assetExtractorService,
          this.assetIndexService,
          this.postHogService,
        ) as JobHandler<JobDefinition>;

      case JobType.SyncDataFolders:
        return new SyncDataFoldersJobHandler(
          prisma,
          this.syncService,
          this.workbookEventService,
          this.scratchGitService,
          this.bullEnqueuerService,
          this.pipelinePlanService,
          this.postHogService,
          this.metricsService,
        ) as JobHandler<JobDefinition>;

      case JobType.RehostAssets:
        return new RehostAssetsJobHandler(
          prisma,
          this.assetDownloadService,
          this.workbookEventService,
        ) as JobHandler<JobDefinition>;

      case JobType.PublishFromGit:
        return new PublishFromGitJobHandler(
          this.publishFromGitService,
          this.postHogService,
        ) as JobHandler<JobDefinition>;

      case JobType.ApplyPatches:
        return new ApplyPatchesJobHandler(this.applyPatchesService) as JobHandler<JobDefinition>;

      case JobType.DeleteWorkbook:
        return new DeleteWorkbookJobHandler(this.workbookService) as JobHandler<JobDefinition>;

      case JobType.Publish:
        return new PublishJobHandler(
          this.pipelinePlanService,
          this.pipelineRunService,
          this.dbService,
          this.workbookEventService,
          this.bullEnqueuerService,
          this.postHogService,
        ) as JobHandler<JobDefinition>;

      default:
        throw new Error(`Unknown job type. Data: ${JSON.stringify(data)}`);
    }
  };
}
