import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { ConnectorsModule } from 'src/remote-service/connectors/connectors.module';
import { PublishController } from './publish.controller';
import { PublishService } from './publish.service';

@Module({
  imports: [DbModule, ScratchGitModule, ConnectorsModule],
  controllers: [PublishController],
  providers: [PublishService],
})
export class PublishModule {}
