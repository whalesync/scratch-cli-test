import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Schedule } from '@prisma/client';
import { DataFolderId, SyncId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { Actor } from 'src/users/types';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { ScheduleService } from './schedule.service';
import { actionToJobType, SCHEDULE_DEBOUNCE_WINDOW_MS } from './schedule.types';

@Injectable()
export class SchedulerService {
  constructor(
    private readonly scheduleService: ScheduleService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly db: DbService,
  ) {
    WSLogger.info({ source: 'SchedulerService', message: 'Schedule evaluator initializing...' });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async evaluateSchedules(): Promise<void> {
    WSLogger.debug({ source: 'SchedulerService', message: 'Starting schedule evaluation cycle' });

    const dueSchedules = await this.scheduleService.findDueSchedules();

    if (dueSchedules.length === 0) {
      WSLogger.debug({ source: 'SchedulerService', message: 'No due schedules found' });
      return;
    }

    let triggered = 0;
    let skipped = 0;

    for (const schedule of dueSchedules) {
      try {
        const busy = await this.isWorkbookBusy(schedule.workbookId);
        if (busy) {
          skipped++;
          continue;
        }

        const recent = await this.wasRecentlyTriggered(schedule);
        if (recent) {
          skipped++;
          continue;
        }

        // Compute the next run time before claiming
        const nextRunAt = this.scheduleService.computeNextRunAt(schedule.cronExpression);

        // Atomic claim — prevents double-firing across instances
        const claimed = await this.scheduleService.atomicClaim(schedule.id, nextRunAt);
        if (!claimed) {
          skipped++;
          continue;
        }

        const exists = await this.scheduleService.entityExists(schedule.workbookId, schedule.action, schedule.entityId);
        if (!exists) {
          WSLogger.error({
            source: 'SchedulerService.evaluateSchedules',
            message: `Entity ${schedule.entityId} for ${schedule.action} schedule ${schedule.id} no longer exists. Disabling schedule.`,
          });
          await this.scheduleService.disableSchedule(schedule.id);
          skipped++;
          continue;
        }

        await this.enqueueJob(schedule);
        triggered++;
      } catch (error) {
        WSLogger.error({
          source: 'SchedulerService.evaluateSchedules',
          message: `Failed to evaluate schedule ${schedule.id}`,
          error,
        });
        skipped++;
      }
    }

    WSLogger.info({
      source: 'SchedulerService.evaluateSchedules',
      message: `Evaluated ${dueSchedules.length} schedules, triggered ${triggered}, skipped ${skipped} (busy/debounced)`,
    });
  }

  /** Check if there are any active jobs on the workbook. */
  private async isWorkbookBusy(workbookId: string): Promise<boolean> {
    const activeJobs = await this.db.client.dbJob.count({
      where: {
        workbookId,
        status: { in: ['created', 'active'] },
      },
    });
    return activeJobs > 0;
  }

  /** Check if a job of the same type was recently created for the same entity. */
  private async wasRecentlyTriggered(schedule: Schedule): Promise<boolean> {
    const jobType = actionToJobType(schedule.action);
    const cutoff = new Date(Date.now() - SCHEDULE_DEBOUNCE_WINDOW_MS);

    if (schedule.action === 'SYNC') {
      const recentJob = await this.db.client.dbJob.findFirst({
        where: {
          workbookId: schedule.workbookId,
          type: jobType,
          createdAt: { gte: cutoff },
          data: { path: ['syncId'], equals: schedule.entityId },
        },
      });
      return recentJob !== null;
    }

    // For PULL/PUBLISH, check by dataFolderId
    const recentJob = await this.db.client.dbJob.findFirst({
      where: {
        dataFolderId: schedule.entityId,
        type: jobType,
        createdAt: { gte: cutoff },
      },
    });
    return recentJob !== null;
  }

  /** Enqueue the appropriate job based on the schedule's action. */
  private async enqueueJob(schedule: Schedule): Promise<void> {
    const actor = await this.buildActor(schedule);
    const workbookId = schedule.workbookId as WorkbookId;

    const runContext = createRunContext('scheduler');

    switch (schedule.action) {
      case 'PULL':
        if (schedule.entityId) {
          await this.bullEnqueuerService.enqueuePullLinkedFolderFilesJob(
            workbookId,
            actor,
            [schedule.entityId as DataFolderId],
            undefined,
            runContext,
          );
        } else {
          WSLogger.info({
            source: 'SchedulerService.enqueueJob',
            message: `No entity ID found for pull schedule ${schedule.id}. Skipping.`,
          });
        }
        break;
      case 'PUBLISH':
        if (schedule.entityId) {
          await this.bullEnqueuerService.enqueuePublishDataFolderJob(
            workbookId,
            actor,
            [schedule.entityId as DataFolderId],
            undefined,
            runContext,
          );
        } else {
          WSLogger.info({
            source: 'SchedulerService.enqueueJob',
            message: `No entity ID found for publish schedule ${schedule.id}. Skipping.`,
          });
        }
        break;
      case 'SYNC':
        await this.bullEnqueuerService.enqueueSyncDataFoldersJob(
          workbookId,
          schedule.entityId as SyncId,
          actor,
          undefined,
          runContext,
        );
        break;
    }

    WSLogger.debug({
      source: 'SchedulerService.enqueueJob',
      message: `Enqueued ${schedule.action} job for schedule ${schedule.id} (entity: ${schedule.entityId})`,
    });
  }

  /**
   * Build an Actor from the schedule's userId and organizationId.
   * If the user was deleted (userId is null), fall back to the org owner.
   */
  private async buildActor(schedule: Schedule): Promise<Actor> {
    if (schedule.userId) {
      return {
        userId: schedule.userId,
        organizationId: schedule.organizationId,
      };
    }

    // User was deleted — find the first user in the organization as fallback
    const orgUser = await this.db.client.user.findFirst({
      where: { organizationId: schedule.organizationId },
      select: { id: true },
    });

    if (!orgUser) {
      throw new Error(
        `Cannot build actor for schedule ${schedule.id}: no users found in organization ${schedule.organizationId}`,
      );
    }

    return {
      userId: orgUser.id,
      organizationId: schedule.organizationId,
    };
  }
}
