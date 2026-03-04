import { Module } from '@nestjs/common';
import { AuditLogModule } from 'src/audit/audit-log.module';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { JobModule } from 'src/job/job.module';
import { PaymentModule } from 'src/payment/payment.module';
import { ConnectorAccountModule } from 'src/remote-service/connector-account/connector-account.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { UserModule } from 'src/users/users.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { WorkerEnqueuerModule } from 'src/worker-enqueuer/worker-enqueuer.module';
import { DevToolsController } from './dev-tools.controller';
import { DevToolsService } from './dev-tools.service';

@Module({
  providers: [DevToolsService],
  imports: [
    ScratchConfigModule,
    DbModule,
    UserModule,
    PaymentModule,
    WorkbookModule,
    JobModule,
    WorkerEnqueuerModule,
    ConnectorAccountModule,
    AuditLogModule,
    ScratchGitModule,
  ],
  exports: [], //export this service to use in other modules
  controllers: [DevToolsController],
})
export class DevToolsModule {}
