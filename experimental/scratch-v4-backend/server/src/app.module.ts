import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JobModule } from './job/job.module';
import { PublishModule } from './publish/publish.module';
import { ScratchGitModule } from './scratch-git/scratch-git.module';
import { WorkbookModule } from './workbook/workbook.module';
import { WorkbookController } from './workbook/workbook.controller';
import { WorkerModule } from './worker/workers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    WorkbookModule,
    ScratchGitModule,
    JobModule,
    WorkerModule,
    PublishModule,
  ],
  // Expose a minimal workbook endpoint so `scratchmd pull` can fetch metadata
  controllers: [WorkbookController],
})
export class AppModule {}
