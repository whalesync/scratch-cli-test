import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import IORedis from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { AuthenticatedUser, RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { API_RATE_LIMIT_KEY, API_RATE_LIMIT_WEIGHT_KEY } from './api-rate-limit.decorator';
import { RateLimiterSpec } from './rate-limiter.types';

const LOG_SOURCE = 'ApiRateLimitGuard';

/** Default rate limit applied when @ApiRateLimit() is not specified but the guard is active */
const DEFAULT_SPEC: RateLimiterSpec = { points: 60, duration: 60 };

/** Higher rate limit for tokens with the 'rate-limit:high' scope */
const HIGH_SPEC: RateLimiterSpec = { points: 200, duration: 60 };

@Injectable()
export class ApiRateLimitGuard implements CanActivate, OnModuleInit, OnModuleDestroy {
  private redis?: IORedis;
  private limiters = new Map<string, RateLimiterRedis>();

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ScratchConfigService,
  ) {}

  onModuleInit() {
    this.redis = new IORedis({
      host: this.configService.getRedisHost(),
      port: this.configService.getRedisPort(),
      password: this.configService.getRedisPassword(),
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      lazyConnect: true,
    });

    this.redis.connect().catch((err) => {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to connect to Redis for API rate limiting, guard will fail open',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async onModuleDestroy() {
    await this.redis?.quit();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user as AuthenticatedUser | undefined;

    // Only rate limit API token requests (CLI and REST API)
    if (!user || user.authType !== 'api-token') {
      return true;
    }

    const scopes = user.apiToken?.scopes ?? [];

    // Tokens with unlimited scope bypass rate limiting entirely
    if (scopes.includes('rate-limit:unlimited')) {
      return true;
    }

    // Tokens with high scope get a higher rate limit
    const baseSpec =
      this.reflector.get<RateLimiterSpec>(API_RATE_LIMIT_KEY, context.getHandler()) ??
      this.reflector.get<RateLimiterSpec>(API_RATE_LIMIT_KEY, context.getClass()) ??
      DEFAULT_SPEC;

    const spec = scopes.includes('rate-limit:high') ? HIGH_SPEC : baseSpec;

    const weight =
      this.reflector.get<number>(API_RATE_LIMIT_WEIGHT_KEY, context.getHandler()) ??
      this.reflector.get<number>(API_RATE_LIMIT_WEIGHT_KEY, context.getClass()) ??
      1;

    const limiter = this.getOrCreateLimiter(spec);
    if (!limiter) {
      return true; // fail open — Redis not available
    }

    const key = user.id;

    try {
      await limiter.consume(key, weight);
      return true;
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        const retryAfterS = Math.ceil(error.msBeforeNext / 1000);
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `API rate limit exceeded for user ${key}, retry after ${retryAfterS}s`,
        });

        context.switchToHttp().getResponse<import('express').Response>().setHeader('Retry-After', String(retryAfterS));

        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests. Please try again later.',
            retryAfterS,
          },
          HttpStatus.TOO_MANY_REQUESTS,
          { cause: error },
        );
      }

      // Redis error — fail open
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'API rate limiter Redis error, failing open',
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  /**
   * Get or create a RateLimiterRedis instance for the given spec.
   * Limiters are cached by their points:duration key to avoid creating duplicates.
   */
  private getOrCreateLimiter(spec: RateLimiterSpec): RateLimiterRedis | undefined {
    if (!this.redis) {
      return undefined;
    }

    const cacheKey = `${spec.points}:${spec.duration}`;
    let limiter = this.limiters.get(cacheKey);
    if (!limiter) {
      limiter = new RateLimiterRedis({
        storeClient: this.redis,
        keyPrefix: `api-rl:${spec.points}:${spec.duration}`,
        points: spec.points,
        duration: spec.duration,
      });
      this.limiters.set(cacheKey, limiter);
    }
    return limiter;
  }
}
