import { Module } from '@nestjs/common';
import { JobModule } from 'src/job/job.module';
import { BullEnqueuerService } from './bull-enqueuer.service';

@Module({
  imports: [JobModule],
  providers: [BullEnqueuerService],
  exports: [BullEnqueuerService],
})
export class WorkerEnqueuerModule {}
