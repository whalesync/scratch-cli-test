import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Schedule } from '@prisma/client';
import { DataFolderId, SyncId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { RoutineExecutorService } from 'src/routine/routine-executor.service';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext } from 'src/worker/jobs/base-types';
import { ScheduleService } from './schedule.service';
import {
  actionToJobType,
  isConnectionPullAction,
  SCHEDULE_DEBOUNCE_WINDOW_MS,
  scheduleActionToPullMode,
} from './schedule.types';

@Injectable()
export class SchedulerService {
  constructor(
    private readonly scheduleService: ScheduleService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly db: DbService,
    private readonly dataFolderService: DataFolderService,
    private readonly publishPlanBuildService: PublishPlanBuildService,
    private readonly routineExecutorService: RoutineExecutorService,
  ) {
    WSLogger.info({ source: 'SchedulerService', message: 'Schedule evaluator initializing...' });
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
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
        // Skip schedules whose workbook is flagged for deletion. The hard-delete worker
        // will tear the schedule rows down via Workbook cascade; suppressing fires here
        // avoids enqueueing jobs that the BullEnqueuer guard would reject anyway.
        const pending = await this.isWorkbookPendingDelete(schedule.workbookId);
        if (pending) {
          skipped++;
          continue;
        }

        // ROUTINE schedules don't enqueue a single job — they trigger a multi-step run. They take
        // their own path (claim + triggerRun) and skip the per-job checks below, which all assume a
        // single JobType: wasRecentlyTriggered → actionToJobType throws, entityId is a file path (not
        // a DB entity for entityExists), "one run at a time" is per-routine (triggerRun's unique
        // index), and isWorkbookBusy would wrongly suppress a routine for an unrelated job.
        if (schedule.action === 'ROUTINE') {
          const didTrigger = await this.evaluateRoutineSchedule(schedule);
          if (didTrigger) {
            triggered++;
          } else {
            skipped++;
          }
          continue;
        }

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

  /** Check if the workbook is flagged for async deletion. */
  private async isWorkbookPendingDelete(workbookId: string): Promise<boolean> {
    const wb = await this.db.client.workbook.findUnique({
      where: { id: workbookId },
      select: { isPendingDelete: true },
    });
    return wb?.isPendingDelete ?? false;
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
    // Connection-wide pull schedules are not debounced per-entity. Their job covers
    // many folders (no single `dataFolderId` to key on), and the debounce is
    // unnecessary here: `atomicClaim` advances `nextRunAt` by a full cron interval
    // (≥ the debounce window) so the same schedule can't re-fire within the window,
    // multi-instance double-claim is prevented by `atomicClaim`, two schedules due
    // at once are serialized (not dropped) by the `isWorkbookBusy` deferral, and the
    // connection/per-table modes are mutually exclusive so no folder is ever covered
    // by both a connection and a table schedule simultaneously.
    if (isConnectionPullAction(schedule.action)) {
      return false;
    }

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

    if (schedule.action === 'PUBLISH') {
      const recentJob = await this.db.client.dbJob.findFirst({
        where: {
          dataFolderId: schedule.entityId,
          type: jobType,
          createdAt: { gte: cutoff },
        },
      });
      return recentJob !== null;
    }

    // Pull actions (PULL / FULL_PULL / INCREMENTAL_PULL) all map to the same job
    // type, so discriminate the debounce key by the resolved pull mode. This keeps
    // an INCREMENTAL_PULL from suppressing a FULL_PULL (or vice versa) scheduled
    // seconds apart on the same folder. Legacy PULL and FULL_PULL both resolve to
    // 'full' and therefore share a key — acceptable, they're equivalent at runtime.
    // Note: only scheduler-enqueued pull jobs carry an explicit `pullMode`; manual
    // (web/CLI without `mode`) and bootstrap enqueues omit it and don't share this
    // key. Any rare overlap is absorbed by idempotent file commits.
    const pullMode = scheduleActionToPullMode(schedule.action);
    const recentJob = await this.db.client.dbJob.findFirst({
      where: {
        dataFolderId: schedule.entityId,
        type: jobType,
        createdAt: { gte: cutoff },
        data: { path: ['pullMode'], equals: pullMode },
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
      case 'FULL_PULL':
      case 'INCREMENTAL_PULL':
        if (schedule.entityId) {
          await this.bullEnqueuerService.enqueuePullLinkedFolderFilesJob(
            workbookId,
            actor,
            [schedule.entityId as DataFolderId],
            undefined,
            runContext,
            scheduleActionToPullMode(schedule.action),
          );
        } else {
          WSLogger.info({
            source: 'SchedulerService.enqueueJob',
            message: `No entity ID found for pull schedule ${schedule.id}. Skipping.`,
          });
        }
        break;
      case 'CONNECTION_FULL_PULL':
      case 'CONNECTION_INCREMENTAL_PULL': {
        // entityId is a ConnectorAccountId. Fan out to every linked table in the
        // connection and enqueue a single pull job for the whole set — the same
        // behavior as the "Pull All Tables" menu action, but driven by the schedule.
        const linkedFolderIdsInConnection = (
          await this.db.client.dataFolder.findMany({
            where: { workbookId, connectorAccountId: schedule.entityId },
            select: { id: true },
          })
        ).map((folder) => folder.id as DataFolderId);

        if (linkedFolderIdsInConnection.length === 0) {
          WSLogger.info({
            source: 'SchedulerService.enqueueJob',
            message: `Connection pull schedule ${schedule.id} has no linked tables for connector account ${schedule.entityId}. Skipping.`,
          });
          break;
        }

        await this.bullEnqueuerService.enqueuePullLinkedFolderFilesJob(
          workbookId,
          actor,
          linkedFolderIdsInConnection,
          undefined,
          runContext,
          scheduleActionToPullMode(schedule.action),
        );
        break;
      }
      case 'PUBLISH': {
        if (!schedule.entityId) {
          WSLogger.info({
            source: 'SchedulerService.enqueueJob',
            message: `No entity ID found for publish schedule ${schedule.id}. Skipping.`,
          });
          break;
        }

        const dataFolder = await this.dataFolderService.findOne(schedule.entityId as DataFolderId, actor);

        if (!dataFolder.path || !dataFolder.connectorAccountId) {
          WSLogger.warn({
            source: 'SchedulerService.enqueueJob',
            message: `Publish schedule ${schedule.id} skipped: data folder ${schedule.entityId} missing path or connectorAccountId`,
          });
          break;
        }

        const { pipelineId } = await this.publishPlanBuildService.createPipeline(
          workbookId,
          actor.userId,
          dataFolder.connectorAccountId,
        );

        const publishJob = await this.bullEnqueuerService.enqueuePlanPipelineJob(
          workbookId,
          actor,
          pipelineId,
          dataFolder.connectorAccountId,
          true,
          dataFolder.path,
          undefined,
          undefined,
          runContext,
        );
        if (publishJob.id === undefined) {
          throw new Error(
            `Publish job for schedule ${schedule.id} (pipeline ${pipelineId}) was enqueued without an id`,
          );
        }
        await this.publishPlanBuildService.setActiveJob(pipelineId, publishJob.id.toString());
        break;
      }
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
   * Handle a due ROUTINE schedule: claim it (advancing `nextRunAt` so a failed trigger doesn't
   * retry every 10s), then trigger a schedule-driven run. Returns whether a run was triggered. A
   * 409 (routine already running) or 404 (file deleted) is logged and treated as "not triggered".
   */
  private async evaluateRoutineSchedule(schedule: Schedule): Promise<boolean> {
    const nextRunAt = this.scheduleService.computeNextRunAt(schedule.cronExpression);
    const claimed = await this.scheduleService.atomicClaim(schedule.id, nextRunAt);
    if (!claimed) {
      return false;
    }

    try {
      await this.routineExecutorService.triggerRun(schedule.workbookId as WorkbookId, schedule.entityId, 'schedule');
      return true;
    } catch (error) {
      WSLogger.warn({
        source: 'SchedulerService.evaluateRoutineSchedule',
        message: `Did not trigger ROUTINE schedule ${schedule.id} (${schedule.entityId}): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      });
      return false;
    }
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
