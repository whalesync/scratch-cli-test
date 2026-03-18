import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import IORedis from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { connectorRegistry } from 'src/remote-service/connectors/connector-registry';
import { RateLimiter } from './rate-limiter';

const LOG_SOURCE = 'RateLimiterFactory';

@Injectable()
export class RateLimiterFactory implements OnModuleInit, OnModuleDestroy {
  private redis?: IORedis;

  constructor(private readonly configService: ScratchConfigService) {}

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
        message: `Failed to connect to Redis for rate limiting, limiters will fail open`,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async onModuleDestroy() {
    await this.redis?.quit();
  }

  /**
   * Create a rate limiter for a specific service and connector account.
   * Returns undefined if the service has no rate limiter spec configured.
   */
  createLimiter(params: { service: string; connectorAccountId: string }): RateLimiter | undefined {
    const { service, connectorAccountId } = params;
    const spec = connectorRegistry.get(service)?.rateLimiterSpec;
    if (!spec || !this.redis) {
      return undefined;
    }

    const limiter = new RateLimiterRedis({
      storeClient: this.redis,
      keyPrefix: `rl:${service}:${connectorAccountId}`,
      points: spec.points,
      duration: spec.duration,
      insuranceLimiter: undefined,
    });

    return new RateLimiter(limiter);
  }
}
