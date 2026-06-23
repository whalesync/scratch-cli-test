import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { ScratchGitModule } from 'src/scratch-git/scratch-git.module';
import { WorkbookEventModule } from 'src/workbook/workbook-event.module';
import { RecordCountService } from './record-count.service';

@Module({
  imports: [DbModule, ScratchGitModule, WorkbookEventModule],
  providers: [RecordCountService],
  exports: [RecordCountService],
})
export class RecordCountModule {}
