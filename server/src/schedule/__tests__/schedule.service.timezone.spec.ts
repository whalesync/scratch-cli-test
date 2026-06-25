/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Schedule as PrismaSchedule } from '@prisma/client';
import { ScheduleAction, WorkbookId } from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { Actor } from 'src/users/types';
import { ScheduleService } from '../schedule.service';

const WORKBOOK_ID = 'wkb_tz_test' as WorkbookId;
const ACTOR: Actor = { userId: 'usr_tz_test', organizationId: 'org_tz_test' };

function hourInTimezone(date: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(date);
  // hour12:false can render midnight as "24" in some runtimes — normalize to 0.
  return Number(formatted) % 24;
}

function buildScheduleRow(overrides: Partial<PrismaSchedule> = {}): PrismaSchedule {
  return {
    id: 'sch_tz01',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    workbookId: WORKBOOK_ID,
    organizationId: 'org_tz_test',
    userId: 'usr_tz_test',
    name: 'Daily',
    action: 'ROUTINE',
    entityId: 'routines/daily.yaml',
    cronExpression: '0 8 * * *',
    timezone: 'America/Chicago',
    enabled: true,
    disabledForMigrationAt: null,
    lastTriggeredAt: null,
    nextRunAt: new Date('2026-01-02T14:00:00Z'),
    ...overrides,
  } as PrismaSchedule;
}

describe('ScheduleService — timezone handling', () => {
  let scheduleCreate: jest.Mock;
  let scheduleUpdate: jest.Mock;
  let scheduleFindFirst: jest.Mock;
  let workbookFindFirst: jest.Mock;
  let service: ScheduleService;

  beforeEach(() => {
    scheduleCreate = jest.fn().mockResolvedValue(buildScheduleRow());
    scheduleUpdate = jest.fn().mockResolvedValue(buildScheduleRow());
    scheduleFindFirst = jest.fn().mockResolvedValue(buildScheduleRow());
    workbookFindFirst = jest.fn().mockResolvedValue({ id: WORKBOOK_ID, organizationId: 'org_tz_test' });

    const db = {
      client: {
        schedule: { create: scheduleCreate, update: scheduleUpdate, findFirst: scheduleFindFirst },
        workbook: { findFirst: workbookFindFirst },
      },
    } as unknown as DbService;
    const configService = { isProductionEnvironment: () => false } as unknown as ScratchConfigService;
    service = new ScheduleService(db, configService);
  });

  describe('computeNextRunAt', () => {
    it('interprets the cron wall-clock time in the given timezone (DST-correct year-round)', () => {
      // A "daily 08:00" schedule must fire at 08:00 local in every season, even though the UTC
      // offset shifts across DST — this is the property a fixed UTC cron could not provide.
      const next = service.computeNextRunAt('0 8 * * *', 'America/New_York');
      expect(hourInTimezone(next, 'America/New_York')).toBe(8);
      // 08:00 New York is never 08:00 UTC (offset is -4 or -5), so the absolute instant differs.
      expect(next.getUTCHours()).not.toBe(8);
    });

    it('uses the server local time when no timezone is given (UTC in production)', () => {
      // With no `tz`, cron-parser interprets the cron in the process's local timezone — which is
      // UTC in production (the server runs with TZ=UTC). `getHours()` is local, so it reads 8 here.
      const next = service.computeNextRunAt('0 8 * * *', null);
      expect(next.getHours()).toBe(8);
    });

    it('handles a spring-forward gap time without throwing and yields a valid future instant', () => {
      // 02:30 does not exist on the US spring-forward day; cron-parser must still resolve a real instant.
      const next = service.computeNextRunAt('30 2 * * *', 'America/New_York');
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(Number.isNaN(next.getTime())).toBe(false);
    });
  });

  describe('create', () => {
    const dto = {
      name: 'Daily',
      action: ScheduleAction.ROUTINE,
      entityId: 'routines/daily.yaml',
      cronExpression: '0 8 * * *',
    };

    it('persists the timezone provided on the dto', async () => {
      await service.create(WORKBOOK_ID, { ...dto, timezone: 'America/New_York' }, ACTOR);
      expect(scheduleCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ timezone: 'America/New_York', nextRunAt: expect.any(Date) }),
        }),
      );
    });

    it('stores null when no timezone is provided', async () => {
      await service.create(WORKBOOK_ID, { ...dto, cronExpression: '0 * * * *' }, ACTOR);
      expect(scheduleCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ timezone: null }) }),
      );
    });
  });

  describe('update', () => {
    it('recomputes nextRunAt and persists the timezone on a timezone-only change', async () => {
      scheduleFindFirst.mockResolvedValue(
        buildScheduleRow({ cronExpression: '0 8 * * *', timezone: 'America/Chicago' }),
      );

      await service.update(WORKBOOK_ID, 'sch_tz01', { timezone: 'America/New_York' });

      expect(scheduleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sch_tz01' },
          data: expect.objectContaining({ timezone: 'America/New_York', nextRunAt: expect.any(Date) }),
        }),
      );
    });

    it('does not recompute nextRunAt when only the name changes', async () => {
      scheduleFindFirst.mockResolvedValue(
        buildScheduleRow({ cronExpression: '0 8 * * *', timezone: 'America/Chicago' }),
      );

      await service.update(WORKBOOK_ID, 'sch_tz01', { name: 'Renamed' });

      // No cron/timezone/enabled change → the update carries only the name, no recomputed nextRunAt.
      expect(scheduleUpdate).toHaveBeenCalledWith({ where: { id: 'sch_tz01' }, data: { name: 'Renamed' } });
    });
  });
});
