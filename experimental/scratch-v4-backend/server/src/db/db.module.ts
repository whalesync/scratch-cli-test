import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbService } from './db.service';

@Module({
  imports: [ScratchConfigModule],
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
