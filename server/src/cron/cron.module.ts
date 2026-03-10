import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ScratchConfigModule } from '../config/scratch-config.module';
import { DbModule } from '../db/db.module';
import { JobModule } from '../job/job.module';
import { WorkerEnqueuerModule } from '../worker-enqueuer/worker-enqueuer.module';
import { ExampleCronService } from './example-cron.service';
import { StaleJobReaperService } from './stale-job-reaper.service';

@Module({
  imports: [ScheduleModule.forRoot(), ScratchConfigModule, DbModule, JobModule, WorkerEnqueuerModule],
  providers: [ExampleCronService, StaleJobReaperService],
  exports: [ExampleCronService],
})
export class CronModule {}
