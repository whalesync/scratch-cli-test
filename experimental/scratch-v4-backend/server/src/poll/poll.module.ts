import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { ConnectorsModule } from 'src/remote-service/connectors/connectors.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { PollJob } from './poll.job';

@Module({
  imports: [DbModule, ConnectorsModule, ScratchGitModule],
  providers: [PollJob],
  exports: [PollJob],
})
export class PollModule {}
