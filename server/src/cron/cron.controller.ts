import { Controller, Get, NotFoundException, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { ListCronJobsResponseDto, TriggerCronJobResponseDto } from '@spinner/shared-types';
import { hasAdminToolsPermission } from 'src/auth/permissions';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { WSLogger } from 'src/logger';
import { ExpiredApiTokenCleanupService } from './expired-api-token-cleanup.service';
import { OldJobCleanupService } from './old-job-cleanup.service';
import { RecordCountRefreshService } from './record-count-refresh.service';
import { RoutineRunReaperService } from './routine-run-reaper.service';
import { StaleJobReaperService } from './stale-job-reaper.service';

const LOG_SOURCE = 'CronController';

interface CronJobDescriptor {
  slug: string;
  description: string;
  schedule: string;
  run: () => Promise<void>;
}

/**
 * Admin-only dev tool for manually triggering cron jobs, which otherwise only run on their
 * schedule. Backs a web-client dev panel. Every endpoint requires admin permissions (the
 * same gate as the dev-tools module).
 */
@Controller('cron')
@UseGuards(ScratchAuthGuard)
export class CronController {
  constructor(
    private readonly recordCountRefresh: RecordCountRefreshService,
    private readonly oldJobCleanup: OldJobCleanupService,
    private readonly staleJobReaper: StaleJobReaperService,
    private readonly routineRunReaper: RoutineRunReaperService,
    private readonly expiredApiTokenCleanup: ExpiredApiTokenCleanupService,
  ) {}

  /**
   * The registry of triggerable cron jobs. Each `run` invokes the exact method the `@Cron`
   * schedule calls, so a manual trigger is identical to a scheduled run. Add new cron jobs
   * here as they're created so the dev tool can list and trigger them.
   */
  private cronJobs(): CronJobDescriptor[] {
    return [
      {
        slug: 'record-count-refresh',
        description: "Reconcile every workbook's per-folder record counts with git.",
        schedule: 'EVERY_HOUR',
        run: () => this.recordCountRefresh.refreshRecordCounts(),
      },
      {
        slug: 'old-job-cleanup',
        description: 'Delete completed/failed/canceled jobs past the retention period.',
        schedule: 'EVERY_DAY_AT_3AM',
        run: () => this.oldJobCleanup.cleanupOldJobs(),
      },
      {
        slug: 'stale-job-reaper',
        description: 'Fail jobs stuck in the created state past the stale threshold.',
        schedule: 'EVERY_5_MINUTES',
        run: () => this.staleJobReaper.reapStaleCreatedJobs(),
      },
      {
        slug: 'routine-run-reaper',
        description: 'Resume routine runs stuck in the running state.',
        schedule: 'EVERY_5_MINUTES',
        run: () => this.routineRunReaper.reapStuckRoutineRuns(),
      },
      {
        slug: 'expired-api-token-cleanup',
        description: 'Delete expired Whalesync session tokens.',
        schedule: 'EVERY_HOUR',
        run: () => this.expiredApiTokenCleanup.cleanupExpiredWhalesyncSessionTokens(),
      },
    ];
  }

  private assertAdmin(req: RequestWithUser): void {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can access cron dev tools');
    }
  }

  /** List the cron jobs that can be manually triggered. */
  @Get('jobs')
  listCronJobs(@Req() req: RequestWithUser): ListCronJobsResponseDto {
    this.assertAdmin(req);
    return {
      jobs: this.cronJobs().map(({ slug, description, schedule }) => ({ slug, description, schedule })),
    };
  }

  /**
   * Run a cron job now, by slug. Awaits the job and reports the outcome — failures come back
   * as `{ ran: false, error }` (HTTP 200) so the dev tool can show them inline rather than a
   * raw 500.
   */
  @Post('jobs/:slug/trigger')
  async triggerCronJob(@Param('slug') slug: string, @Req() req: RequestWithUser): Promise<TriggerCronJobResponseDto> {
    this.assertAdmin(req);
    const job = this.cronJobs().find((candidate) => candidate.slug === slug);
    if (!job) {
      throw new NotFoundException(`Unknown cron job: ${slug}`);
    }

    WSLogger.info({ source: LOG_SOURCE, message: 'Admin manually triggering cron job', slug, userId: req.user.id });
    const startedAt = Date.now();
    try {
      await job.run();
      return { slug, ran: true, durationMs: Date.now() - startedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      WSLogger.warn({ source: LOG_SOURCE, message: 'Manually-triggered cron job failed', slug, error });
      return { slug, ran: false, durationMs: Date.now() - startedAt, error: message };
    }
  }
}
