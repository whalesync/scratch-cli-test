import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { JobModule } from 'src/job/job.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { RoutineModule } from 'src/routine/routine.module';
import { SchemaBuilderModule } from 'src/schema-builder/schema-builder.module';
import { SyncModule } from 'src/sync/sync.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
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
    RoutineModule,
    // The background save path (DEV-10875): save() enqueues the apply-sync-draft job and checks
    // the in-flight job's state through JobService.
    WorkerEnqueuerModule,
    JobModule,
  ],
  controllers: [SyncDraftController],
  providers: [SyncDraftService],
  exports: [SyncDraftService],
})
export class SyncDraftModule {}
