import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { RequestWithUser } from 'src/auth/types';
import { CronDebugController } from '../cron-debug.controller';
import { ExpiredApiTokenCleanupService } from '../expired-api-token-cleanup.service';
import { OldJobCleanupService } from '../old-job-cleanup.service';
import { RecordCountRefreshService } from '../record-count-refresh.service';
import { RehostedAssetReaperService } from '../rehosted-asset-reaper.service';
import { RoutineRunReaperService } from '../routine-run-reaper.service';
import { ScratchGitDiskObservabilityService } from '../scratch-git-disk-observability.service';
import { StagingDirReaperService } from '../staging-dir-reaper.service';
import { StaleJobReaperService } from '../stale-job-reaper.service';
import { SubscriptionEnforcementService } from '../subscription-enforcement.service';
import { WhalesyncRunNotificationSweeperService } from '../whalesync-run-notification-sweeper.service';

const ADMIN_REQ = { user: { id: 'usr_admin', role: UserRole.ADMIN, authType: 'jwt' } } as unknown as RequestWithUser;
const NON_ADMIN_REQ = { user: { id: 'usr_user', role: UserRole.USER, authType: 'jwt' } } as unknown as RequestWithUser;

describe('CronDebugController', () => {
  let recordCountRefresh: { refreshRecordCounts: jest.Mock };
  let oldJobCleanup: { cleanupOldJobs: jest.Mock };
  let staleJobReaper: { reapStaleCreatedJobs: jest.Mock; reapStaleActiveJobs: jest.Mock };
  let routineRunReaper: { reapStuckRoutineRuns: jest.Mock };
  let expiredApiTokenCleanup: { cleanupExpiredWhalesyncSessionTokens: jest.Mock };
  let scratchGitDiskObservability: { emitDiskObservabilityMetrics: jest.Mock };
  let stagingDirReaper: { reapStagingDirs: jest.Mock };
  let subscriptionEnforcement: { enforceLapsedSubscriptions: jest.Mock };
  let rehostedAssetReaper: { reapUnreferencedRehostedAssetObjects: jest.Mock };
  let whalesyncRunNotificationSweeper: { sweepWhalesyncRunNotifications: jest.Mock };
  let controller: CronDebugController;

  const originalRunningInCloud = process.env.RUNNING_IN_CLOUD;
  afterEach(() => {
    if (originalRunningInCloud === undefined) {
      delete process.env.RUNNING_IN_CLOUD;
    } else {
      process.env.RUNNING_IN_CLOUD = originalRunningInCloud;
    }
  });

  beforeEach(() => {
    // Default to local dev (triggering allowed) unless a test opts into a deployed environment.
    delete process.env.RUNNING_IN_CLOUD;
    recordCountRefresh = { refreshRecordCounts: jest.fn().mockResolvedValue(undefined) };
    oldJobCleanup = { cleanupOldJobs: jest.fn().mockResolvedValue(undefined) };
    staleJobReaper = {
      reapStaleCreatedJobs: jest.fn().mockResolvedValue(undefined),
      reapStaleActiveJobs: jest.fn().mockResolvedValue(undefined),
    };
    routineRunReaper = { reapStuckRoutineRuns: jest.fn().mockResolvedValue(undefined) };
    expiredApiTokenCleanup = { cleanupExpiredWhalesyncSessionTokens: jest.fn().mockResolvedValue(undefined) };
    scratchGitDiskObservability = { emitDiskObservabilityMetrics: jest.fn().mockResolvedValue(undefined) };
    stagingDirReaper = { reapStagingDirs: jest.fn().mockResolvedValue(undefined) };
    subscriptionEnforcement = { enforceLapsedSubscriptions: jest.fn().mockResolvedValue(undefined) };
    rehostedAssetReaper = { reapUnreferencedRehostedAssetObjects: jest.fn().mockResolvedValue(undefined) };
    whalesyncRunNotificationSweeper = { sweepWhalesyncRunNotifications: jest.fn().mockResolvedValue(undefined) };
    controller = new CronDebugController(
      recordCountRefresh as unknown as RecordCountRefreshService,
      oldJobCleanup as unknown as OldJobCleanupService,
      staleJobReaper as unknown as StaleJobReaperService,
      routineRunReaper as unknown as RoutineRunReaperService,
      expiredApiTokenCleanup as unknown as ExpiredApiTokenCleanupService,
      scratchGitDiskObservability as unknown as ScratchGitDiskObservabilityService,
      stagingDirReaper as unknown as StagingDirReaperService,
      subscriptionEnforcement as unknown as SubscriptionEnforcementService,
      rehostedAssetReaper as unknown as RehostedAssetReaperService,
      whalesyncRunNotificationSweeper as unknown as WhalesyncRunNotificationSweeperService,
    );
  });

  it('rejects non-admins from triggering a job, without running it', async () => {
    await expect(controller.triggerCronJob('record-count-refresh', NON_ADMIN_REQ)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(recordCountRefresh.refreshRecordCounts).not.toHaveBeenCalled();
  });

  it('triggers a job by slug and reports success', async () => {
    const result = await controller.triggerCronJob('record-count-refresh', ADMIN_REQ);
    expect(recordCountRefresh.refreshRecordCounts).toHaveBeenCalledTimes(1);
    expect(result.slug).toBe('record-count-refresh');
    expect(result.ran).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(result.error).toBeUndefined();
  });

  it('triggers the scratch-git disk observability sweep by slug', async () => {
    const result = await controller.triggerCronJob('scratch-git-disk-observability', ADMIN_REQ);
    expect(scratchGitDiskObservability.emitDiskObservabilityMetrics).toHaveBeenCalledTimes(1);
    expect(result.slug).toBe('scratch-git-disk-observability');
    expect(result.ran).toBe(true);
  });

  it('triggers the staging-dir reaper by slug', async () => {
    const result = await controller.triggerCronJob('staging-dir-reaper', ADMIN_REQ);
    expect(stagingDirReaper.reapStagingDirs).toHaveBeenCalledTimes(1);
    expect(result.slug).toBe('staging-dir-reaper');
    expect(result.ran).toBe(true);
  });

  it('triggers the rehosted-asset reaper by slug', async () => {
    const result = await controller.triggerCronJob('rehosted-asset-reaper', ADMIN_REQ);
    expect(rehostedAssetReaper.reapUnreferencedRehostedAssetObjects).toHaveBeenCalledTimes(1);
    expect(result.slug).toBe('rehosted-asset-reaper');
    expect(result.ran).toBe(true);
  });

  it('triggers the Whalesync run notification sweeper by slug', async () => {
    const result = await controller.triggerCronJob('whalesync-run-notification-sweeper', ADMIN_REQ);
    expect(whalesyncRunNotificationSweeper.sweepWhalesyncRunNotifications).toHaveBeenCalledTimes(1);
    expect(result.slug).toBe('whalesync-run-notification-sweeper');
    expect(result.ran).toBe(true);
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

  describe('deployed environment (RUNNING_IN_CLOUD=true)', () => {
    beforeEach(() => {
      process.env.RUNNING_IN_CLOUD = 'true';
    });

    it('refuses to trigger a job with Forbidden, without running it', async () => {
      await expect(controller.triggerCronJob('record-count-refresh', ADMIN_REQ)).rejects.toThrow(ForbiddenException);
      expect(recordCountRefresh.refreshRecordCounts).not.toHaveBeenCalled();
    });
  });
});
