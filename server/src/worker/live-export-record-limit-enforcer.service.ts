import { Inject, Injectable } from '@nestjs/common';
import { JobType, RoutineRunId } from '@spinner/shared-types';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { LIVE_EXPORT_PAUSED_MESSAGE } from 'src/live-export-access/live-export-access.errors';
import { LiveExportAccessService } from 'src/live-export-access/live-export-access.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { JobData } from './jobs/union-types';

const LOG_SOURCE = 'LiveExportRecordLimitEnforcer';

/**
 * The record-moving job types held to a team's Live Export access. `Publish` ships approved edits to the destination
 * service; `SyncDataFolders` copies records folder→folder. The draft-save job (`ApplySyncDraft`) sets a Live Export
 * *up* rather than moving records, so it is deliberately not checked — a user must be able to build an export while
 * paused or over the limit.
 */
const LIVE_EXPORT_ACCESS_CHECKED_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  JobType.Publish,
  JobType.SyncDataFolders,
]);

/**
 * Holds a Live Export's sync and publish jobs to the team's Live Export access at the start of the job (DEV-12983):
 * refused while Whalesync has paused the team's Live Exports, and failed while the team is over its record limit
 * (DEV-11157). Called from `QueueService.processJob` — the single point every job passes through — so one check
 * covers publish, the sync job, and the publish job a sync re-enqueues, however they were started.
 *
 * Whalesync works out the access from the team's plan and sends it to the team's shadow user, where it lives on the
 * organization's internal `WHALESYNC_PLAN` row (read through `LiveExportAccessService`). Scratch never reads a
 * Whalesync subscription.
 *
 * The record limit is behind the same fail-closed `SUBSCRIPTION_ENFORCEMENT_ENABLED` flag as
 * `SubscriptionEnforcementService`: OFF by default, and an absent flag or a PostHog outage leaves it off (it never
 * blocks a job blindly). The pause is not behind any flag: Whalesync decides when a team is paused.
 */
@Injectable()
export class LiveExportRecordLimitEnforcer {
  constructor(
    private readonly liveExportAccessService: LiveExportAccessService,
    private readonly dataFolderService: DataFolderService,
    private readonly experimentsService: ExperimentsService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  /**
   * Throws (failing the calling job) when `jobData` is a sync or publish job for a Live Export workbook whose team the
   * access holds back. A no-op for every other job type and for workbooks that aren't Live Exports.
   *
   * - **Paused:** refuses the job, unless it belongs to a routine run (`routineRunIdOfJob`). A run's own jobs were
   *   allowed when the run started, since `RoutineExecutorService.triggerRun` refuses a paused team's runs, so a run
   *   that was going when the pause arrived finishes instead of failing partway and emailing the team.
   * - **Over the record limit:** fails the job with a message naming the current count and the limit, while the
   *   enforcement flag is on and the team has a limit.
   */
  async assertLiveExportJobAllowedOrThrow(
    jobData: JobData,
    routineRunIdOfJob: RoutineRunId | undefined,
  ): Promise<void> {
    if (!LIVE_EXPORT_ACCESS_CHECKED_JOB_TYPES.has(jobData.type)) {
      return;
    }
    // Every checked job type carries `workbookId`; read it structurally (mirrors the generic job.data reads in
    // QueueService) rather than narrowing the whole discriminated union.
    const workbookId = (jobData as { workbookId?: string }).workbookId;
    if (!workbookId) {
      return;
    }

    const organizationIdOfLiveExport =
      await this.liveExportAccessService.findOrganizationIdOfLiveExportWorkbook(workbookId);
    // Only Live Export (Whalesync-managed) workbooks carry an access; a standalone workbook is never checked.
    if (organizationIdOfLiveExport === null) {
      return;
    }
    const liveExportAccess =
      await this.liveExportAccessService.readLiveExportAccessOfOrganization(organizationIdOfLiveExport);

    if (liveExportAccess.paused && routineRunIdOfJob === undefined) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: "Refused a Live Export job: Whalesync paused the team's Live Exports",
        organizationId: organizationIdOfLiveExport,
        workbookId,
        jobType: jobData.type,
      });
      // This message becomes DbJob.error → JobEntity.failedReason, shown to the user verbatim.
      throw new Error(LIVE_EXPORT_PAUSED_MESSAGE);
    }

    const recordCountLimit = liveExportAccess.recordLimit;
    if (recordCountLimit === null) {
      return;
    }
    // Fail-closed opt-in gate / kill switch for the record limit — the same master switch as
    // SubscriptionEnforcementService. Flip the flag off to halt enforcement without a redeploy.
    const recordLimitEnforcementEnabled = await this.experimentsService.getBooleanFlag(
      SystemFeatureFlag.SUBSCRIPTION_ENFORCEMENT_ENABLED,
      false,
    );
    if (!recordLimitEnforcementEnabled) {
      return;
    }

    const currentRecordCount =
      await this.dataFolderService.sumWhalesyncEligibleRecordCountForOrganization(organizationIdOfLiveExport);
    if (currentRecordCount <= recordCountLimit) {
      return;
    }

    this.metricsService.logValue(CustomMetric.LIVE_EXPORT_RECORD_LIMIT_ENFORCED, 1);
    WSLogger.warn({
      source: LOG_SOURCE,
      message: 'Blocked a Live Export job: organization is over its Live Export record limit',
      organizationId: organizationIdOfLiveExport,
      workbookId,
      jobType: jobData.type,
      currentRecordCount,
      recordCountLimit,
    });
    // This message becomes DbJob.error → JobEntity.failedReason, shown to the user verbatim.
    throw new Error(
      `Live Export record limit reached: your Live Exports contain ${currentRecordCount.toLocaleString()} ` +
        `records, which exceeds your plan's limit of ${recordCountLimit.toLocaleString()}. Remove records or ` +
        `upgrade your plan to resume syncing and publishing.`,
    );
  }
}
