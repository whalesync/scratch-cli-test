import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { SchemaBuilderModule } from 'src/schema-builder/schema-builder.module';
import { SyncModule } from 'src/sync/sync.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { SyncDraftController } from './sync-draft.controller';
import { SyncDraftService } from './sync-draft.service';

@Module({
  imports: [DbModule, RateLimiterModule, WorkbookModule, SyncModule, SchemaBuilderModule],
  controllers: [SyncDraftController],
  providers: [SyncDraftService],
  exports: [SyncDraftService],
})
export class SyncDraftModule {}
