import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MetricsModule } from 'src/metrics/metrics.module';
import { RecordCountModule } from 'src/record-count/record-count.module';
import { RoutineExecutionModule } from 'src/routine/routine-execution.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { ScratchConfigModule } from '../config/scratch-config.module';
import { DbModule } from '../db/db.module';
import { JobModule } from '../job/job.module';
import { WorkerEnqueuerModule } from '../worker-enqueuer/worker-enqueuer.module';
import { CronDebugController } from './cron-debug.controller';
import { ExpiredApiTokenCleanupService } from './expired-api-token-cleanup.service';
import { OldJobCleanupService } from './old-job-cleanup.service';
import { RecordCountRefreshService } from './record-count-refresh.service';
import { RoutineRunReaperService } from './routine-run-reaper.service';
import { ScratchGitDiskObservabilityService } from './scratch-git-disk-observability.service';
import { StagingDirReaperService } from './staging-dir-reaper.service';
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
    RecordCountModule,
    MetricsModule,
    ScratchGitModule,
  ],
  controllers: [CronDebugController],
  providers: [
    StaleJobReaperService,
    OldJobCleanupService,
    ExpiredApiTokenCleanupService,
    RoutineRunReaperService,
    RecordCountRefreshService,
    ScratchGitDiskObservabilityService,
    StagingDirReaperService,
  ],
  exports: [
    StaleJobReaperService,
    OldJobCleanupService,
    ExpiredApiTokenCleanupService,
    RoutineRunReaperService,
    RecordCountRefreshService,
    ScratchGitDiskObservabilityService,
    StagingDirReaperService,
  ],
})
export class CronModule {}
