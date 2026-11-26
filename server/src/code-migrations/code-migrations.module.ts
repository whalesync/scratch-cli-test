import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module';
import { CredentialEncryptionModule } from '../credential-encryption/credential-encryption.module';
import { DbModule } from '../db/db.module';
import { InternalModule } from '../internal/internal.module';
import { JobModule } from '../job/job.module';
import { MetricsModule } from '../metrics/metrics.module';
import { MigrationLockModule } from '../migration-lock/migration-lock.module';
import { OAuthModule } from '../oauth/oauth.module';
import { PaymentModule } from '../payment/payment.module';
import { PublishPlanModule } from '../publish-plan/publish-plan.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { UserModule } from '../users/users.module';
import { DataFolderTableSpecStoreModule } from '../workbook/table-spec-store/data-folder-table-spec-store.module';
import { WorkbookEventModule } from '../workbook/workbook-event.module';
import { WorkbookRepoService } from '../workbook/workbook-repo.service';
import { CodeMigrationsController } from './code-migrations.controller';
import { ConnectionQuiesceService } from './connection-quiesce.service';
import { WhalesyncRealAccountMigrationService } from './whalesync-real-account-migration.service';

@Module({
  imports: [
    DbModule,
    ScratchGitModule,
    DataFolderTableSpecStoreModule,
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
    // DEV-13019: taking Whalesync teams off real Scratch accounts.
    UserModule,
    PaymentModule,
    InternalModule,
  ],
  controllers: [CodeMigrationsController],
  providers: [WorkbookRepoService, ConnectionQuiesceService, WhalesyncRealAccountMigrationService],
})
export class CodeMigrationsModule {}
