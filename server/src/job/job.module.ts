import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { MetricsModule } from 'src/metrics/metrics.module';
import { RateLimiterModule } from 'src/rate-limiter/rate-limiter.module';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { JobController } from './job.controller';
import { JobService } from './job.service';

@Module({
  imports: [AuthModule, DbModule, MetricsModule, ScratchConfigModule, RateLimiterModule],
  controllers: [JobController],
  providers: [JobService],
  exports: [JobService],
})
export class JobModule {}
