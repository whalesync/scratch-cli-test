import { Module } from '@nestjs/common';
import { ScratchGitClient } from './scratch-git.client';

@Module({
  providers: [ScratchGitClient],
  exports: [ScratchGitClient],
})
export class ScratchGitModule {}
