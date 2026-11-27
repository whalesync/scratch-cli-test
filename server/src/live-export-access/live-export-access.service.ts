import { Injectable } from '@nestjs/common';
import { Schedule, WorkbookManager } from '@prisma/client';
import { RoutineRunTrigger, ScratchPlanType, WhalesyncLiveExportAccess, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import {
  isCronScheduleFasterThanLiveExportCadence,
  leastTimeBetweenScheduledLiveExportRuns,
  LIVE_EXPORT_ACCESS_WITH_NO_LIMITS,
  readLiveExportAccessFromWhalesyncPlanMetadata,
} from './live-export-access-rules';
import {
  LiveExportPausedException,
  LiveExportScheduledRunSoonerThanFastestCadenceError,
} from './live-export-access.errors';

const LOG_SOURCE = 'LiveExportAccessService';

/** The parts of a schedule its speed check reads. */
export type ScheduleTiming = Pick<Schedule, 'cronExpression' | 'timezone'>;

/**
 * Carries out the Live Export access Whalesync sets for each team (DEV-12983). Whalesync works out from the team's plan
 * whether its Live Exports are paused, how many records they may hold, and how fast they may run on a schedule, and
 * sends that to the team's shadow user; it lives in the metadata of the organization's `WHALESYNC_PLAN` row. Scratch
 * never reads a Whalesync subscription. Each check is a no-op for workbooks that aren't Live Exports (`ws_export`).
 *
 * - `RoutineExecutorService.triggerRun` refuses a paused team's runs and skips a scheduled run that comes too soon for
 *   the team's speed ({@link assertLiveExportRunAllowedOrThrow}).
 * - `LiveExportRecordLimitEnforcer` refuses a paused team's sync and publish jobs, since those can be started without a
 *   run, and caps records at the team's limit ({@link readLiveExportAccessOfOrganization}).
 *
 * The rules themselves are in `live-export-access-rules.ts`.
 */
@Injectable()
export class LiveExportAccessService {
  constructor(private readonly db: DbService) {}

  /**
   * The organization's Live Export access, read from its most recently updated `WHALESYNC_PLAN` row. With no such row,
   * its Live Exports run with no limits: a team is paused only once Whalesync says so.
   */
  async readLiveExportAccessOfOrganization(organizationId: string): Promise<WhalesyncLiveExportAccess> {
    const whalesyncPlanSubscription = await this.db.client.subscription.findFirst({
      where: { organizationId, planType: ScratchPlanType.WHALESYNC_PLAN },
      select: { metadata: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!whalesyncPlanSubscription) {
      return LIVE_EXPORT_ACCESS_WITH_NO_LIMITS;
    }
    return readLiveExportAccessFromWhalesyncPlanMetadata(whalesyncPlanSubscription.metadata);
  }

  /**
   * The organization that owns a workbook when the workbook is a Live Export (`ws_export`), or null for any other
   * workbook, or one that doesn't exist.
   */
  async findOrganizationIdOfLiveExportWorkbook(workbookId: string): Promise<string | null> {
    const workbook = await this.db.client.workbook.findUnique({
      where: { id: workbookId },
      select: { managedBy: true, organizationId: true },
    });
    if (!workbook || workbook.managedBy !== WorkbookManager.ws_export) {
      return null;
    }
    return workbook.organizationId;
  }

  /**
   * Refuses a Live Export run the team's access doesn't allow. `RoutineExecutorService.triggerRun` calls this before
   * it creates the run, so a refused run leaves no row behind.
   *
   * - While the team is paused, throws {@link LiveExportPausedException} (403), for manual and scheduled runs alike.
   * - A scheduled run whose schedule is faster than the team's fastest speed, coming sooner after the routine's last
   *   scheduled run than that speed allows, throws {@link LiveExportScheduledRunSoonerThanFastestCadenceError}. A
   *   downgrade then slows existing exports without anyone's schedule being rewritten, and an upgrade speeds them up
   *   again. A schedule that fits the speed is never compared with past runs, so a late scheduler can't cost a run.
   *   Without `schedule`, a scheduled run is always compared.
   */
  async assertLiveExportRunAllowedOrThrow(args: {
    workbookId: WorkbookId;
    routineFilePath: string;
    trigger: RoutineRunTrigger;
    schedule: ScheduleTiming | undefined;
    now: Date;
  }): Promise<void> {
    const { workbookId, routineFilePath, trigger, schedule, now } = args;
    const organizationIdOfLiveExport = await this.findOrganizationIdOfLiveExportWorkbook(workbookId);
    if (organizationIdOfLiveExport === null) {
      return;
    }
    const liveExportAccess = await this.readLiveExportAccessOfOrganization(organizationIdOfLiveExport);

    if (liveExportAccess.paused) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: "Refused a Live Export run: Whalesync paused the team's Live Exports",
        organizationId: organizationIdOfLiveExport,
        workbookId,
        routineFilePath,
        trigger,
      });
      throw new LiveExportPausedException();
    }

    const fastestCadence = liveExportAccess.fastestCadence;
    if (trigger !== 'schedule' || fastestCadence === null) {
      return;
    }
    if (
      schedule !== undefined &&
      isCronScheduleFasterThanLiveExportCadence(schedule.cronExpression, schedule.timezone, fastestCadence, now) ===
        false
    ) {
      return;
    }

    const lastScheduledRun = await this.db.client.routineRun.findFirst({
      where: { workbookId, routineFilePath, trigger: 'schedule' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!lastScheduledRun) {
      return;
    }
    const earliestNextScheduledRunAt = leastTimeBetweenScheduledLiveExportRuns(fastestCadence).after(
      lastScheduledRun.createdAt,
    );
    if (now >= earliestNextScheduledRunAt) {
      return;
    }
    throw new LiveExportScheduledRunSoonerThanFastestCadenceError(fastestCadence, lastScheduledRun.createdAt);
  }
}
