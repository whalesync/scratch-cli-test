/**
 * DB-backed integration test for the DEV-9698 (T4) per-connection quiesce
 * primitives, run against real Postgres.
 *
 * The unit specs exercise the gate + schedule logic against mocked Prisma. This
 * spec validates the behavior the mocks can't: that the migration lock column
 * actually gates a live edit, and — most importantly — that the schedule
 * disable/restore is genuinely crash-safe and marker-driven (finding #11): only
 * schedules the migration disabled are re-enabled, and a schedule the user
 * disabled is never silently turned back on.
 */

import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  createConnectorAccountId,
  createOrganizationId,
  createScheduleId,
  createWorkbookId,
  ScheduleAction,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { MigrationLockService } from 'src/migration-lock/migration-lock.service';
import { ScheduleService } from 'src/schedule/schedule.service';

describe('connection quiesce (DB-backed)', () => {
  let prisma: PrismaClient;
  let migrationLock: MigrationLockService;
  let scheduleService: ScheduleService;

  const organizationId = createOrganizationId();
  const workbookId = createWorkbookId();
  const connectorAccountId = createConnectorAccountId();
  const enabledScheduleId = createScheduleId();
  const userDisabledScheduleId = createScheduleId();

  beforeAll(async () => {
    prisma = new PrismaClient();
    const db = { client: prisma } as unknown as DbService;
    migrationLock = new MigrationLockService(db);
    // This test never exercises interval validation, so the config service is unused at runtime.
    scheduleService = new ScheduleService(db, {
      isProductionEnvironment: () => true,
    } as unknown as ScratchConfigService);

    await prisma.organization.create({
      data: { id: organizationId, name: 'Quiesce Org', clerkId: `clerk_q_${organizationId}` },
    });
    await prisma.workbook.create({ data: { id: workbookId, name: 'Quiesce WB', organizationId } });
    await prisma.connectorAccount.create({
      data: { id: connectorAccountId, workbookId, service: 'webflow', displayName: 'WF' },
    });
  });

  afterAll(async () => {
    await prisma.schedule.deleteMany({ where: { workbookId } });
    await prisma.connectorAccount.deleteMany({ where: { id: connectorAccountId } });
    await prisma.workbook.deleteMany({ where: { id: workbookId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.connectorAccount.update({ where: { id: connectorAccountId }, data: { migrationLockedAt: null } });
  });

  describe('migration lock gate', () => {
    it('blocks a live edit while the connection is locked and allows it once released', async () => {
      await migrationLock.lockConnection(connectorAccountId);
      await expect(migrationLock.assertConnectionNotMigrating(connectorAccountId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await migrationLock.isConnectionMigrating(connectorAccountId)).toBe(true);

      await migrationLock.unlockConnection(connectorAccountId);
      await expect(migrationLock.assertConnectionNotMigrating(connectorAccountId)).resolves.toBeUndefined();
      expect(await migrationLock.isConnectionMigrating(connectorAccountId)).toBe(false);
    });
  });

  describe('schedule disable/restore (crash-safe, marker-driven)', () => {
    beforeEach(async () => {
      await prisma.schedule.deleteMany({ where: { workbookId } });
      // A migration should disable + later re-enable this one.
      await prisma.schedule.create({
        data: {
          id: enabledScheduleId,
          workbookId,
          organizationId,
          name: 'Connection full pull',
          action: ScheduleAction.CONNECTION_FULL_PULL,
          entityId: connectorAccountId,
          cronExpression: '0 * * * *',
          enabled: true,
        },
      });
      // The USER disabled this one; the migration must never re-enable it.
      await prisma.schedule.create({
        data: {
          id: userDisabledScheduleId,
          workbookId,
          organizationId,
          name: 'Connection incremental pull (user-disabled)',
          action: ScheduleAction.CONNECTION_INCREMENTAL_PULL,
          entityId: connectorAccountId,
          cronExpression: '0 * * * *',
          enabled: false,
        },
      });
    });

    it('disables only the enabled schedule (with a marker), leaving the user-disabled one untouched', async () => {
      await scheduleService.disableSchedulesForConnectionMigration(workbookId as WorkbookId, connectorAccountId);

      const enabled = await prisma.schedule.findUniqueOrThrow({ where: { id: enabledScheduleId } });
      const userDisabled = await prisma.schedule.findUniqueOrThrow({ where: { id: userDisabledScheduleId } });

      expect(enabled.enabled).toBe(false);
      expect(enabled.disabledForMigrationAt).not.toBeNull();
      // User-disabled stays disabled and never gets the marker.
      expect(userDisabled.enabled).toBe(false);
      expect(userDisabled.disabledForMigrationAt).toBeNull();
    });

    it('restore re-enables only the marked schedule; the user-disabled one stays disabled', async () => {
      await scheduleService.disableSchedulesForConnectionMigration(workbookId as WorkbookId, connectorAccountId);
      await scheduleService.restoreSchedulesForConnectionMigration(workbookId as WorkbookId, connectorAccountId);

      const enabled = await prisma.schedule.findUniqueOrThrow({ where: { id: enabledScheduleId } });
      const userDisabled = await prisma.schedule.findUniqueOrThrow({ where: { id: userDisabledScheduleId } });

      expect(enabled.enabled).toBe(true);
      expect(enabled.disabledForMigrationAt).toBeNull();
      expect(enabled.nextRunAt).not.toBeNull();
      // Never resurrected.
      expect(userDisabled.enabled).toBe(false);
      expect(userDisabled.disabledForMigrationAt).toBeNull();
    });

    it('repairs schedule state on a re-run: a second disable keeps the marker, and restore still re-enables', async () => {
      // First run disables + marks.
      await scheduleService.disableSchedulesForConnectionMigration(workbookId as WorkbookId, connectorAccountId);
      const afterFirstDisable = await prisma.schedule.findUniqueOrThrow({ where: { id: enabledScheduleId } });
      const markerAfterFirst = afterFirstDisable.disabledForMigrationAt;
      expect(markerAfterFirst).not.toBeNull();

      // Simulate a crash before restore, then a re-run's disable pass: it must NOT
      // clobber the existing marker (it only touches still-enabled, unmarked rows).
      await scheduleService.disableSchedulesForConnectionMigration(workbookId as WorkbookId, connectorAccountId);
      const afterSecondDisable = await prisma.schedule.findUniqueOrThrow({ where: { id: enabledScheduleId } });
      expect(afterSecondDisable.disabledForMigrationAt).toEqual(markerAfterFirst);

      // The re-run's restore still re-enables it from the marker alone.
      await scheduleService.restoreSchedulesForConnectionMigration(workbookId as WorkbookId, connectorAccountId);
      const afterRestore = await prisma.schedule.findUniqueOrThrow({ where: { id: enabledScheduleId } });
      expect(afterRestore.enabled).toBe(true);
      expect(afterRestore.disabledForMigrationAt).toBeNull();
    });
  });
});
