import { Service } from '@spinner/shared-types';

export interface RateLimiterSpec {
  /** Maximum number of requests (points) in the window */
  points: number;
  /** Window duration in seconds */
  duration: number;
}

/**
 * Per-service rate limiter specs.
 * These represent conservative limits to stay under API quotas.
 */
export const RATE_LIMITER_SPECS: Partial<Record<Service, RateLimiterSpec>> = {
  [Service.AIRTABLE]: { points: 5, duration: 1 }, // 5 req/sec
  [Service.WEBFLOW]: { points: 120, duration: 60 }, // 120 req/min
  [Service.SHOPIFY]: { points: 4, duration: 1 }, // 4 req/sec (coarse safety net)
};
