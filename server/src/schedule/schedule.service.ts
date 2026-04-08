import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Schedule } from '@prisma/client';
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
import { SCHEDULE_MIN_INTERVAL_MINUTES } from './schedule.types';

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
    if (action === 'PULL' || action === 'PUBLISH') {
      const folder = await this.db.client.dataFolder.findFirst({
        where: { id: entityId, workbookId },
        select: { id: true },
      });
      return folder !== null;
    } else if (action === 'SYNC') {
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

  /** Validates that the entityId refers to a valid entity for the given action within the workbook. */
  private async validateEntityId(workbookId: string, action: string, entityId: string): Promise<void> {
    if (action === 'PULL' || action === 'PUBLISH') {
      const folder = await this.db.client.dataFolder.findFirst({
        where: { id: entityId, workbookId },
        select: { id: true, connectorAccountId: true },
      });
      if (!folder) {
        throw new BadRequestException(`DataFolder ${entityId} not found in workbook ${workbookId}`);
      }
      if (action === 'PULL' && !folder.connectorAccountId) {
        throw new BadRequestException(`DataFolder ${entityId} is not a linked folder (no connector account)`);
      }
    } else if (action === 'SYNC') {
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
