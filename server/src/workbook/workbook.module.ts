import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { ClerkModule } from 'src/clerk/clerk.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { EmailModule } from 'src/email/email.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { PosthogModule } from 'src/posthog/posthog.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
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
import { WorkbookEventModule } from './workbook-event.module';
import { WorkbookController } from './workbook.controller';
import { WorkbookDataGateway } from './workbook.gateway';
import { WorkbookService } from './workbook.service';

import { DataFolderController } from './data-folder.controller';
import { DataFolderService } from './data-folder.service';
import { WorkbookRepoService } from './workbook-repo.service';
import { WorkspacePermissionsService } from './workspace-permissions.service';

@Module({
  imports: [
    DbModule,
    MetricsModule,
    RateLimiterModule,
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
    WorkbookEventModule,
    EmailModule,
  ],
  controllers: [WorkbookController, FilesController, FilesPublicController, DataFolderController],
  providers: [
    WorkbookService,
    WorkbookDataGateway,
    FilesService,
    DataFolderService,
    WorkspacePermissionsService,
    WorkbookRepoService,
  ],
  exports: [
    WorkbookService,
    WorkbookEventModule,
    FilesService,
    DataFolderService,
    WorkspacePermissionsService,
    WorkbookRepoService,
  ],
})
export class WorkbookModule {}
