import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { WorkbookService } from './workbook.service';

@Module({
  imports: [DbModule],
  providers: [WorkbookService],
  exports: [WorkbookService],
})
export class WorkbookModule {}
