import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { minutes } from 'src/utils/duration';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';

const STALE_THRESHOLD = minutes(5);

@Injectable()
export class StaleJobReaperService {
  constructor(
    private readonly dbService: DbService,
    private readonly jobService: JobService,
    private readonly bullEnqueuerService: BullEnqueuerService,
  ) {}

  /**
   * This exists because i've seen jobs that are stuck in "Created" for days with no BullMQ job, blocking other work.
   * It can be safely deleted if you don't see evidence of the logs below every having work.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reapStaleCreatedJobs(): Promise<void> {
    const staleJobs = await this.dbService.client.dbJob.findMany({
      where: {
        status: 'created',
        createdAt: { lt: STALE_THRESHOLD.inPast() },
      },
    });

    if (staleJobs.length === 0) return;

    WSLogger.info({
      source: 'StaleJobReaperService',
      message: `Found ${staleJobs.length} stale job(s) in 'created' status`,
    });

    for (const dbJob of staleJobs) {
      try {
        const bullJob = dbJob.bullJobId ? await this.bullEnqueuerService.getJob(dbJob.bullJobId) : undefined;

        if (bullJob) {
          const state = await bullJob.getState();
          if (!['completed', 'failed', 'unknown'].includes(state)) {
            // BullMQ job still exists and is active/waiting — skip
            continue;
          }
        }

        // No BullMQ job or it's in a terminal state — mark as failed
        await this.jobService.updateJobStatus({
          id: dbJob.id,
          status: 'failed',
          error: 'Reaped: DbJob was stuck in created status with no active BullMQ job',
          finishedOn: new Date(),
        });

        // Clear DataFolder lock if one is set for this job's folder
        if (dbJob.dataFolderId) {
          await this.dbService.client.dataFolder.updateMany({
            where: { id: dbJob.dataFolderId, lock: { not: null } },
            data: { lock: null },
          });
        }

        WSLogger.info({
          source: 'StaleJobReaperService',
          message: `Reaped stale job ${dbJob.id} (bullJobId: ${dbJob.bullJobId}, type: ${dbJob.type}, workbookId: ${dbJob.workbookId})`,
        });
      } catch (error) {
        WSLogger.error({
          source: 'StaleJobReaperService',
          message: `Failed to reap stale job ${dbJob.id}`,
          error,
        });
      }
    }
  }
}
