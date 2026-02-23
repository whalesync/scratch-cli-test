import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { PosthogModule } from 'src/posthog/posthog.module';
import { PublishPipelineModule } from 'src/publish-pipeline/publish-pipeline.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { TransformerController } from './transformers/transformer.controller';

@Module({
  imports: [
    AuditLogModule,
    DbModule,
    PosthogModule,
    ScratchGitModule,
    WorkbookModule,
    ScratchConfigModule,
    WorkerEnqueuerModule,
    PublishPipelineModule,
  ],
  controllers: [SyncController, TransformerController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
