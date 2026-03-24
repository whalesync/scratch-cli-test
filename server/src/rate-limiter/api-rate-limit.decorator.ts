import { SetMetadata } from '@nestjs/common';
import { RateLimiterSpec } from './rate-limiter.types';

export const API_RATE_LIMIT_KEY = 'API_RATE_LIMIT';
export const API_RATE_LIMIT_WEIGHT_KEY = 'API_RATE_LIMIT_WEIGHT';

/**
 * Decorator to set rate limit configuration on a controller or route.
 * When applied, the ApiRateLimitGuard will enforce the specified limits
 * for requests authenticated via API token (CLI and REST API).
 *
 * @param spec - Rate limit configuration (points per duration window)
 */
export const ApiRateLimit = (spec: RateLimiterSpec) => SetMetadata(API_RATE_LIMIT_KEY, spec);

/**
 * Decorator to set the weight (points consumed) for a single request.
 * Defaults to 1 if not specified. Use higher values for expensive operations
 * so they consume more of the rate limit budget.
 *
 * @param weight - Number of points this request consumes (default: 1)
 */
export const ApiRateLimitWeight = (weight: number) => SetMetadata(API_RATE_LIMIT_WEIGHT_KEY, weight);
