import { Module } from '@nestjs/common';
import { JobModule } from 'src/job/job.module';
import { PollModule } from 'src/poll/poll.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { QueueService } from './bull-worker.service';

@Module({
  imports: [JobModule, PollModule, WorkerEnqueuerModule],
  providers: [QueueService],
  exports: [QueueService],
})
export class WorkerModule {}
