import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { PendingOAuthAuthorization } from './types';

/**
 * How long an OAuth connect may take from `initiate` to `callback`. The clock starts
 * before the user reaches the provider, so it has to cover signing in to (or signing
 * up for) the provider account and any 2FA — the same reasoning, and the same hour,
 * as the inbound install stash (`INBOUND_INSTALL_TTL_MS`).
 */
export const OAUTH_PENDING_AUTHORIZATION_TTL_SECONDS = 60 * 60;

const OAUTH_PENDING_AUTHORIZATION_KEY_PREFIX = 'oauth:pending-authorization:';

/**
 * Commands fail after this many reconnect attempts instead of queueing forever, so an
 * unreachable Redis surfaces as a "try again" error on initiate/callback rather than a
 * request that hangs until the HTTP timeout.
 */
const REDIS_MAX_RETRIES_PER_REQUEST = 2;

function buildPendingAuthorizationRedisKey(userId: string, pendingAuthorizationNonce: string): string {
  return `${OAUTH_PENDING_AUTHORIZATION_KEY_PREFIX}${userId}:${pendingAuthorizationNonce}`;
}

/**
 * Server-side half of an in-flight OAuth connect (DEV-12155).
 *
 * The OAuth `state` round-trips through the browser, the provider and Whalesync's
 * redirect page, so nothing in it can be trusted. `initiateOAuth` keeps everything
 * the callback acts on — who started the flow, which workbook and connection it
 * targets, the PKCE verifier, any BYO client secret — here, under a random nonce,
 * and the state carries only that nonce plus the routing fields the frontends read.
 *
 * Records are single-use and expire after {@link OAUTH_PENDING_AUTHORIZATION_TTL_SECONDS}.
 * The key includes the userId, so a leaked state cannot be consumed (or burned) by
 * anyone but the user who started the flow.
 */
@Injectable()
export class OAuthPendingAuthorizationStore implements OnModuleDestroy {
  private readonly redis: IORedis;

  constructor(private readonly configService: ScratchConfigService) {
    // Lazy: OAuthService is instantiated in every process (worker and cron included),
    // and only the API ever starts or finishes a connect.
    this.redis = new IORedis({
      host: this.configService.getRedisHost(),
      port: this.configService.getRedisPort(),
      password: this.configService.getRedisPassword(),
      lazyConnect: true,
      maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }

  /** Store the record for a new connect and return the nonce that identifies it. */
  async savePendingAuthorizationAndReturnNonce(pendingAuthorization: PendingOAuthAuthorization): Promise<string> {
    const pendingAuthorizationNonce = randomBytes(32).toString('base64url');
    try {
      await this.redis.set(
        buildPendingAuthorizationRedisKey(pendingAuthorization.userId, pendingAuthorizationNonce),
        JSON.stringify(pendingAuthorization),
        'EX',
        OAUTH_PENDING_AUTHORIZATION_TTL_SECONDS,
      );
    } catch (error) {
      WSLogger.error({
        source: 'OAuthPendingAuthorizationStore.savePendingAuthorizationAndReturnNonce',
        message: 'Failed to store pending OAuth authorization',
        error,
        service: pendingAuthorization.service,
      });
      throw new ServiceUnavailableException('Could not start the connection. Please try again.');
    }
    return pendingAuthorizationNonce;
  }

  /**
   * Atomically read and delete the record `userId` stored under this nonce. Resolves
   * to null when there is none: never issued, issued to another user, expired, or
   * already consumed.
   *
   * GET + DEL inside MULTI rather than GETDEL, which needs Redis 6.2 — the
   * Memorystore version isn't pinned.
   */
  async consumePendingAuthorizationForUser(
    userId: string,
    pendingAuthorizationNonce: string,
  ): Promise<PendingOAuthAuthorization | null> {
    const pendingAuthorizationRedisKey = buildPendingAuthorizationRedisKey(userId, pendingAuthorizationNonce);
    let storedPendingAuthorizationJson: unknown;
    try {
      const transactionResults = await this.redis
        .multi()
        .get(pendingAuthorizationRedisKey)
        .del(pendingAuthorizationRedisKey)
        .exec();
      const [getCommandError, getCommandResult] = transactionResults?.[0] ?? [null, null];
      if (getCommandError) {
        throw getCommandError;
      }
      storedPendingAuthorizationJson = getCommandResult;
    } catch (error) {
      WSLogger.error({
        source: 'OAuthPendingAuthorizationStore.consumePendingAuthorizationForUser',
        message: 'Failed to read pending OAuth authorization',
        error,
      });
      throw new ServiceUnavailableException('Could not finish the connection. Please try connecting again.');
    }

    if (typeof storedPendingAuthorizationJson !== 'string') {
      return null;
    }
    return JSON.parse(storedPendingAuthorizationJson) as PendingOAuthAuthorization;
  }
}
