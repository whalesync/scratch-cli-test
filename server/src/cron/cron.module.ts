import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RoutineExecutionModule } from 'src/routine/routine-execution.module';
import { ScratchConfigModule } from '../config/scratch-config.module';
import { DbModule } from '../db/db.module';
import { JobModule } from '../job/job.module';
import { WorkerEnqueuerModule } from '../worker-enqueuer/worker-enqueuer.module';
import { ExpiredApiTokenCleanupService } from './expired-api-token-cleanup.service';
import { OldJobCleanupService } from './old-job-cleanup.service';
import { RoutineRunReaperService } from './routine-run-reaper.service';
import { StaleJobReaperService } from './stale-job-reaper.service';

@Module({
  // RoutineExecutionModule gives the reaper RoutineExecutorService to resume stuck runs.
  imports: [
    ScheduleModule.forRoot(),
    ScratchConfigModule,
    DbModule,
    JobModule,
    WorkerEnqueuerModule,
    RoutineExecutionModule,
  ],
  providers: [StaleJobReaperService, OldJobCleanupService, ExpiredApiTokenCleanupService, RoutineRunReaperService],
  exports: [StaleJobReaperService, OldJobCleanupService, ExpiredApiTokenCleanupService, RoutineRunReaperService],
})
export class CronModule {}
