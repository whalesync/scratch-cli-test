import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { ExperimentsModule } from 'src/experiments/experiments.module';
import { JobModule } from 'src/job/job.module';
import { LiveExportAccessModule } from 'src/live-export-access/live-export-access.module';
import { LiveExportRunStoreModule } from 'src/live-export-run-store/live-export-run-store.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { RunCountModule } from 'src/run-count/run-count.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { RoutineDefinitionStoreService } from './routine-definition-store.service';
import { RoutineExecutorService } from './routine-executor.service';
import { RoutineParserService } from './routine-parser.service';
import { RoutineReferenceValidatorService } from './routine-reference-validator.service';
import { WhalesyncRunNotifierService } from './whalesync-run-notifier.service';

/**
 * Routine *execution* — parse, reference-validate, trigger, and run routines. Deliberately depends
 * on NOTHING that depends back on routines (in particular NOT ScheduleModule), so the schedule
 * evaluator, the REST controller, and the cron reaper can all drive routines by importing this
 * module without creating a circular module dependency. RoutineModule (file CRUD + read API) imports
 * this for the definition store, parser/validator + executor; ScheduleModule and CronModule import it
 * for the executor. The store (RoutineDefinitionStoreService) is the single owner of routine
 * definitions in Postgres (DEV-11399).
 */
@Module({
  imports: [
    DbModule,
    WorkerEnqueuerModule,
    JobModule,
    AuditLogModule,
    RunCountModule,
    LiveExportRunStoreModule,
    LiveExportAccessModule,
    ScratchConfigModule,
    ExperimentsModule,
    MetricsModule,
  ],
  providers: [
    RoutineDefinitionStoreService,
    RoutineParserService,
    RoutineReferenceValidatorService,
    RoutineExecutorService,
    WhalesyncRunNotifierService,
  ],
  exports: [
    RoutineDefinitionStoreService,
    RoutineParserService,
    RoutineReferenceValidatorService,
    RoutineExecutorService,
    WhalesyncRunNotifierService,
  ],
})
export class RoutineExecutionModule {}
