import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module';
import { CredentialEncryptionModule } from '../credential-encryption/credential-encryption.module';
import { DbModule } from '../db/db.module';
import { JobModule } from '../job/job.module';
import { MetricsModule } from '../metrics/metrics.module';
import { MigrationLockModule } from '../migration-lock/migration-lock.module';
import { OAuthModule } from '../oauth/oauth.module';
import { PublishPlanModule } from '../publish-plan/publish-plan.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { WorkbookEventModule } from '../workbook/workbook-event.module';
import { WorkbookRepoService } from '../workbook/workbook-repo.service';
import { CodeMigrationsController } from './code-migrations.controller';
import { ConnectionQuiesceService } from './connection-quiesce.service';

@Module({
  imports: [
    DbModule,
    ScratchGitModule,
    CredentialEncryptionModule,
    OAuthModule,
    AuditLogModule,
    MetricsModule,
    // DEV-9698 (T4) per-connection quiesce dependencies.
    MigrationLockModule,
    ScheduleModule,
    PublishPlanModule,
    JobModule,
    WorkbookEventModule,
  ],
  controllers: [CodeMigrationsController],
  providers: [WorkbookRepoService, ConnectionQuiesceService],
})
export class CodeMigrationsModule {}
