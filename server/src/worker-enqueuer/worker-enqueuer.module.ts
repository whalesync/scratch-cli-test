import { Module } from '@nestjs/common';
import { ScratchConfigModule } from '../config/scratch-config.module';
import { DbModule } from '../db/db.module';
import { JobModule } from '../job/job.module';
import { MigrationLockModule } from '../migration-lock/migration-lock.module';
import { BullEnqueuerService } from './bull-enqueuer.service';

@Module({
  imports: [ScratchConfigModule, JobModule, DbModule, MigrationLockModule],
  providers: [BullEnqueuerService],
  exports: [BullEnqueuerService],
})
export class WorkerEnqueuerModule {}
