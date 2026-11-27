import { WorkbookManager } from '@prisma/client';
import { JobType, RoutineRunId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { LIVE_EXPORT_PAUSED_MESSAGE } from 'src/live-export-access/live-export-access.errors';
import { LiveExportAccessService } from 'src/live-export-access/live-export-access.service';
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

const ROUTINE_RUN_ID = 'rrn_1' as RoutineRunId;

describe('LiveExportRecordLimitEnforcer', () => {
  let enforcer: LiveExportRecordLimitEnforcer;
  let workbookFindUnique: jest.Mock;
  let subscriptionFindFirst: jest.Mock;
  let sumWhalesyncEligibleRecordCountForOrganization: jest.Mock;
  let getBooleanFlag: jest.Mock;
  let logValue: jest.Mock;

  const liveExportWorkbook = { managedBy: WorkbookManager.ws_export, organizationId: 'org_1' };

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation(() => {});
    jest.spyOn(WSLogger, 'warn').mockImplementation(() => {});

    workbookFindUnique = jest.fn();
    subscriptionFindFirst = jest.fn().mockResolvedValue(null);
    sumWhalesyncEligibleRecordCountForOrganization = jest.fn();
    logValue = jest.fn();
    // Record limit enforcement enabled by default; the gate tests flip it off.
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

    enforcer = new LiveExportRecordLimitEnforcer(
      new LiveExportAccessService(mockDb),
      mockDataFolder,
      mockExperiments,
      mockMetrics,
    );
  });

  it('is a no-op for a job type that is not sync/publish (does no DB work)', async () => {
    await expect(
      enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.PullLinkedFolderFiles), undefined),
    ).resolves.toBeUndefined();

    expect(getBooleanFlag).not.toHaveBeenCalled();
    expect(workbookFindUnique).not.toHaveBeenCalled();
  });

  it('is a no-op when the job carries no workbookId', async () => {
    const publishJobWithoutWorkbookId = { type: JobType.Publish } as unknown as JobData;

    await expect(
      enforcer.assertLiveExportJobAllowedOrThrow(publishJobWithoutWorkbookId, undefined),
    ).resolves.toBeUndefined();

    expect(getBooleanFlag).not.toHaveBeenCalled();
    expect(workbookFindUnique).not.toHaveBeenCalled();
  });

  it('is a no-op for a workbook that is not a Live Export (ws_export) workbook', async () => {
    workbookFindUnique.mockResolvedValue({ managedBy: null, organizationId: 'org_1' });

    await expect(
      enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.Publish), undefined),
    ).resolves.toBeUndefined();

    expect(subscriptionFindFirst).not.toHaveBeenCalled();
    expect(sumWhalesyncEligibleRecordCountForOrganization).not.toHaveBeenCalled();
  });

  it('lets a Live Export job run when Whalesync has sent the team no access at all', async () => {
    workbookFindUnique.mockResolvedValue(liveExportWorkbook);

    await expect(
      enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.Publish), undefined),
    ).resolves.toBeUndefined();

    expect(subscriptionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_1', planType: 'WHALESYNC_PLAN' } }),
    );
    expect(sumWhalesyncEligibleRecordCountForOrganization).not.toHaveBeenCalled();
  });

  describe("while Whalesync has paused the team's Live Exports (DEV-12983)", () => {
    beforeEach(() => {
      workbookFindUnique.mockResolvedValue(liveExportWorkbook);
      subscriptionFindFirst.mockResolvedValue({
        metadata: { liveExportsPaused: true, liveExportRecordCountLimit: 100 },
      });
    });

    it.each([JobType.Publish, JobType.SyncDataFolders])(
      'refuses a %s job started outside a run, with the flag off',
      async (jobType) => {
        getBooleanFlag.mockResolvedValue(false);

        await expect(enforcer.assertLiveExportJobAllowedOrThrow(jobData(jobType), undefined)).rejects.toThrow(
          LIVE_EXPORT_PAUSED_MESSAGE,
        );

        expect(getBooleanFlag).not.toHaveBeenCalled();
        expect(logValue).not.toHaveBeenCalled();
      },
    );

    it('lets a job of a run that was already going finish, still holding it to the record limit', async () => {
      sumWhalesyncEligibleRecordCountForOrganization.mockResolvedValue(100);

      await expect(
        enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.SyncDataFolders), ROUTINE_RUN_ID),
      ).resolves.toBeUndefined();

      sumWhalesyncEligibleRecordCountForOrganization.mockResolvedValue(101);
      await expect(
        enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.Publish), ROUTINE_RUN_ID),
      ).rejects.toThrow(/Live Export record limit reached/);
    });
  });

  describe('the record limit', () => {
    beforeEach(() => {
      workbookFindUnique.mockResolvedValue(liveExportWorkbook);
    });

    it('evaluates the enablement flag fail-closed (default false)', async () => {
      subscriptionFindFirst.mockResolvedValue({ metadata: { liveExportRecordCountLimit: 100 } });
      getBooleanFlag.mockResolvedValue(false);

      await enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.Publish), undefined);

      expect(getBooleanFlag).toHaveBeenCalledWith(SystemFeatureFlag.SUBSCRIPTION_ENFORCEMENT_ENABLED, false);
    });

    it('is not counted while the flag is off', async () => {
      subscriptionFindFirst.mockResolvedValue({ metadata: { liveExportRecordCountLimit: 100 } });
      getBooleanFlag.mockResolvedValue(false);

      await expect(
        enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.SyncDataFolders), undefined),
      ).resolves.toBeUndefined();

      expect(sumWhalesyncEligibleRecordCountForOrganization).not.toHaveBeenCalled();
    });

    it('is a no-op when the team has no record limit (never reads the flag)', async () => {
      // A row from before Live Export access, whose metadata carries no liveExportRecordCountLimit.
      subscriptionFindFirst.mockResolvedValue({ metadata: { whalesyncStatus: 'active' } });

      await expect(
        enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.Publish), undefined),
      ).resolves.toBeUndefined();

      expect(getBooleanFlag).not.toHaveBeenCalled();
      expect(sumWhalesyncEligibleRecordCountForOrganization).not.toHaveBeenCalled();
      expect(logValue).not.toHaveBeenCalled();
    });

    it('allows the job when the current count is at or under the limit', async () => {
      subscriptionFindFirst.mockResolvedValue({ metadata: { liveExportRecordCountLimit: 100 } });
      sumWhalesyncEligibleRecordCountForOrganization.mockResolvedValue(100);

      await expect(
        enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.SyncDataFolders), undefined),
      ).resolves.toBeUndefined();

      expect(logValue).not.toHaveBeenCalled();
    });

    it('fails the job with a count-vs-limit message and emits the metric when over the limit', async () => {
      subscriptionFindFirst.mockResolvedValue({
        metadata: { liveExportsPaused: false, liveExportRecordCountLimit: 100 },
      });
      sumWhalesyncEligibleRecordCountForOrganization.mockResolvedValue(150);

      await expect(enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.Publish), undefined)).rejects.toThrow(
        /150.*100/,
      );

      expect(logValue).toHaveBeenCalledWith(CustomMetric.LIVE_EXPORT_RECORD_LIMIT_ENFORCED, 1);
      expect(sumWhalesyncEligibleRecordCountForOrganization).toHaveBeenCalledWith('org_1');
    });

    it('enforces a literal limit of 0 (blocks when any eligible records exist)', async () => {
      subscriptionFindFirst.mockResolvedValue({ metadata: { liveExportRecordCountLimit: 0 } });
      sumWhalesyncEligibleRecordCountForOrganization.mockResolvedValue(1);

      await expect(
        enforcer.assertLiveExportJobAllowedOrThrow(jobData(JobType.SyncDataFolders), undefined),
      ).rejects.toThrow(/Live Export record limit reached/);

      expect(logValue).toHaveBeenCalledWith(CustomMetric.LIVE_EXPORT_RECORD_LIMIT_ENFORCED, 1);
    });
  });
});
