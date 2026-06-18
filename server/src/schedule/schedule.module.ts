import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbModule } from 'src/db/db.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { PublishPlanModule } from 'src/publish-plan/publish-plan.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { RoutineExecutionModule } from 'src/routine/routine-execution.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';
import { SchedulerService } from './scheduler.service';

@Module({
  // RoutineExecutionModule (which does NOT import ScheduleModule) gives the evaluator
  // RoutineExecutorService.triggerRun for ROUTINE schedules — no circular module dependency.
  imports: [
    DbModule,
    MetricsModule,
    ScratchConfigModule,
    RateLimiterModule,
    WorkerEnqueuerModule,
    WorkbookModule,
    PublishPlanModule,
    RoutineExecutionModule,
  ],
  controllers: [ScheduleController],
  providers: [
    ScheduleService,
    // Only register the evaluator on cron/monolith instances
    ...(ScratchConfigService.isCronService() ? [SchedulerService] : []),
  ],
  exports: [ScheduleService],
})
export class ScheduleModule {}
