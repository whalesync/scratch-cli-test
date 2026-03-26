import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { ScratchGitClient } from './scratch-git.client';
import { ScratchGitController } from './scratch-git.controller';
import { ScratchGitService } from './scratch-git.service';

@Module({
  imports: [ConfigModule, ScratchConfigModule, DbModule],
  controllers: [ScratchGitController],
  providers: [ScratchGitService, ScratchGitClient],
  exports: [ScratchGitService, ScratchGitClient],
})
export class ScratchGitModule {}
