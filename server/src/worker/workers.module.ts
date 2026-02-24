import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { PublishPlanModule } from 'src/publish-plan/publish-plan.module';
import { ConnectorAccountModule } from 'src/remote-service/connector-account/connector-account.module';
import { ConnectorsModule } from 'src/remote-service/connectors/connectors.module';
import { SyncModule } from 'src/sync/sync.module';
import { UserModule } from 'src/users/users.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { JobModule } from '../job/job.module';
import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { WorkerEnqueuerModule } from '../worker-enqueuer/worker-enqueuer.module';
import { QueueService } from './bull-worker.service';
import { JobHandlerService } from './job-handler.service';
import { WorkerPoolService } from './piscina/worker-pool.service';
import { QueueTestService } from './test/queue-test.service';
import { WorkersController } from './test/workers.controller';

@Module({
  imports: [
    ScratchConfigModule,
    DbModule,
    WorkerEnqueuerModule,
    ConnectorsModule,
    WorkbookModule,
    JobModule,
    ConnectorAccountModule,
    UserModule,
    ScratchGitModule,
    ScratchGitModule,
    SyncModule,
    PublishPlanModule,
  ],
  controllers: [WorkersController],
  providers: [WorkerPoolService, QueueService, QueueTestService, JobHandlerService],
  exports: [WorkerPoolService, QueueService, JobHandlerService],
})
export class WorkerModule {}
