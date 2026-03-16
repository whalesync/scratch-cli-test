import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';

const RETENTION_DAYS = 60;
const BATCH_SIZE = 100;
const TERMINAL_STATUSES = ['completed', 'failed', 'canceled'];

function utcCutoffDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - RETENTION_DAYS));
}

@Injectable()
export class OldJobCleanupService {
  constructor(private readonly dbService: DbService) {}

  /**
   * Deletes old completed/failed/canceled jobs that are pass the retention period.
   *
   * Jobs are deleted by runId so that entire runs are removed atomically, avoiding partial run data showing up in the UI.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupOldJobs(): Promise<void> {
    WSLogger.info({ source: 'OldJobCleanupService', message: 'Waking up, starting old job cleanup' });
    const cutoffDate = utcCutoffDate();
    let totalDeletedByRun = 0;

    // Delete runs in batches until no more old, terminal runs are found
    while (true) {
      const oldRuns = await this.dbService.client.dbJob.findMany({
        where: {
          runId: { not: null },
          createdAt: { lt: cutoffDate },
          status: { in: TERMINAL_STATUSES },
        },
        distinct: ['runId'],
        select: { runId: true },
        take: BATCH_SIZE,
      });

      if (oldRuns.length === 0) break;

      let deletedInBatch = 0;
      for (const row of oldRuns) {
        const runId = row.runId!;

        // Skip runs that still have recent or active jobs
        const hasActiveOrRecentJobs = await this.dbService.client.dbJob.count({
          where: {
            runId,
            OR: [{ createdAt: { gte: cutoffDate } }, { status: { notIn: TERMINAL_STATUSES } }],
          },
        });

        if (hasActiveOrRecentJobs > 0) continue;

        const { count } = await this.dbService.client.dbJob.deleteMany({
          where: { runId },
        });
        deletedInBatch += count;
      }

      totalDeletedByRun += deletedInBatch;

      // If nothing was deleted this batch (all runs had active/recent jobs), stop
      if (deletedInBatch === 0) break;
    }

    if (totalDeletedByRun > 0) {
      WSLogger.info({
        source: 'OldJobCleanupService',
        message: `Deleted ${totalDeletedByRun} old job(s) by run (cutoff: ${cutoffDate.toISOString()})`,
      });
    } else {
      WSLogger.info({
        source: 'OldJobCleanupService',
        message: `No old jobs to clean up (cutoff: ${cutoffDate.toISOString()})`,
      });
    }
  }
}
