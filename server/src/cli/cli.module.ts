import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { JobModule } from 'src/job/job.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { PosthogModule } from 'src/posthog/posthog.module';
import { PublishPlanModule } from 'src/publish-plan/publish-plan.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { ConnectorAccountModule } from 'src/remote-service/connector-account/connector-account.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { SyncModule } from 'src/sync/sync.module';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { CliAuthController } from './cli-auth.controller';
import { CliAuthService } from './cli-auth.service';
import { CliConnectionController } from './cli-connection.controller';
import { CliLinkedController } from './cli-linked.controller';
import { CliSyncController } from './cli-sync.controller';
import { CliWorkbookController } from './cli-workbook.controller';

@Module({
  imports: [
    ScratchConfigModule,
    RateLimiterModule,
    MetricsModule,
    AuthModule,
    DbModule,
    JobModule,
    PosthogModule,
    WorkbookModule,
    ConnectorAccountModule,
    WorkerEnqueuerModule,
    ScratchGitModule,
    SyncModule,
    PublishPlanModule,
  ],
  controllers: [
    CliAuthController,
    CliWorkbookController,
    CliConnectionController,
    CliLinkedController,
    CliSyncController,
  ],
  providers: [CliAuthService, WorkbookRepoService],
  exports: [CliAuthService],
})
export class CliModule {}
