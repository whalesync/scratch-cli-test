/* eslint-disable @typescript-eslint/unbound-method */
import { JobType } from '@spinner/shared-types';
import { JobService } from 'src/job/job.service';
import { MigrationLockService } from 'src/migration-lock/migration-lock.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { ConnectionDrainTimeoutError, ConnectionQuiesceService } from '../connection-quiesce.service';

/**
 * DEV-9698 (T4) — orchestration of the per-connection quiesce: the acquire order
 * (lock → disable schedules → cancel publish plans → drain), the release
 * (restore → unlock → notify), and the abort-on-drain-timeout contract.
 */
describe('ConnectionQuiesceService', () => {
  const WORKBOOK_ID = 'wb_1';
  const CONNECTOR_ACCOUNT_ID = 'ca_1';

  let order: string[];
  let migrationLock: jest.Mocked<MigrationLockService>;
  let scheduleService: jest.Mocked<ScheduleService>;
  let publishPlanBuildService: jest.Mocked<PublishPlanBuildService>;
  let jobService: jest.Mocked<JobService>;
  let workbookEventService: jest.Mocked<WorkbookEventService>;
  let service: ConnectionQuiesceService;

  beforeEach(() => {
    order = [];
    const record = (step: string): Promise<void> => {
      order.push(step);
      return Promise.resolve();
    };
    migrationLock = {
      lockConnection: jest.fn(() => record('lock')),
      unlockConnection: jest.fn(() => record('unlock')),
      resolveConnectorAccountIdsForJob: jest.fn().mockResolvedValue([CONNECTOR_ACCOUNT_ID]),
    } as unknown as jest.Mocked<MigrationLockService>;
    scheduleService = {
      disableSchedulesForConnectionMigration: jest.fn(() => record('disableSchedules')),
      restoreSchedulesForConnectionMigration: jest.fn(() => record('restoreSchedules')),
    } as unknown as jest.Mocked<ScheduleService>;
    publishPlanBuildService = {
      cancelNonTerminalPlansForConnection: jest.fn(() => {
        order.push('cancelPlans');
        return Promise.resolve(2);
      }),
    } as unknown as jest.Mocked<PublishPlanBuildService>;
    jobService = {
      getNonTerminalJobsForWorkbook: jest.fn().mockResolvedValue([]),
      systemCancelJob: jest.fn().mockResolvedValue(undefined),
      getActiveBullJobDatas: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<JobService>;
    workbookEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as jest.Mocked<WorkbookEventService>;

    service = new ConnectionQuiesceService(
      migrationLock,
      scheduleService,
      publishPlanBuildService,
      jobService,
      workbookEventService,
    );
  });

  it('acquires in order: lock → disable schedules → cancel publish plans → drain', async () => {
    const summary = await service.quiesceConnection(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID);
    expect(order).toEqual(['lock', 'disableSchedules', 'cancelPlans']);
    expect(summary.cancelledPublishPlans).toBe(2);
    expect(summary.cancelledJobs).toBe(0);
  });

  it('cancels matching in-flight jobs and waits for the active set to clear', async () => {
    const job = {
      id: 'job_1',
      bullJobId: 'bull_1',
      data: { type: JobType.Publish, connectorAccountId: CONNECTOR_ACCOUNT_ID },
    };
    jobService.getNonTerminalJobsForWorkbook.mockResolvedValueOnce([job] as never);
    // First active poll: still running; second: cleared.
    jobService.getActiveBullJobDatas
      .mockResolvedValueOnce([{ type: JobType.Publish, connectorAccountId: CONNECTOR_ACCOUNT_ID }] as never)
      .mockResolvedValueOnce([]);

    const summary = await service.quiesceConnection(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID, { drainPollIntervalMs: 1 });
    expect(jobService.systemCancelJob).toHaveBeenCalledWith(job);
    expect(summary.cancelledJobs).toBe(1);
  });

  it('counts jobs cancelled in a later drain pass too (not just the first)', async () => {
    const jobA = {
      id: 'job_a',
      bullJobId: 'bull_a',
      data: { type: JobType.Publish, connectorAccountId: CONNECTOR_ACCOUNT_ID },
    };
    const jobB = {
      id: 'job_b',
      bullJobId: 'bull_b',
      data: { type: JobType.Publish, connectorAccountId: CONNECTOR_ACCOUNT_ID },
    };
    // jobA cancelled in the first pass; jobB (created → active between polls) in the second.
    jobService.getNonTerminalJobsForWorkbook
      .mockResolvedValueOnce([jobA] as never)
      .mockResolvedValueOnce([jobB] as never)
      .mockResolvedValue([]);
    jobService.getActiveBullJobDatas
      .mockResolvedValueOnce([{ type: JobType.Publish, connectorAccountId: CONNECTOR_ACCOUNT_ID }] as never)
      .mockResolvedValueOnce([]);

    const summary = await service.quiesceConnection(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID, { drainPollIntervalMs: 1 });
    expect(jobService.systemCancelJob).toHaveBeenCalledTimes(2);
    expect(summary.cancelledJobs).toBe(2);
  });

  it('does not cancel jobs that belong to a different connection', async () => {
    const otherJob = {
      id: 'job_x',
      bullJobId: 'bull_x',
      data: { type: JobType.Publish, connectorAccountId: 'ca_other' },
    };
    jobService.getNonTerminalJobsForWorkbook.mockResolvedValue([otherJob] as never);
    migrationLock.resolveConnectorAccountIdsForJob.mockResolvedValue(['ca_other']);

    const summary = await service.quiesceConnection(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID);
    expect(jobService.systemCancelJob).not.toHaveBeenCalled();
    expect(summary.cancelledJobs).toBe(0);
  });

  it('throws ConnectionDrainTimeoutError when the active set never clears', async () => {
    jobService.getActiveBullJobDatas.mockResolvedValue([
      { type: JobType.Publish, connectorAccountId: CONNECTOR_ACCOUNT_ID },
    ] as never);

    await expect(
      service.quiesceConnection(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID, { drainTimeoutMs: 0, drainPollIntervalMs: 1 }),
    ).rejects.toBeInstanceOf(ConnectionDrainTimeoutError);
  });

  it('releases in order: restore schedules → unlock → emit workbook event', async () => {
    await service.unquiesceConnection(WORKBOOK_ID, CONNECTOR_ACCOUNT_ID);
    expect(order).toEqual(['restoreSchedules', 'unlock']);
    expect(workbookEventService.sendWorkbookEvent).toHaveBeenCalledWith(
      WORKBOOK_ID,
      expect.objectContaining({ type: 'workbook-updated' }),
    );
  });
});
