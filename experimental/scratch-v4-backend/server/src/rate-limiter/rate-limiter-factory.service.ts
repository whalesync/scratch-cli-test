import { Injectable } from '@nestjs/common';
import { Service } from 'src/types/shared-types';
import { RateLimiter } from './rate-limiter';

/**
 * Simplified RateLimiterFactory for the experimental backend.
 * Returns undefined for all services (no throttling).
 * The real implementation requires Redis; swap in server/src/rate-limiter/rate-limiter-factory.service.ts
 * when this is folded back into the main server.
 */
@Injectable()
export class RateLimiterFactory {
  createLimiter(_params: { service: Service; connectorAccountId: string }): RateLimiter | undefined {
    return undefined;
  }
}
