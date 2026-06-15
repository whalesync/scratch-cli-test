/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ConflictException } from '@nestjs/common';
import { JobType } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import type { JobData } from 'src/worker/jobs/union-types';
import { MigrationLockService } from '../migration-lock.service';

/**
 * DEV-9698 (T4) — the per-connection migration lock gate. Verifies the edit gate
 * ({@link MigrationLockService.assertConnectionNotMigrating}) and the enqueue gate
 * ({@link MigrationLockService.assertEnqueueAllowedForJob}), including the
 * fast-path no-op when nothing is locked and the job→connection resolution.
 */
describe('MigrationLockService', () => {
  let service: MigrationLockService;
  let connectorAccount: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  let dataFolder: { findMany: jest.Mock };
  let syncTablePair: { findMany: jest.Mock };

  beforeEach(() => {
    connectorAccount = {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
    };
    dataFolder = { findMany: jest.fn().mockResolvedValue([]) };
    syncTablePair = { findMany: jest.fn().mockResolvedValue([]) };

    const db = { client: { connectorAccount, dataFolder, syncTablePair } } as unknown as DbService;
    service = new MigrationLockService(db);
  });

  describe('assertConnectionNotMigrating (edit gate)', () => {
    it('is a no-op when the connection is not locked', async () => {
      connectorAccount.findUnique.mockResolvedValue({ migrationLockedAt: null });
      await expect(service.assertConnectionNotMigrating('ca_1')).resolves.toBeUndefined();
    });

    it('throws a 409 with the blocked_migrating body when the connection is locked', async () => {
      connectorAccount.findUnique.mockResolvedValue({ migrationLockedAt: new Date() });
      await expect(service.assertConnectionNotMigrating('ca_1')).rejects.toBeInstanceOf(ConflictException);
      try {
        await service.assertConnectionNotMigrating('ca_1');
      } catch (error) {
        const body = (error as ConflictException).getResponse() as { status: string; connectorAccountId: string };
        expect(body.status).toBe('blocked_migrating');
        expect(body.connectorAccountId).toBe('ca_1');
      }
    });

    it('does not query when the id is null/undefined (a record with no connection)', async () => {
      await expect(service.assertConnectionNotMigrating(null)).resolves.toBeUndefined();
      await expect(service.assertConnectionNotMigrating(undefined)).resolves.toBeUndefined();
      expect(connectorAccount.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('lock / unlock', () => {
    it('sets migrationLockedAt on lock and clears it on unlock', async () => {
      await service.lockConnection('ca_1');
      expect(connectorAccount.update).toHaveBeenCalledWith({
        where: { id: 'ca_1' },
        data: { migrationLockedAt: expect.any(Date) },
      });

      await service.unlockConnection('ca_1');
      expect(connectorAccount.update).toHaveBeenLastCalledWith({
        where: { id: 'ca_1' },
        data: { migrationLockedAt: null },
      });
    });
  });

  describe('assertEnqueueAllowedForJob (enqueue gate)', () => {
    const publishJob = { type: JobType.Publish, connectorAccountId: 'ca_1' } as unknown as JobData;

    it('fast-path: returns without resolving the job when nothing is locked', async () => {
      connectorAccount.findFirst.mockResolvedValue(null); // no locked connection anywhere
      await expect(service.assertEnqueueAllowedForJob(publishJob)).resolves.toBeUndefined();
      // It must NOT have done the (more expensive) per-job resolution.
      expect(dataFolder.findMany).not.toHaveBeenCalled();
    });

    it('throws when the job targets a locked connection (Publish — direct id)', async () => {
      // 1st findFirst: "any locked?" → yes. 2nd findFirst: "is THIS account locked?" → yes.
      connectorAccount.findFirst.mockResolvedValueOnce({ id: 'ca_locked' }).mockResolvedValueOnce({ id: 'ca_1' });
      await expect(service.assertEnqueueAllowedForJob(publishJob)).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows when the job targets a different (unlocked) connection', async () => {
      connectorAccount.findFirst
        .mockResolvedValueOnce({ id: 'ca_locked' }) // some other connection is locked
        .mockResolvedValueOnce(null); // but not ca_1
      await expect(service.assertEnqueueAllowedForJob(publishJob)).resolves.toBeUndefined();
    });

    it('resolves a pull job via its dataFolderIds', async () => {
      connectorAccount.findFirst.mockResolvedValueOnce({ id: 'ca_locked' }).mockResolvedValueOnce({ id: 'ca_1' });
      dataFolder.findMany.mockResolvedValue([{ connectorAccountId: 'ca_1' }]);
      const pullJob = { type: JobType.PullLinkedFolderFiles, dataFolderIds: ['df_1', 'df_2'] } as unknown as JobData;

      await expect(service.assertEnqueueAllowedForJob(pullJob)).rejects.toBeInstanceOf(ConflictException);
      expect(dataFolder.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['df_1', 'df_2'] } },
        select: { connectorAccountId: true },
      });
    });

    it('resolves a sync job via its table pairs (source + destination)', async () => {
      connectorAccount.findFirst.mockResolvedValueOnce({ id: 'ca_locked' }).mockResolvedValueOnce({ id: 'ca_dest' });
      syncTablePair.findMany.mockResolvedValue([
        {
          sourceDataFolder: { connectorAccountId: 'ca_src' },
          destinationDataFolder: { connectorAccountId: 'ca_dest' },
        },
      ]);
      const syncJob = { type: JobType.SyncDataFolders, syncId: 'syn_1' } as unknown as JobData;

      await expect(service.assertEnqueueAllowedForJob(syncJob)).rejects.toBeInstanceOf(ConflictException);
    });

    it('never blocks a DeleteWorkbook job (workbook-level, no single connection)', async () => {
      connectorAccount.findFirst.mockResolvedValueOnce({ id: 'ca_locked' });
      const deleteJob = { type: JobType.DeleteWorkbook, workbookId: 'wb_1' } as unknown as JobData;
      await expect(service.assertEnqueueAllowedForJob(deleteJob)).resolves.toBeUndefined();
      // Resolves to no connection → the second "is it locked" query is skipped.
      expect(connectorAccount.findFirst).toHaveBeenCalledTimes(1);
    });
  });
});
