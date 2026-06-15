import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { SchemaBuilderModule } from 'src/schema-builder/schema-builder.module';
import { SyncModule } from 'src/sync/sync.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { SyncDraftController } from './sync-draft.controller';
import { SyncDraftService } from './sync-draft.service';

@Module({
  imports: [
    DbModule,
    RateLimiterModule,
    WorkbookModule,
    SyncModule,
    SchemaBuilderModule,
    ScratchConfigModule,
    MetricsModule,
  ],
  controllers: [SyncDraftController],
  providers: [SyncDraftService],
  exports: [SyncDraftService],
})
export class SyncDraftModule {}
