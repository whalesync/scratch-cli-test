import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { ScheduleModule } from 'src/schedule/schedule.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { RoutineExecutionModule } from './routine-execution.module';
import { RoutineController } from './routine.controller';
import { RoutineService } from './routine.service';

@Module({
  // MetricsModule + ScratchConfigModule are required so the controller-level guards
  // (ApiRateLimitGuard → CustomMetricsService + ScratchConfigService) resolve in this
  // module's context — mirrors ScheduleModule, whose controller uses the same guards.
  // RoutineExecutionModule provides the parser/validator (used by RoutineService) and the
  // RoutineExecutorService (used by the controller's trigger/cancel endpoints).
  imports: [
    DbModule,
    MetricsModule,
    ScratchConfigModule,
    ScheduleModule,
    WorkbookModule,
    ScratchGitModule,
    AuditLogModule,
    RateLimiterModule,
    RoutineExecutionModule,
  ],
  controllers: [RoutineController],
  providers: [RoutineService],
  exports: [RoutineService],
})
export class RoutineModule {}
