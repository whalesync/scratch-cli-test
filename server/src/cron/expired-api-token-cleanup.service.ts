import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TokenType } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';

const LOG_SOURCE = 'ExpiredApiTokenCleanupService';
const BATCH_SIZE = 1000;

/**
 * Periodically deletes expired WHALESYNC_SESSION `ApiToken` rows. These short-lived tokens (10-minute
 * TTL, minted on every Dusky session refresh) would otherwise grow the table unbounded. Expired rows are
 * already inert — `UsersService.getUserFromAPIToken` only matches `expiresAt > now()` — so deleting them
 * has no behavioral effect.
 *
 * Scoped to WHALESYNC_SESSION for now (the only high-churn token type); broaden the type filter later if
 * other token types need garbage collection. Deletes are batched to avoid holding a long lock on a hot table.
 */
@Injectable()
export class ExpiredApiTokenCleanupService {
  constructor(private readonly dbService: DbService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredWhalesyncSessionTokens(): Promise<void> {
    const cutoff = new Date();
    let totalDeleted = 0;

    // Delete in bounded batches until no expired session tokens remain.
    while (true) {
      const expiredTokens = await this.dbService.client.apiToken.findMany({
        where: { type: TokenType.WHALESYNC_SESSION, expiresAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });

      if (expiredTokens.length === 0) {
        break;
      }

      const { count } = await this.dbService.client.apiToken.deleteMany({
        where: { id: { in: expiredTokens.map((token) => token.id) } },
      });
      totalDeleted += count;

      // A short final batch means we've drained the backlog; avoid an extra empty query.
      if (expiredTokens.length < BATCH_SIZE) {
        break;
      }
    }

    if (totalDeleted > 0) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: `Deleted ${totalDeleted} expired Whalesync session token(s) (cutoff: ${cutoff.toISOString()})`,
      });
    }
  }
}
