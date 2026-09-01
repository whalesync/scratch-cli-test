import { Inject, Injectable } from '@nestjs/common';
import { Prisma, WorkbookManager } from '@prisma/client';
import { JobType, ScratchPlanType } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { JobData } from './jobs/union-types';

const LOG_SOURCE = 'LiveExportRecordLimitEnforcer';

/**
 * The record-moving job types gated on the Live Export record limit. `Publish` ships approved edits to the
 * destination service; `SyncDataFolders` copies records folder→folder. The draft-save job (`ApplySyncDraft`)
 * sets a Live Export *up* rather than moving records, so it is deliberately not gated — a user must be able to
 * configure their export even while over the limit.
 */
const RECORD_LIMIT_ENFORCED_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  JobType.Publish,
  JobType.SyncDataFolders,
]);

/**
 * Enforces each organization's Live Export record limit (DEV-11157) at the start of a sync or publish job.
 *
 * Whalesync computes a plan's Live Export record limit and pushes it onto the organization's internal
 * `WHALESYNC_PLAN` subscription (`Subscription.metadata.liveExportRecordCountLimit`, written by the
 * `/internal/whalesync/*` endpoints — see DEV-11400). When a sync/publish job runs for a Live Export workbook
 * (`Workbook.managedBy === ws_export`) whose organization's eligible record count is over that limit, the job
 * is failed with a message naming the current count and the limit, so nothing further is exported until the
 * user reduces records or upgrades.
 *
 * Gated behind the same fail-closed `SUBSCRIPTION_ENFORCEMENT_ENABLED` flag as
 * `SubscriptionEnforcementService`: OFF by default, and an absent flag or a PostHog outage leaves enforcement
 * off (it never blocks a job blindly). Called from `QueueService.processJob` — the single point every job
 * passes through — so one check covers publish, the sync job, and the publish job a sync re-enqueues.
 */
@Injectable()
export class LiveExportRecordLimitEnforcer {
  constructor(
    private readonly db: DbService,
    private readonly dataFolderService: DataFolderService,
    private readonly experimentsService: ExperimentsService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  /**
   * Throws (failing the calling job) when `jobData` is a sync/publish job for a Live Export workbook whose
   * organization is over its Live Export record limit. A no-op for every other job type, for non-Live-Export
   * workbooks, when the flag is off, and when no limit is configured. Cheapest checks run first so the
   * OFF-by-default path does no database work.
   */
  async assertWithinLiveExportRecordLimitOrThrow(jobData: JobData): Promise<void> {
    if (!RECORD_LIMIT_ENFORCED_JOB_TYPES.has(jobData.type)) {
      return;
    }
    // Every gated job type carries `workbookId`; read it structurally (mirrors the generic job.data reads in
    // QueueService) rather than narrowing the whole discriminated union.
    const workbookId = (jobData as { workbookId?: string }).workbookId;
    if (!workbookId) {
      return;
    }

    // Fail-closed opt-in gate / kill switch — the same master switch as SubscriptionEnforcementService.
    // Evaluated before any DB work so the OFF-by-default path is free; flip the flag off to halt enforcement
    // without a redeploy.
    const enforcementEnabled = await this.experimentsService.getBooleanFlag(
      SystemFeatureFlag.SUBSCRIPTION_ENFORCEMENT_ENABLED,
      false,
    );
    if (!enforcementEnabled) {
      return;
    }

    const workbook = await this.db.client.workbook.findUnique({
      where: { id: workbookId },
      select: { managedBy: true, organizationId: true },
    });
    // Only Live Export (Whalesync-managed) workbooks carry a record limit; a standalone workbook is never gated.
    if (!workbook || workbook.managedBy !== WorkbookManager.ws_export) {
      return;
    }

    const recordCountLimit = await this.readLiveExportRecordCountLimit(workbook.organizationId);
    if (recordCountLimit === undefined) {
      return;
    }

    const currentRecordCount = await this.dataFolderService.sumWhalesyncEligibleRecordCountForOrganization(
      workbook.organizationId,
    );
    if (currentRecordCount <= recordCountLimit) {
      return;
    }

    this.metricsService.logValue(CustomMetric.LIVE_EXPORT_RECORD_LIMIT_ENFORCED, 1);
    WSLogger.warn({
      source: LOG_SOURCE,
      message: 'Blocked a Live Export job: organization is over its Live Export record limit',
      organizationId: workbook.organizationId,
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

  /**
   * The Live Export record limit on the organization's internal `WHALESYNC_PLAN` subscription
   * (`Subscription.metadata.liveExportRecordCountLimit`, shape `WhalesyncSubscriptionMetadata`), or `undefined`
   * when there is no such subscription or the limit was never set. A configured numeric limit — including `0`
   * — is returned as-is and enforced literally.
   */
  private async readLiveExportRecordCountLimit(organizationId: string): Promise<number | undefined> {
    const subscription = await this.db.client.subscription.findFirst({
      where: { organizationId, planType: ScratchPlanType.WHALESYNC_PLAN },
      select: { metadata: true },
      orderBy: { updatedAt: 'desc' },
    });
    return extractLiveExportRecordCountLimit(subscription?.metadata ?? null);
  }
}

/**
 * Reads `liveExportRecordCountLimit` out of the untyped `Subscription.metadata` JSON blob defensively,
 * returning it only when the blob is an object carrying that key as a number.
 */
function extractLiveExportRecordCountLimit(metadata: Prisma.JsonValue | null): number | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const rawLimit = (metadata as Record<string, unknown>).liveExportRecordCountLimit;
  return typeof rawLimit === 'number' ? rawLimit : undefined;
}
