import { Controller, Get, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { ListCronJobsResponseDto } from '@spinner/shared-types';
import { hasAdminToolsPermission } from 'src/auth/permissions';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { CRON_JOB_DEFINITIONS, getCronServiceLogsUrl, isManualCronTriggeringAllowed } from './cron-job-definitions';

/**
 * Admin-only, read-only view of the server's cron jobs. Backs the "Cron Jobs" dev-tool panel in the
 * web client (`/settings/dev/cron`).
 *
 * Dependency-free on purpose: it lists the static {@link CRON_JOB_DEFINITIONS} and must NOT pull in the
 * `@Cron` services, so it can be mounted on the deployed API service (the one the browser talks to)
 * without instantiating — and thereby double-firing — the schedules. Manually triggering a job lives
 * in {@link CronDebugController} instead, which is mounted only where the schedules run.
 */
@Controller('cron')
@UseGuards(ScratchAuthGuard)
export class CronController {
  private assertAdmin(req: RequestWithUser): void {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can access cron dev tools');
    }
  }

  /**
   * List the registered cron jobs. `canTrigger` tells the web client whether this environment permits
   * a manual run (true only in local development; see {@link isManualCronTriggeringAllowed}), and
   * `cronServiceLogsUrl` is a GCP Cloud Logging deep link for the cron service (deployed environments
   * only; see {@link getCronServiceLogsUrl}).
   */
  @Get('jobs')
  listCronJobs(@Req() req: RequestWithUser): ListCronJobsResponseDto {
    this.assertAdmin(req);
    return {
      jobs: CRON_JOB_DEFINITIONS,
      canTrigger: isManualCronTriggeringAllowed(),
      cronServiceLogsUrl: getCronServiceLogsUrl(),
    };
  }
}
