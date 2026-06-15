import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ScheduleAction as PrismaScheduleAction, Schedule } from '@prisma/client';
import {
  createScheduleId,
  ScheduleAction,
  ValidatedCreateScheduleDto,
  ValidatedUpdateScheduleDto,
  WorkbookId,
} from '@spinner/shared-types';
import { CronExpressionParser } from 'cron-parser';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { Actor } from 'src/users/types';
import { ScheduleEntity } from './entities/schedule.entity';
import { isConnectionPullAction, isPullAction, SCHEDULE_MIN_INTERVAL_MINUTES } from './schedule.types';

@Injectable()
export class ScheduleService {
  constructor(private readonly db: DbService) {}

  async create(workbookId: WorkbookId, dto: ValidatedCreateScheduleDto, actor: Actor): Promise<ScheduleEntity> {
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: workbookId },
    });
    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }

    this.validateCronExpression(dto.cronExpression);
    await this.validateEntityId(workbookId, dto.action, dto.entityId);

    const nextRunAt = this.computeNextRunAt(dto.cronExpression);

    const schedule = await this.db.client.schedule.create({
      data: {
        id: createScheduleId(),
        workbookId,
        organizationId: workbook.organizationId,
        userId: actor.userId,
        name: dto.name,
        action: dto.action,
        entityId: dto.entityId,
        cronExpression: dto.cronExpression,
        enabled: dto.enabled ?? true,
        nextRunAt,
      },
    });
    return new ScheduleEntity(schedule);
  }

  async findAllForWorkbook(workbookId: WorkbookId): Promise<ScheduleEntity[]> {
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: workbookId },
    });
    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }

    const schedules = await this.db.client.schedule.findMany({
      where: { workbookId },
      orderBy: { createdAt: 'desc' },
    });
    return schedules.map((s) => new ScheduleEntity(s));
  }

  async findByEntity(workbookId: WorkbookId, action: ScheduleAction, entityId: string): Promise<ScheduleEntity | null> {
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: workbookId },
    });
    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }

    const schedule = await this.db.client.schedule.findFirst({
      where: { workbookId, action, entityId },
    });
    return schedule ? new ScheduleEntity(schedule) : null;
  }

  async findOne(workbookId: WorkbookId, scheduleId: string): Promise<ScheduleEntity> {
    const schedule = await this.db.client.schedule.findFirst({
      where: { id: scheduleId, workbookId },
    });
    if (!schedule) {
      throw new NotFoundException(`Schedule ${scheduleId} not found`);
    }

    const workbook = await this.db.client.workbook.findFirst({
      where: { id: workbookId },
    });
    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }

    return new ScheduleEntity(schedule);
  }

  async update(workbookId: WorkbookId, scheduleId: string, dto: ValidatedUpdateScheduleDto): Promise<ScheduleEntity> {
    const existing = await this.findOne(workbookId, scheduleId);

    if (dto.cronExpression) {
      this.validateCronExpression(dto.cronExpression);
    }

    const nextRunAt =
      dto.cronExpression && dto.cronExpression !== existing.cronExpression
        ? this.computeNextRunAt(dto.cronExpression)
        : undefined;

    // If re-enabling a disabled schedule, also recompute nextRunAt
    const reEnabling = dto.enabled === true && !existing.enabled;
    const recomputedNextRunAt = reEnabling
      ? this.computeNextRunAt(dto.cronExpression ?? existing.cronExpression)
      : undefined;

    const schedule = await this.db.client.schedule.update({
      where: { id: scheduleId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.cronExpression !== undefined && { cronExpression: dto.cronExpression }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(nextRunAt && { nextRunAt }),
        ...(recomputedNextRunAt && { nextRunAt: recomputedNextRunAt }),
      },
    });
    return new ScheduleEntity(schedule);
  }

  async delete(workbookId: WorkbookId, scheduleId: string): Promise<void> {
    await this.findOne(workbookId, scheduleId);
    await this.db.client.schedule.delete({ where: { id: scheduleId } });
  }

  /** Validates a cron expression is syntactically valid and meets the minimum interval requirement. */
  private validateCronExpression(cronExpression: string): void {
    let parsed;
    try {
      parsed = CronExpressionParser.parse(cronExpression);
    } catch {
      throw new BadRequestException(`Invalid cron expression: ${cronExpression}`);
    }

    // Check minimum interval: get two consecutive ticks and compare
    const first = parsed.next().toDate();
    const second = parsed.next().toDate();
    const intervalMinutes = (second.getTime() - first.getTime()) / 60_000;

    if (intervalMinutes < SCHEDULE_MIN_INTERVAL_MINUTES) {
      throw new BadRequestException(
        `Schedule interval must be at least ${SCHEDULE_MIN_INTERVAL_MINUTES} minutes. Got ~${Math.round(intervalMinutes)} minutes.`,
      );
    }
  }

  /** Checks whether the entity referenced by a schedule still exists. */
  async entityExists(workbookId: string, action: string, entityId: string): Promise<boolean> {
    if (isPullAction(action) || action === 'PUBLISH') {
      const folder = await this.db.client.dataFolder.findFirst({
        where: { id: entityId, workbookId },
        select: { id: true },
      });
      return folder !== null;
    } else if (isConnectionPullAction(action)) {
      const connectorAccount = await this.db.client.connectorAccount.findFirst({
        where: { id: entityId, workbookId },
        select: { id: true },
      });
      return connectorAccount !== null;
    } else if (action === 'SYNC') {
      // eslint-disable-next-line no-restricted-syntax -- TODO(DEV-10008): existence check via id-only select; no mappings read.
      const sync = await this.db.client.sync.findFirst({
        where: { id: entityId, syncTablePairs: { some: { sourceDataFolder: { workbookId } } } },
        select: { id: true },
      });
      return sync !== null;
    }
    return false;
  }

  /** Disables a schedule (used when the referenced entity no longer exists). */
  async disableSchedule(scheduleId: string): Promise<void> {
    await this.db.client.schedule.update({
      where: { id: scheduleId },
      data: { enabled: false },
    });
  }

  /**
   * DEV-9698 (T4) — quiesce step: disable every schedule that targets a
   * connection so none fires (a scheduled pull / publish / sync racing the
   * folder move would write to old paths). Stamps `disabledForMigrationAt` so the
   * restore step re-enables exactly the schedules THIS migration disabled.
   *
   * Only schedules that are **currently enabled and not already
   * migration-disabled** are touched, so it (a) never clobbers a schedule the
   * user disabled themselves — those keep `disabledForMigrationAt = null` and are
   * never re-enabled by restore — and (b) is idempotent across re-runs: an
   * already-migration-disabled schedule keeps its marker untouched. Covers all
   * three schedule kinds: connection-wide pulls (entityId = ConnectorAccountId),
   * per-table pull/publish (entityId = DataFolderId), and syncs touching the
   * connection (entityId = SyncId).
   */
  async disableSchedulesForConnectionMigration(workbookId: WorkbookId, connectorAccountId: string): Promise<void> {
    const scheduleIds = await this.findScheduleIdsForConnection(workbookId, connectorAccountId);
    if (scheduleIds.length === 0) return;

    await this.db.client.schedule.updateMany({
      where: { id: { in: scheduleIds }, enabled: true, disabledForMigrationAt: null },
      data: { enabled: false, disabledForMigrationAt: new Date() },
    });
  }

  /**
   * DEV-9698 (T4) — release step: re-enable the schedules this migration
   * disabled, recomputing each `nextRunAt` from its cron so it fires on its next
   * natural tick rather than immediately.
   *
   * Driven entirely off the `disabledForMigrationAt` marker (not an in-memory
   * snapshot), so it is crash-safe: if a run disabled schedules then died before
   * restoring, a later re-run's restore re-enables exactly the marked schedules.
   * User-disabled schedules (marker null) are never re-enabled.
   */
  async restoreSchedulesForConnectionMigration(workbookId: WorkbookId, connectorAccountId: string): Promise<void> {
    const scheduleIds = await this.findScheduleIdsForConnection(workbookId, connectorAccountId);
    if (scheduleIds.length === 0) return;

    const toRestore = await this.db.client.schedule.findMany({
      where: { id: { in: scheduleIds }, disabledForMigrationAt: { not: null } },
    });
    for (const schedule of toRestore) {
      await this.db.client.schedule.update({
        where: { id: schedule.id },
        data: {
          enabled: true,
          disabledForMigrationAt: null,
          nextRunAt: this.computeNextRunAt(schedule.cronExpression),
        },
      });
    }
  }

  /**
   * Resolve the ids of every schedule that targets a connection, across the three
   * polymorphic `entityId` kinds: the ConnectorAccount itself (connection-wide
   * pulls), each of its linked DataFolders (per-table pull/publish), and each Sync
   * whose source or destination table belongs to the connection.
   */
  private async findScheduleIdsForConnection(workbookId: WorkbookId, connectorAccountId: string): Promise<string[]> {
    const folders = await this.db.client.dataFolder.findMany({
      where: { workbookId, connectorAccountId },
      select: { id: true },
    });
    const folderIds = folders.map((folder) => folder.id);

    const syncTablePairs = await this.db.client.syncTablePair.findMany({
      where: {
        OR: [{ sourceDataFolder: { connectorAccountId } }, { destinationDataFolder: { connectorAccountId } }],
      },
      select: { syncId: true },
    });
    const syncIds = [...new Set(syncTablePairs.map((pair) => pair.syncId))];

    const schedules = await this.db.client.schedule.findMany({
      where: {
        workbookId,
        OR: [
          {
            action: {
              in: [PrismaScheduleAction.CONNECTION_FULL_PULL, PrismaScheduleAction.CONNECTION_INCREMENTAL_PULL],
            },
            entityId: connectorAccountId,
          },
          ...(folderIds.length > 0
            ? [
                {
                  action: {
                    in: [
                      PrismaScheduleAction.PULL,
                      PrismaScheduleAction.FULL_PULL,
                      PrismaScheduleAction.INCREMENTAL_PULL,
                      PrismaScheduleAction.PUBLISH,
                    ],
                  },
                  entityId: { in: folderIds },
                },
              ]
            : []),
          ...(syncIds.length > 0 ? [{ action: PrismaScheduleAction.SYNC, entityId: { in: syncIds } }] : []),
        ],
      },
      select: { id: true },
    });
    return schedules.map((schedule) => schedule.id);
  }

  /** Validates that the entityId refers to a valid entity for the given action within the workbook. */
  private async validateEntityId(workbookId: string, action: string, entityId: string): Promise<void> {
    if (isPullAction(action) || action === 'PUBLISH') {
      const folder = await this.db.client.dataFolder.findFirst({
        where: { id: entityId, workbookId },
        select: { id: true, connectorAccountId: true },
      });
      if (!folder) {
        throw new BadRequestException(`DataFolder ${entityId} not found in workbook ${workbookId}`);
      }
      if (isPullAction(action) && !folder.connectorAccountId) {
        throw new BadRequestException(`DataFolder ${entityId} is not a linked folder (no connector account)`);
      }
    } else if (isConnectionPullAction(action)) {
      const connectorAccount = await this.db.client.connectorAccount.findFirst({
        where: { id: entityId, workbookId },
        select: { id: true },
      });
      if (!connectorAccount) {
        throw new BadRequestException(`ConnectorAccount ${entityId} not found in workbook ${workbookId}`);
      }
    } else if (action === 'SYNC') {
      // eslint-disable-next-line no-restricted-syntax -- TODO(DEV-10008): existence check via id-only select; no mappings read.
      const sync = await this.db.client.sync.findFirst({
        where: {
          id: entityId,
          syncTablePairs: { some: { sourceDataFolder: { workbookId } } },
        },
        select: { id: true },
      });
      if (!sync) {
        throw new BadRequestException(`Sync ${entityId} not found in workbook ${workbookId}`);
      }
    }
  }

  /** Computes the next run time from a cron expression. */
  computeNextRunAt(cronExpression: string): Date {
    const parsed = CronExpressionParser.parse(cronExpression);
    return parsed.next().toDate();
  }

  /** Finds all enabled schedules that are due to run. Used by the evaluator. */
  async findDueSchedules(): Promise<Schedule[]> {
    return this.db.client.schedule.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: new Date() },
      },
      // Avoid starvation by ensuring we roundrobin when there's too many jobs.
      orderBy: { nextRunAt: 'asc' },
    });
  }

  /**
   * Atomically claims a schedule for execution. Returns the updated schedule if claimed,
   * or null if another instance already claimed it (0 rows updated).
   */
  async atomicClaim(scheduleId: string, nextRunAt: Date): Promise<Schedule | null> {
    // Use raw query for atomic claim with WHERE nextRunAt <= NOW()
    const results = await this.db.client.$queryRawUnsafe<Schedule[]>(
      `UPDATE "Schedule"
       SET "lastTriggeredAt" = NOW(),
           "nextRunAt" = $1,
           "updatedAt" = NOW()
       WHERE "id" = $2
         AND "nextRunAt" <= NOW()
       RETURNING *`,
      nextRunAt,
      scheduleId,
    );

    if (!results || results.length === 0) {
      WSLogger.debug({
        source: 'ScheduleService.atomicClaim',
        message: `Schedule ${scheduleId} already claimed by another instance`,
      });
      return null;
    }

    return results[0];
  }
}
