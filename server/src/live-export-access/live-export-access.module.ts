import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { LiveExportAccessService } from './live-export-access.service';

/**
 * Carries out the Live Export access Whalesync sets for each team (DEV-12983). Depends only on the database, so the
 * routine executor and the workers can both import it.
 */
@Module({
  imports: [DbModule],
  providers: [LiveExportAccessService],
  exports: [LiveExportAccessService],
})
export class LiveExportAccessModule {}
