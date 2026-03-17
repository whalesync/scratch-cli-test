import { Module } from '@nestjs/common';
import { RateLimiterFactory } from './rate-limiter-factory.service';

@Module({
  providers: [RateLimiterFactory],
  exports: [RateLimiterFactory],
})
export class RateLimiterModule {}
