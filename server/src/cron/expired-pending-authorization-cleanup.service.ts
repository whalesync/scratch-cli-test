import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';

const LOG_SOURCE = 'ExpiredPendingAuthorizationCleanupService';

/**
 * How long a row is kept past its `expiresAt` before it's deleted. Expired rows are already rejected on read, so
 * this margin only protects work that began before the expiry. An inbound-install claim reserved just before its row
 * expired deletes that row itself on success; if the sweep got there first, the claim's delete would fail and roll
 * back the workbook it had just created. A CLI polling right at expiry also keeps getting "expired" instead of
 * "Invalid polling code".
 */
const GRACE_PERIOD_AFTER_EXPIRY_BEFORE_DELETION_MS = 60 * 60 * 1000;

/**
 * Periodically deletes expired rows from the two short-lived auth handoff tables, both of which hold credentials:
 *
 * - `PendingOAuthInstall` — marketplace-initiated ("inbound") OAuth installs (1-hour TTL), holding the encrypted
 *   access and refresh tokens until a user claims them. See `OAuthInstallService`.
 * - `AuthorizationCode` — `scratchmd auth login` device codes (10-minute TTL), holding the CLI API token once approved.
 *   See `CliAuthService`.
 *
 * Both are rejected on read once expired, so deleting them has no behavioral effect beyond the grace period above.
 * Each table is swept independently: a failure on one is logged and doesn't skip the other, and the run then throws
 * so a manual trigger reports the failure. Volumes are small (one row per install or CLI login), so each table is a
 * single `deleteMany` rather than a batched loop.
 */
@Injectable()
export class ExpiredPendingAuthorizationCleanupService {
  constructor(private readonly dbService: DbService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async deleteExpiredPendingOAuthInstallsAndCliAuthorizationCodes(): Promise<void> {
    const deletionCutoff = new Date(Date.now() - GRACE_PERIOD_AFTER_EXPIRY_BEFORE_DELETION_MS);
    const tableNamesWhoseSweepFailed: string[] = [];

    const sweepsByTableName: Record<string, () => Promise<{ count: number }>> = {
      PendingOAuthInstall: () =>
        this.dbService.client.pendingOAuthInstall.deleteMany({ where: { expiresAt: { lt: deletionCutoff } } }),
      AuthorizationCode: () =>
        this.dbService.client.authorizationCode.deleteMany({ where: { expiresAt: { lt: deletionCutoff } } }),
    };

    for (const [tableName, deleteExpiredRowsInTable] of Object.entries(sweepsByTableName)) {
      try {
        const { count: deletedRowCount } = await deleteExpiredRowsInTable();
        if (deletedRowCount > 0) {
          WSLogger.info({
            source: LOG_SOURCE,
            message: `Deleted ${deletedRowCount} expired ${tableName} row(s) (cutoff: ${deletionCutoff.toISOString()})`,
          });
        }
      } catch (error) {
        tableNamesWhoseSweepFailed.push(tableName);
        WSLogger.warn({ source: LOG_SOURCE, message: `Failed to delete expired ${tableName} rows`, error });
      }
    }

    if (tableNamesWhoseSweepFailed.length > 0) {
      throw new Error(`Failed to delete expired rows from: ${tableNamesWhoseSweepFailed.join(', ')}`);
    }
  }
}
