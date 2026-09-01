import { WorkbookManager } from '@prisma/client';
import { JobType } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { JobData } from '../jobs/union-types';
import { LiveExportRecordLimitEnforcer } from '../live-export-record-limit-enforcer.service';

// Minimal job data — the enforcer only reads `type` and `workbookId`.
function jobData(type: JobType, workbookId: string | undefined = 'wkb_1'): JobData {
  return { type, workbookId } as unknown as JobData;
}

describe('LiveExportRecordLimitEnforcer', () => {
  let enforcer: LiveExportRecordLimitEnforcer;
  let workbookFindUnique: jest.Mock;
  let subscriptionFindFirst: jest.Mock;
  let sumWhalesyncEligibleRecordCountForOrganization: jest.Mock;
  let getBooleanFlag: jest.Mock;
  let logValue: jest.Mock;

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation(() => {});
    jest.spyOn(WSLogger, 'warn').mockImplementation(() => {});

    workbookFindUnique = jest.fn();
    subscriptionFindFirst = jest.fn();
    sumWhalesyncEligibleRecordCountForOrganization = jest.fn();
    logValue = jest.fn();
    // Enforcement enabled by default; the gate tests flip it off.
    getBooleanFlag = jest.fn().mockResolvedValue(true);

    const mockDb = {
      client: {
        workbook: { findUnique: workbookFindUnique },
        subscription: { findFirst: subscriptionFindFirst },
      },
    } as unknown as DbService;
    const mockDataFolder = {
      sumWhalesyncEligibleRecordCountForOrganization,
    } as unknown as DataFolderService;
    const mockExperiments = { getBooleanFlag } as unknown as ExperimentsService;
    const mockMetrics = { logValue } as unknown as CustomMetricsService;

    enforcer = new LiveExportRecordLimitEnforcer(mockDb, mockDataFolder, mockExperiments, mockMetrics);
  });

  it('is a no-op for a job type that is not sync/publish (never checks the flag)', async () => {
    await expect(
      enforcer.assertWithinLiveExportRecordLimitOrThrow(jobData(JobType.PullLinkedFolderFiles)),
    ).resolves.toBeUndefined();

    expect(getBooleanFlag).not.toHaveBeenCalled();
    expect(workbookFindUnique).not.toHaveBeenCalled();
  });

  it('is a no-op when the job carries no workbookId', async () => {
    const publishJobWithoutWorkbookId = { type: JobType.Publish } as unknown as JobData;

    await expect(
      enforcer.assertWithinLiveExportRecordLimitOrThrow(publishJobWithoutWorkbookId),
    ).resolves.toBeUndefined();

    expect(getBooleanFlag).not.toHaveBeenCalled();
    expect(workbookFindUnique).not.toHaveBeenCalled();
  });

  it('evaluates the enablement flag fail-closed (default false)', async () => {
    getBooleanFlag.mockResolvedValue(false);

    await enforcer.assertWithinLiveExportRecordLimitOrThrow(jobData(JobType.Publish));

    expect(getBooleanFlag).toHaveBeenCalledWith(SystemFeatureFlag.SUBSCRIPTION_ENFORCEMENT_ENABLED, false);
  });

  it('is a no-op when the flag is off (does no DB work)', async () => {
    getBooleanFlag.mockResolvedValue(false);

    await expect(
      enforcer.assertWithinLiveExportRecordLimitOrThrow(jobData(JobType.SyncDataFolders)),
    ).resolves.toBeUndefined();

    expect(workbookFindUnique).not.toHaveBeenCalled();
  });

  it('is a no-op for a workbook that is not a Live Export (ws_export) workbook', async () => {
    workbookFindUnique.mockResolvedValue({ managedBy: null, organizationId: 'org_1' });

    await expect(enforcer.assertWithinLiveExportRecordLimitOrThrow(jobData(JobType.Publish))).resolves.toBeUndefined();

    expect(subscriptionFindFirst).not.toHaveBeenCalled();
    expect(sumWhalesyncEligibleRecordCountForOrganization).not.toHaveBeenCalled();
  });

  it('is a no-op when the organization has no Live Export record limit configured', async () => {
    workbookFindUnique.mockResolvedValue({ managedBy: WorkbookManager.ws_export, organizationId: 'org_1' });
    // Subscription exists but its metadata carries no liveExportRecordCountLimit.
    subscriptionFindFirst.mockResolvedValue({ metadata: { whalesyncStatus: 'active' } });

    await expect(enforcer.assertWithinLiveExportRecordLimitOrThrow(jobData(JobType.Publish))).resolves.toBeUndefined();

    expect(sumWhalesyncEligibleRecordCountForOrganization).not.toHaveBeenCalled();
    expect(logValue).not.toHaveBeenCalled();
  });

  it('allows the job when the current count is at or under the limit', async () => {
    workbookFindUnique.mockResolvedValue({ managedBy: WorkbookManager.ws_export, organizationId: 'org_1' });
    subscriptionFindFirst.mockResolvedValue({ metadata: { liveExportRecordCountLimit: 100 } });
    sumWhalesyncEligibleRecordCountForOrganization.mockResolvedValue(100);

    await expect(
      enforcer.assertWithinLiveExportRecordLimitOrThrow(jobData(JobType.SyncDataFolders)),
    ).resolves.toBeUndefined();

    expect(logValue).not.toHaveBeenCalled();
  });

  it('fails the job with a count-vs-limit message and emits the metric when over the limit', async () => {
    workbookFindUnique.mockResolvedValue({ managedBy: WorkbookManager.ws_export, organizationId: 'org_1' });
    subscriptionFindFirst.mockResolvedValue({ metadata: { liveExportRecordCountLimit: 100 } });
    sumWhalesyncEligibleRecordCountForOrganization.mockResolvedValue(150);

    await expect(enforcer.assertWithinLiveExportRecordLimitOrThrow(jobData(JobType.Publish))).rejects.toThrow(
      /150.*100/,
    );

    expect(logValue).toHaveBeenCalledWith(CustomMetric.LIVE_EXPORT_RECORD_LIMIT_ENFORCED, 1);
    expect(subscriptionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_1', planType: 'WHALESYNC_PLAN' } }),
    );
  });

  it('enforces a literal limit of 0 (blocks when any eligible records exist)', async () => {
    workbookFindUnique.mockResolvedValue({ managedBy: WorkbookManager.ws_export, organizationId: 'org_1' });
    subscriptionFindFirst.mockResolvedValue({ metadata: { liveExportRecordCountLimit: 0 } });
    sumWhalesyncEligibleRecordCountForOrganization.mockResolvedValue(1);

    await expect(enforcer.assertWithinLiveExportRecordLimitOrThrow(jobData(JobType.SyncDataFolders))).rejects.toThrow(
      /Live Export record limit reached/,
    );

    expect(logValue).toHaveBeenCalledWith(CustomMetric.LIVE_EXPORT_RECORD_LIMIT_ENFORCED, 1);
  });
});
