/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { WorkbookId } from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { ScheduleService } from '../schedule.service';

/**
 * DEV-9698 (T4) — the schedule quiesce/restore pair used by a connection
 * migration. Covers the marker-driven, crash-safe restore (finding #11): only
 * schedules THIS migration disabled (those carrying `disabledForMigrationAt`) are
 * re-enabled, so a schedule the user disabled is never silently turned back on.
 */
describe('ScheduleService — connection migration quiesce/restore', () => {
  const WORKBOOK_ID = 'wb_1' as WorkbookId;
  const CONNECTOR_ACCOUNT_ID = 'ca_1';

  let dataFolder: { findMany: jest.Mock };
  let syncTablePair: { findMany: jest.Mock };
  let schedule: { findMany: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
  let service: ScheduleService;

  beforeEach(() => {
    dataFolder = { findMany: jest.fn().mockResolvedValue([{ id: 'df_1' }, { id: 'df_2' }]) };
    syncTablePair = { findMany: jest.fn().mockResolvedValue([{ syncId: 'syn_1' }]) };
    schedule = {
      findMany: jest.fn().mockResolvedValue([{ id: 'sch_conn' }, { id: 'sch_pull' }, { id: 'sch_sync' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const db = { client: { dataFolder, syncTablePair, schedule } } as unknown as DbService;
    const configService = { isProductionEnvironment: () => true } as unknown as ScratchConfigService;
    service = new ScheduleService(db, configService);
  });

  describe('disableSchedulesForConnectionMigration', () => {
    it('finds schedules across all three entity kinds (connection, folders, syncs)', async () => {
      await service.disableSchedulesForConnectionMigration(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID);
      const where = schedule.findMany.mock.calls[0][0].where;
      // Connection-wide pull schedules keyed by the account id.
      expect(where.OR).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: CONNECTOR_ACCOUNT_ID })]));
      // Per-table + sync schedules keyed by the resolved folder/sync ids.
      expect(where.OR).toEqual(
        expect.arrayContaining([expect.objectContaining({ entityId: { in: ['df_1', 'df_2'] } })]),
      );
      expect(where.OR).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: { in: ['syn_1'] } })]));
    });

    it('only disables schedules currently enabled and not already migration-disabled', async () => {
      await service.disableSchedulesForConnectionMigration(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID);
      expect(schedule.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['sch_conn', 'sch_pull', 'sch_sync'] }, enabled: true, disabledForMigrationAt: null },
        data: { enabled: false, disabledForMigrationAt: expect.any(Date) },
      });
    });

    it('is a no-op when the connection has no schedules', async () => {
      schedule.findMany.mockResolvedValue([]);
      await service.disableSchedulesForConnectionMigration(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID);
      expect(schedule.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('restoreSchedulesForConnectionMigration (crash-safe, marker-driven)', () => {
    it('re-enables only schedules carrying the migration marker, recomputing nextRunAt', async () => {
      // First findMany resolves the connection's schedule ids; second resolves the
      // marked subset to restore (a user-disabled schedule with marker null is absent).
      schedule.findMany
        .mockResolvedValueOnce([{ id: 'sch_pull' }, { id: 'sch_user_disabled' }])
        .mockResolvedValueOnce([{ id: 'sch_pull', cronExpression: '0 * * * *', disabledForMigrationAt: new Date() }]);

      await service.restoreSchedulesForConnectionMigration(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID);

      // The "to restore" query filters on the marker being set.
      const restoreQuery = schedule.findMany.mock.calls[1][0];
      expect(restoreQuery.where.disabledForMigrationAt).toEqual({ not: null });

      // Only the marked schedule is re-enabled, marker cleared, nextRunAt recomputed.
      expect(schedule.update).toHaveBeenCalledTimes(1);
      expect(schedule.update).toHaveBeenCalledWith({
        where: { id: 'sch_pull' },
        data: { enabled: true, disabledForMigrationAt: null, nextRunAt: expect.any(Date) },
      });
    });

    it('is a no-op when no schedule carries the marker', async () => {
      schedule.findMany.mockResolvedValueOnce([{ id: 'sch_pull' }]).mockResolvedValueOnce([]);
      await service.restoreSchedulesForConnectionMigration(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID);
      expect(schedule.update).not.toHaveBeenCalled();
    });
  });
});
