import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbModule } from 'src/db/db.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [DbModule, MetricsModule, ScratchConfigModule, RateLimiterModule, WorkerEnqueuerModule, WorkbookModule],
  controllers: [ScheduleController],
  providers: [
    ScheduleService,
    // Only register the evaluator on cron/monolith instances
    ...(ScratchConfigService.isCronService() ? [SchedulerService] : []),
  ],
  exports: [ScheduleService],
})
export class ScheduleModule {}
