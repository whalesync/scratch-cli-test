import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { MigrationLockService } from './migration-lock.service';

/**
 * DEV-9698 (T4) — exposes the lightweight {@link MigrationLockService} (the
 * per-connection migration lock gate) to the modules that must respect it: the
 * write paths (workbook/files, CLI upload-patch) and the job enqueuer. Depends
 * only on `DbModule`, so importing it anywhere is cycle-safe.
 */
@Module({
  imports: [DbModule],
  providers: [MigrationLockService],
  exports: [MigrationLockService],
})
export class MigrationLockModule {}
