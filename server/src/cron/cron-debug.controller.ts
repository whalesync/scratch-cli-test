import {
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { TriggerCronJobResponseDto } from '@spinner/shared-types';
import { hasAdminToolsPermission } from 'src/auth/permissions';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { WSLogger } from 'src/logger';
import { CRON_TRIGGERING_DISABLED_MESSAGE, isManualCronTriggeringAllowed } from './cron-job-definitions';
import { ExpiredApiTokenCleanupService } from './expired-api-token-cleanup.service';
import { OldJobCleanupService } from './old-job-cleanup.service';
import { RecordCountRefreshService } from './record-count-refresh.service';
import { RoutineRunReaperService } from './routine-run-reaper.service';
import { ScratchGitDiskObservabilityService } from './scratch-git-disk-observability.service';
import { StagingDirReaperService } from './staging-dir-reaper.service';
import { StaleJobReaperService } from './stale-job-reaper.service';

const LOG_SOURCE = 'CronDebugController';

/**
 * Admin-only dev tool for manually triggering a cron job now, for testing — the write side of the cron
 * dev panel ({@link CronController} serves the read-only list). Lives in {@link CronModule} alongside the
 * `@Cron` services it invokes, so it's mounted only on the cron service / local monolith, never on the
 * deployed API service (which doesn't run the schedules). Manual triggering is a local-dev-only
 * convenience: it's refused with a 403 in deployed environments (see {@link isManualCronTriggeringAllowed}).
 */
@Controller('cron')
@UseGuards(ScratchAuthGuard)
export class CronDebugController {
  constructor(
    private readonly recordCountRefresh: RecordCountRefreshService,
    private readonly oldJobCleanup: OldJobCleanupService,
    private readonly staleJobReaper: StaleJobReaperService,
    private readonly routineRunReaper: RoutineRunReaperService,
    private readonly expiredApiTokenCleanup: ExpiredApiTokenCleanupService,
    private readonly scratchGitDiskObservability: ScratchGitDiskObservabilityService,
    private readonly stagingDirReaper: StagingDirReaperService,
  ) {}

  /**
   * Maps each cron-job slug to the exact method its `@Cron` schedule calls, so a manual trigger is
   * identical to a scheduled run. Keep the keys in sync with `CRON_JOB_DEFINITIONS`; when adding a new
   * cron job, add its metadata there and its runner here.
   */
  private runnerBySlug(): Record<string, () => Promise<void>> {
    return {
      'record-count-refresh': () => this.recordCountRefresh.refreshRecordCounts(),
      'old-job-cleanup': () => this.oldJobCleanup.cleanupOldJobs(),
      'stale-job-reaper': () => this.staleJobReaper.reapStaleCreatedJobs(),
      'stale-active-job-reaper': () => this.staleJobReaper.reapStaleActiveJobs(),
      'routine-run-reaper': () => this.routineRunReaper.reapStuckRoutineRuns(),
      'expired-api-token-cleanup': () => this.expiredApiTokenCleanup.cleanupExpiredWhalesyncSessionTokens(),
      'scratch-git-disk-observability': () => this.scratchGitDiskObservability.emitDiskObservabilityMetrics(),
      'staging-dir-reaper': () => this.stagingDirReaper.reapStagingDirs(),
    };
  }

  private assertAdmin(req: RequestWithUser): void {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can access cron dev tools');
    }
  }

  /**
   * Run a cron job now, by slug. Awaits the job and reports the outcome — failures come back as
   * `{ ran: false, error }` (HTTP 200) so the dev tool can show them inline rather than a raw 500.
   * Refused with a 403 in deployed environments (manual triggering is local-dev only).
   */
  @Post('jobs/:slug/trigger')
  async triggerCronJob(@Param('slug') slug: string, @Req() req: RequestWithUser): Promise<TriggerCronJobResponseDto> {
    this.assertAdmin(req);
    if (!isManualCronTriggeringAllowed()) {
      throw new ForbiddenException(CRON_TRIGGERING_DISABLED_MESSAGE);
    }
    const run = this.runnerBySlug()[slug];
    if (!run) {
      throw new NotFoundException(`Unknown cron job: ${slug}`);
    }

    WSLogger.info({ source: LOG_SOURCE, message: 'Admin manually triggering cron job', slug, userId: req.user.id });
    const startedAt = Date.now();
    try {
      await run();
      return { slug, ran: true, durationMs: Date.now() - startedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      WSLogger.warn({ source: LOG_SOURCE, message: 'Manually-triggered cron job failed', slug, error });
      return { slug, ran: false, durationMs: Date.now() - startedAt, error: message };
    }
  }
}
