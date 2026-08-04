import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { RequestWithUser } from 'src/auth/types';
import { CronController } from '../cron.controller';
import { ExpiredApiTokenCleanupService } from '../expired-api-token-cleanup.service';
import { OldJobCleanupService } from '../old-job-cleanup.service';
import { RecordCountRefreshService } from '../record-count-refresh.service';
import { RoutineRunReaperService } from '../routine-run-reaper.service';
import { StaleJobReaperService } from '../stale-job-reaper.service';

const ADMIN_REQ = { user: { id: 'usr_admin', role: UserRole.ADMIN, authType: 'jwt' } } as unknown as RequestWithUser;
const NON_ADMIN_REQ = { user: { id: 'usr_user', role: UserRole.USER, authType: 'jwt' } } as unknown as RequestWithUser;

describe('CronController', () => {
  let recordCountRefresh: { refreshRecordCounts: jest.Mock };
  let oldJobCleanup: { cleanupOldJobs: jest.Mock };
  let staleJobReaper: { reapStaleCreatedJobs: jest.Mock; reapStaleActiveJobs: jest.Mock };
  let routineRunReaper: { reapStuckRoutineRuns: jest.Mock };
  let expiredApiTokenCleanup: { cleanupExpiredWhalesyncSessionTokens: jest.Mock };
  let controller: CronController;

  beforeEach(() => {
    recordCountRefresh = { refreshRecordCounts: jest.fn().mockResolvedValue(undefined) };
    oldJobCleanup = { cleanupOldJobs: jest.fn().mockResolvedValue(undefined) };
    staleJobReaper = {
      reapStaleCreatedJobs: jest.fn().mockResolvedValue(undefined),
      reapStaleActiveJobs: jest.fn().mockResolvedValue(undefined),
    };
    routineRunReaper = { reapStuckRoutineRuns: jest.fn().mockResolvedValue(undefined) };
    expiredApiTokenCleanup = { cleanupExpiredWhalesyncSessionTokens: jest.fn().mockResolvedValue(undefined) };
    controller = new CronController(
      recordCountRefresh as unknown as RecordCountRefreshService,
      oldJobCleanup as unknown as OldJobCleanupService,
      staleJobReaper as unknown as StaleJobReaperService,
      routineRunReaper as unknown as RoutineRunReaperService,
      expiredApiTokenCleanup as unknown as ExpiredApiTokenCleanupService,
    );
  });

  describe('admin gate', () => {
    it('rejects non-admins from listing jobs', () => {
      expect(() => controller.listCronJobs(NON_ADMIN_REQ)).toThrow(UnauthorizedException);
    });

    it('rejects non-admins from triggering a job, without running it', async () => {
      await expect(controller.triggerCronJob('record-count-refresh', NON_ADMIN_REQ)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(recordCountRefresh.refreshRecordCounts).not.toHaveBeenCalled();
    });
  });

  it('lists every triggerable cron job with a slug, description, and schedule', () => {
    const { jobs } = controller.listCronJobs(ADMIN_REQ);
    expect(jobs.map((job) => job.slug).sort()).toEqual([
      'expired-api-token-cleanup',
      'old-job-cleanup',
      'record-count-refresh',
      'routine-run-reaper',
      'stale-active-job-reaper',
      'stale-job-reaper',
    ]);
    for (const job of jobs) {
      expect(job.description.length).toBeGreaterThan(0);
      expect(job.schedule.length).toBeGreaterThan(0);
    }
  });

  it('triggers a job by slug and reports success', async () => {
    const result = await controller.triggerCronJob('record-count-refresh', ADMIN_REQ);
    expect(recordCountRefresh.refreshRecordCounts).toHaveBeenCalledTimes(1);
    expect(result.slug).toBe('record-count-refresh');
    expect(result.ran).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(result.error).toBeUndefined();
  });

  it('throws NotFound for an unknown slug', async () => {
    await expect(controller.triggerCronJob('does-not-exist', ADMIN_REQ)).rejects.toThrow(NotFoundException);
  });

  it('reports ran:false with the error message when the job throws', async () => {
    oldJobCleanup.cleanupOldJobs.mockRejectedValue(new Error('boom'));
    const result = await controller.triggerCronJob('old-job-cleanup', ADMIN_REQ);
    expect(result.ran).toBe(false);
    expect(result.error).toBe('boom');
  });
});
