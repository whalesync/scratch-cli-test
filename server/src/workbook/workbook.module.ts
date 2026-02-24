import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { ClerkModule } from 'src/clerk/clerk.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { PosthogModule } from 'src/posthog/posthog.module';
import { RedisModule } from 'src/redis/redis.module';
import { ConnectorAccountModule } from 'src/remote-service/connector-account/connector-account.module';
import { UserModule } from 'src/users/users.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { PublishPlanModule } from '../publish-plan/publish-plan.module';
import { ConnectorsModule } from '../remote-service/connectors/connectors.module';
import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { FilesPublicController } from './files-public.controller';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { WorkbookEventService } from './workbook-event.service';
import { WorkbookController } from './workbook.controller';
import { WorkbookDataGateway } from './workbook.gateway';
import { WorkbookService } from './workbook.service';

import { DataFolderPublishingService } from './data-folder-publishing.service';
import { DataFolderController } from './data-folder.controller';
import { DataFolderService } from './data-folder.service';

@Module({
  imports: [
    DbModule,
    ConnectorsModule,
    ScratchConfigModule,
    ClerkModule,
    UserModule,
    PosthogModule,
    ConnectorAccountModule,
    RedisModule,
    WorkerEnqueuerModule,
    AuditLogModule,
    ScratchGitModule,
    PublishPlanModule,
  ],
  controllers: [WorkbookController, FilesController, FilesPublicController, DataFolderController],
  providers: [
    WorkbookService,
    WorkbookEventService,
    WorkbookDataGateway,
    FilesService,
    DataFolderService,
    DataFolderPublishingService,
  ],
  exports: [WorkbookService, WorkbookEventService, FilesService, DataFolderService, DataFolderPublishingService],
})
export class WorkbookModule {}
