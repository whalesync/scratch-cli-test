import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ScratchGitModule } from '../scratch-git/scratch-git.module';
import { WorkbookRepoService } from '../workbook/workbook-repo.service';
import { CodeMigrationsController } from './code-migrations.controller';

@Module({
  imports: [DbModule, ScratchGitModule],
  controllers: [CodeMigrationsController],
  providers: [WorkbookRepoService],
})
export class CodeMigrationsModule {}
