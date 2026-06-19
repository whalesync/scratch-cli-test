/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Schedule as PrismaSchedule } from '@prisma/client';
import { ScheduleAction, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { Actor } from 'src/users/types';
import { ScheduleService } from '../schedule.service';

const WORKBOOK_ID = 'wkb_test1234' as WorkbookId;
const ACTOR: Actor = { userId: 'usr_test1234', organizationId: 'org_test1234' };

function buildScheduleRow(overrides: Partial<PrismaSchedule> = {}): PrismaSchedule {
  return {
    id: 'sch_routine01',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    workbookId: WORKBOOK_ID,
    organizationId: 'org_test1234',
    userId: 'usr_test1234',
    name: 'Daily',
    action: 'ROUTINE',
    entityId: 'routines/daily.yaml',
    cronExpression: '0 9 * * *',
    enabled: true,
    disabledForMigrationAt: null,
    lastTriggeredAt: null,
    nextRunAt: new Date('2026-01-02T09:00:00Z'),
    ...overrides,
  } as PrismaSchedule;
}

describe('ScheduleService — routine schedules', () => {
  let scheduleCreate: jest.Mock;
  let scheduleDeleteMany: jest.Mock;
  let scheduleFindMany: jest.Mock;
  let workbookFindFirst: jest.Mock;
  let service: ScheduleService;

  beforeEach(() => {
    scheduleCreate = jest.fn().mockResolvedValue(buildScheduleRow());
    scheduleDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    scheduleFindMany = jest.fn().mockResolvedValue([]);
    workbookFindFirst = jest.fn().mockResolvedValue({ id: WORKBOOK_ID, organizationId: 'org_test1234' });

    const db = {
      client: {
        schedule: { create: scheduleCreate, deleteMany: scheduleDeleteMany, findMany: scheduleFindMany },
        workbook: { findFirst: workbookFindFirst },
      },
    } as unknown as DbService;
    service = new ScheduleService(db);
  });

  // Routine schedules are now created/edited through the public schedule CRUD (DEV-10478) — the cron
  // lives only in the DB, never in the routine YAML. These cover the ROUTINE-specific guards on create.
  describe('create (ROUTINE)', () => {
    const ROUTINE_DTO = {
      name: 'Daily',
      action: ScheduleAction.ROUTINE,
      entityId: 'routines/daily.yaml',
      cronExpression: '0 9 * * *',
    };

    it('creates a ROUTINE schedule keyed by the routine file path', async () => {
      const created = await service.create(WORKBOOK_ID, ROUTINE_DTO, ACTOR);

      expect(scheduleCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workbookId: WORKBOOK_ID,
            organizationId: 'org_test1234',
            action: 'ROUTINE',
            entityId: 'routines/daily.yaml',
            name: 'Daily',
            cronExpression: '0 9 * * *',
            nextRunAt: expect.any(Date),
          }),
        }),
      );
      expect(created.action).toBe('ROUTINE');
    });

    it('throws if the workbook does not exist', async () => {
      workbookFindFirst.mockResolvedValue(null);
      await expect(service.create(WORKBOOK_ID, ROUTINE_DTO, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      expect(scheduleCreate).not.toHaveBeenCalled();
    });

    it('rejects an entityId that is not a valid routines/ file path', async () => {
      await expect(
        service.create(WORKBOOK_ID, { ...ROUTINE_DTO, entityId: 'syncs/evil.yaml' }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(scheduleCreate).not.toHaveBeenCalled();
    });

    it('enforces the stricter 5-minute minimum interval for ROUTINE schedules', async () => {
      // Every-minute is allowed for a generic schedule (1-min floor) but not for a routine.
      await expect(
        service.create(WORKBOOK_ID, { ...ROUTINE_DTO, cronExpression: '*/1 * * * *' }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(scheduleCreate).not.toHaveBeenCalled();
    });

    it('rejects an invalid cron expression', async () => {
      await expect(
        service.create(WORKBOOK_ID, { ...ROUTINE_DTO, cronExpression: 'not-a-cron' }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(scheduleCreate).not.toHaveBeenCalled();
    });
  });

  describe('deleteRoutineScheduleByFilePath', () => {
    it('deletes the ROUTINE schedule for the given file path', async () => {
      await service.deleteRoutineScheduleByFilePath(WORKBOOK_ID, 'routines/daily.yaml');
      expect(scheduleDeleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, action: 'ROUTINE', entityId: 'routines/daily.yaml' },
      });
    });
  });

  describe('deleteOrphanedRoutineSchedules', () => {
    it('deletes ROUTINE schedules whose file is not in the valid set', async () => {
      await service.deleteOrphanedRoutineSchedules(WORKBOOK_ID, ['routines/a.yaml', 'routines/b.yaml']);
      expect(scheduleDeleteMany).toHaveBeenCalledWith({
        where: {
          workbookId: WORKBOOK_ID,
          action: 'ROUTINE',
          entityId: { notIn: ['routines/a.yaml', 'routines/b.yaml'] },
        },
      });
    });

    it('with an empty valid set, removes all ROUTINE schedules for the workbook', async () => {
      await service.deleteOrphanedRoutineSchedules(WORKBOOK_ID, []);
      expect(scheduleDeleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, action: 'ROUTINE', entityId: { notIn: [] } },
      });
    });
  });

  describe('findRoutineSchedules', () => {
    it('returns the workbook’s ROUTINE schedules as entities', async () => {
      scheduleFindMany.mockResolvedValue([buildScheduleRow({ entityId: 'routines/daily.yaml', id: 'sch_routine01' })]);
      const result = await service.findRoutineSchedules(WORKBOOK_ID);
      expect(scheduleFindMany).toHaveBeenCalledWith({ where: { workbookId: WORKBOOK_ID, action: 'ROUTINE' } });
      expect(result).toHaveLength(1);
      expect(result[0].entityId).toBe('routines/daily.yaml');
      expect(result[0].id).toBe('sch_routine01');
    });
  });
});
