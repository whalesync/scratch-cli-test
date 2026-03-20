import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ScratchConfigModule } from '../config/scratch-config.module';
import { DbModule } from '../db/db.module';
import { JobModule } from '../job/job.module';
import { WorkerEnqueuerModule } from '../worker-enqueuer/worker-enqueuer.module';
import { OldJobCleanupService } from './old-job-cleanup.service';
import { StaleJobReaperService } from './stale-job-reaper.service';

@Module({
  imports: [ScheduleModule.forRoot(), ScratchConfigModule, DbModule, JobModule, WorkerEnqueuerModule],
  providers: [StaleJobReaperService, OldJobCleanupService],
  exports: [StaleJobReaperService, OldJobCleanupService],
})
export class CronModule {}
