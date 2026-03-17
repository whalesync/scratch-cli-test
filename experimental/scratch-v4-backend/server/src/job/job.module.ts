import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { JobService } from './job.service';

@Module({
  imports: [DbModule],
  providers: [JobService],
  exports: [JobService],
})
export class JobModule {}
