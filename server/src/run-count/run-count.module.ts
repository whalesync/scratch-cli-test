import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { RunCountService } from './run-count.service';

/**
 * Per-organization monthly run-execution counting (Pull / Publish / Sync / Routine) — see
 * {@link RunCountService}. Imported by the worker (job completions/failures), the routine executor
 * (routine terminal states), and the workbook controller (Billing Usage panel summary).
 */
@Module({
  imports: [DbModule],
  providers: [RunCountService],
  exports: [RunCountService],
})
export class RunCountModule {}
