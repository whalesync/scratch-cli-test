import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { PosthogModule } from 'src/posthog/posthog.module';
import { PublishPlanModule } from 'src/publish-plan/publish-plan.module';
import { ScheduleModule } from 'src/schedule/schedule.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { AiSyncBuilderService } from './ai-sync-builder.service';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { TransformerController } from './transformers/transformer.controller';
import { WhalesyncImportApiService } from './whalesync-import';

@Module({
  imports: [
    AuditLogModule,
    DbModule,
    PosthogModule,
    ScheduleModule,
    ScratchGitModule,
    WorkbookModule,
    ScratchConfigModule,
    WorkerEnqueuerModule,
    PublishPlanModule,
  ],
  controllers: [SyncController, TransformerController],
  providers: [SyncService, WhalesyncImportApiService, AiSyncBuilderService],
  exports: [SyncService],
})
export class SyncModule {}
