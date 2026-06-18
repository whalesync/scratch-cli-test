import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { DbModule } from 'src/db/db.module';
import { JobModule } from 'src/job/job.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { RoutineExecutorService } from './routine-executor.service';
import { RoutineParserService } from './routine-parser.service';
import { RoutineReferenceValidatorService } from './routine-reference-validator.service';

/**
 * Routine *execution* — parse, reference-validate, trigger, and run routines. Deliberately depends
 * on NOTHING that depends back on routines (in particular NOT ScheduleModule), so the schedule
 * evaluator, the REST controller, and the cron reaper can all drive routines by importing this
 * module without creating a circular module dependency. RoutineModule (file CRUD + read API) imports
 * this for the parser/validator + executor; ScheduleModule and CronModule import it for the executor.
 */
@Module({
  imports: [DbModule, ScratchGitModule, WorkerEnqueuerModule, JobModule, AuditLogModule],
  providers: [RoutineParserService, RoutineReferenceValidatorService, RoutineExecutorService],
  exports: [RoutineParserService, RoutineReferenceValidatorService, RoutineExecutorService],
})
export class RoutineExecutionModule {}
