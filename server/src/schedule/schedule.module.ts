import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbModule } from 'src/db/db.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [DbModule, ScratchConfigModule, WorkerEnqueuerModule],
  controllers: [ScheduleController],
  providers: [
    ScheduleService,
    // Only register the evaluator on cron/monolith instances
    ...(ScratchConfigService.isCronService() ? [SchedulerService] : []),
  ],
  exports: [ScheduleService],
})
export class ScheduleModule {}
