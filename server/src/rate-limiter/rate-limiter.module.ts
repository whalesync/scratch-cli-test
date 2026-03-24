import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { ApiRateLimitGuard } from './api-rate-limit.guard';
import { RateLimiterFactory } from './rate-limiter-factory.service';

@Module({
  imports: [ScratchConfigModule],
  providers: [RateLimiterFactory, ApiRateLimitGuard],
  exports: [RateLimiterFactory, ApiRateLimitGuard],
})
export class RateLimiterModule {}
