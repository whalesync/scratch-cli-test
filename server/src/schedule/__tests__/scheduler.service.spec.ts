/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Schedule } from '@prisma/client';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { ScheduleService } from '../schedule.service';
import { SchedulerService } from '../scheduler.service';

// ---------------------------------------------------------------------------
// Helpers & constants
// ---------------------------------------------------------------------------

const WORKBOOK_ID = 'wb_test-workbook';
const SCHEDULE_ID = 'sch_test-schedule';
const ENTITY_ID = 'sync_test-entity';
const ORG_ID = 'org_test-org';
const USER_ID = 'usr_test-user';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    workbookId: WORKBOOK_ID,
    organizationId: ORG_ID,
    userId: USER_ID,
    name: 'Test Schedule',
    action: 'SYNC',
    entityId: ENTITY_ID,
    cronExpression: '0 * * * *',
    enabled: true,
    disabledForMigrationAt: null,
    nextRunAt: new Date('2025-01-01T00:00:00Z'),
    lastTriggeredAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SchedulerService', () => {
  let service: SchedulerService;
  let scheduleService: jest.Mocked<ScheduleService>;
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;
  let dbService: jest.Mocked<DbService>;
  let dataFolderService: jest.Mocked<DataFolderService>;
  let publishPlanBuildService: jest.Mocked<PublishPlanBuildService>;

  beforeEach(() => {
    // Silence logger during tests
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'debug').mockImplementation();
    jest.spyOn(WSLogger, 'warn').mockImplementation();
    jest.spyOn(WSLogger, 'error').mockImplementation();

    scheduleService = {
      findDueSchedules: jest.fn(),
      computeNextRunAt: jest.fn().mockReturnValue(new Date('2025-01-01T01:00:00Z')),
      atomicClaim: jest.fn(),
      entityExists: jest.fn(),
      disableSchedule: jest.fn(),
    } as unknown as jest.Mocked<ScheduleService>;

    bullEnqueuerService = {
      enqueueSyncDataFoldersJob: jest.fn(),
      enqueuePullLinkedFolderFilesJob: jest.fn(),
      enqueuePlanPipelineJob: jest.fn().mockResolvedValue({ id: 'job_publish_1' }),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    dbService = {
      client: {
        dbJob: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null) },
        user: { findFirst: jest.fn() },
        // Default the workbook lookup to "not pending deletion" so the scheduler
        // proceeds to the existing busy/claim logic.
        workbook: { findUnique: jest.fn().mockResolvedValue({ isPendingDelete: false }) },
        // Used by connection-wide pull schedules to fan out to the connection's tables.
        dataFolder: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as jest.Mocked<DbService>;

    dataFolderService = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<DataFolderService>;

    publishPlanBuildService = {
      createPipeline: jest.fn().mockResolvedValue({ pipelineId: 'plan_1', branchName: 'publish/u/p1' }),
      setActiveJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PublishPlanBuildService>;

    service = new SchedulerService(
      scheduleService,
      bullEnqueuerService,
      dbService,
      dataFolderService,
      publishPlanBuildService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('disables schedule and skips job when entity no longer exists', async () => {
    const schedule = makeSchedule();
    scheduleService.findDueSchedules.mockResolvedValue([schedule]);
    scheduleService.atomicClaim.mockResolvedValue(schedule);
    scheduleService.entityExists.mockResolvedValue(false);

    await service.evaluateSchedules();

    expect(scheduleService.entityExists).toHaveBeenCalledWith(WORKBOOK_ID, 'SYNC', ENTITY_ID);
    expect(scheduleService.disableSchedule).toHaveBeenCalledWith(SCHEDULE_ID);
    expect(WSLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('no longer exists. Disabling schedule') }),
    );
    expect(bullEnqueuerService.enqueueSyncDataFoldersJob).not.toHaveBeenCalled();
  });

  it('enqueues job when entity exists', async () => {
    const schedule = makeSchedule();
    scheduleService.findDueSchedules.mockResolvedValue([schedule]);
    scheduleService.atomicClaim.mockResolvedValue(schedule);
    scheduleService.entityExists.mockResolvedValue(true);

    await service.evaluateSchedules();

    expect(scheduleService.entityExists).toHaveBeenCalledWith(WORKBOOK_ID, 'SYNC', ENTITY_ID);
    expect(scheduleService.disableSchedule).not.toHaveBeenCalled();
    expect(bullEnqueuerService.enqueueSyncDataFoldersJob).toHaveBeenCalled();
  });

  it('does not check entity existence if claim fails', async () => {
    const schedule = makeSchedule();
    scheduleService.findDueSchedules.mockResolvedValue([schedule]);
    scheduleService.atomicClaim.mockResolvedValue(null);

    await service.evaluateSchedules();

    expect(scheduleService.entityExists).not.toHaveBeenCalled();
    expect(bullEnqueuerService.enqueueSyncDataFoldersJob).not.toHaveBeenCalled();
  });

  it('skips workbook when a created job exists (busy check)', async () => {
    const schedule = makeSchedule();
    scheduleService.findDueSchedules.mockResolvedValue([schedule]);

    // Simulate a zombie "created" job blocking the workbook
    (dbService.client.dbJob.count as jest.Mock).mockResolvedValue(1);

    await service.evaluateSchedules();

    expect(scheduleService.atomicClaim).not.toHaveBeenCalled();
    expect(bullEnqueuerService.enqueueSyncDataFoldersJob).not.toHaveBeenCalled();
  });

  it('skips workbook flagged for pending deletion (no busy check, no claim)', async () => {
    const schedule = makeSchedule();
    scheduleService.findDueSchedules.mockResolvedValue([schedule]);
    (dbService.client.workbook.findUnique as jest.Mock).mockResolvedValue({ isPendingDelete: true });

    await service.evaluateSchedules();

    expect(dbService.client.dbJob.count).not.toHaveBeenCalled();
    expect(scheduleService.atomicClaim).not.toHaveBeenCalled();
    expect(bullEnqueuerService.enqueueSyncDataFoldersJob).not.toHaveBeenCalled();
  });

  describe('PUBLISH action', () => {
    const FOLDER_PATH = '/BLOG - Blog Posts';
    const CONNECTOR_ACCOUNT_ID = 'ca_test-1';
    const publishSchedule = makeSchedule({ action: 'PUBLISH', entityId: 'df_test-folder' });

    it('creates a publish-v2 pipeline and enqueues a plan+run job', async () => {
      scheduleService.findDueSchedules.mockResolvedValue([publishSchedule]);
      scheduleService.atomicClaim.mockResolvedValue(publishSchedule);
      scheduleService.entityExists.mockResolvedValue(true);
      (dataFolderService.findOne as jest.Mock).mockResolvedValue({
        id: 'df_test-folder',
        path: FOLDER_PATH,
        connectorAccountId: CONNECTOR_ACCOUNT_ID,
      });

      await service.evaluateSchedules();

      expect(publishPlanBuildService.createPipeline).toHaveBeenCalledWith(WORKBOOK_ID, USER_ID, CONNECTOR_ACCOUNT_ID);
      expect(bullEnqueuerService.enqueuePlanPipelineJob).toHaveBeenCalledWith(
        WORKBOOK_ID,
        expect.objectContaining({ userId: USER_ID, organizationId: ORG_ID }),
        'plan_1',
        CONNECTOR_ACCOUNT_ID,
        true,
        FOLDER_PATH,
        undefined,
        undefined,
        expect.objectContaining({ trigger: 'scheduler' }),
      );
      expect(publishPlanBuildService.setActiveJob).toHaveBeenCalledWith('plan_1', 'job_publish_1');
    });

    it('skips when the data folder is missing path or connectorAccountId', async () => {
      scheduleService.findDueSchedules.mockResolvedValue([publishSchedule]);
      scheduleService.atomicClaim.mockResolvedValue(publishSchedule);
      scheduleService.entityExists.mockResolvedValue(true);
      (dataFolderService.findOne as jest.Mock).mockResolvedValue({
        id: 'df_test-folder',
        path: null,
        connectorAccountId: null,
      });

      await service.evaluateSchedules();

      expect(publishPlanBuildService.createPipeline).not.toHaveBeenCalled();
      expect(bullEnqueuerService.enqueuePlanPipelineJob).not.toHaveBeenCalled();
      expect(WSLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('missing path or connectorAccountId') }),
      );
    });
  });

  describe('CONNECTION pull actions', () => {
    const CONNECTOR_ACCOUNT_ID = 'ca_test-conn';
    const CONNECTION_FOLDER_IDS = ['dfd_table-a', 'dfd_table-b'];

    function mockConnectionFolders(ids: string[]): void {
      (dbService.client.dataFolder.findMany as jest.Mock).mockResolvedValue(ids.map((id) => ({ id })));
    }

    it('fans out a CONNECTION_FULL_PULL to every linked table with mode "full"', async () => {
      const schedule = makeSchedule({ action: 'CONNECTION_FULL_PULL', entityId: CONNECTOR_ACCOUNT_ID });
      scheduleService.findDueSchedules.mockResolvedValue([schedule]);
      scheduleService.atomicClaim.mockResolvedValue(schedule);
      scheduleService.entityExists.mockResolvedValue(true);
      mockConnectionFolders(CONNECTION_FOLDER_IDS);

      await service.evaluateSchedules();

      expect(dbService.client.dataFolder.findMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, connectorAccountId: CONNECTOR_ACCOUNT_ID },
        select: { id: true },
      });
      expect(bullEnqueuerService.enqueuePullLinkedFolderFilesJob).toHaveBeenCalledWith(
        WORKBOOK_ID,
        expect.objectContaining({ userId: USER_ID, organizationId: ORG_ID }),
        CONNECTION_FOLDER_IDS,
        undefined,
        expect.objectContaining({ trigger: 'scheduler' }),
        'full',
      );
    });

    it('fans out a CONNECTION_INCREMENTAL_PULL to every linked table with mode "incremental"', async () => {
      const schedule = makeSchedule({ action: 'CONNECTION_INCREMENTAL_PULL', entityId: CONNECTOR_ACCOUNT_ID });
      scheduleService.findDueSchedules.mockResolvedValue([schedule]);
      scheduleService.atomicClaim.mockResolvedValue(schedule);
      scheduleService.entityExists.mockResolvedValue(true);
      mockConnectionFolders(CONNECTION_FOLDER_IDS);

      await service.evaluateSchedules();

      expect(bullEnqueuerService.enqueuePullLinkedFolderFilesJob).toHaveBeenCalledWith(
        WORKBOOK_ID,
        expect.anything(),
        CONNECTION_FOLDER_IDS,
        undefined,
        expect.objectContaining({ trigger: 'scheduler' }),
        'incremental',
      );
    });

    it('skips (logs) a connection pull schedule with no linked tables', async () => {
      const schedule = makeSchedule({ action: 'CONNECTION_FULL_PULL', entityId: CONNECTOR_ACCOUNT_ID });
      scheduleService.findDueSchedules.mockResolvedValue([schedule]);
      scheduleService.atomicClaim.mockResolvedValue(schedule);
      scheduleService.entityExists.mockResolvedValue(true);
      mockConnectionFolders([]);

      await service.evaluateSchedules();

      expect(bullEnqueuerService.enqueuePullLinkedFolderFilesJob).not.toHaveBeenCalled();
      expect(WSLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('has no linked tables') }),
      );
    });

    it('does not per-entity debounce connection pull schedules (no dbJob.findFirst lookup)', async () => {
      const schedule = makeSchedule({ action: 'CONNECTION_FULL_PULL', entityId: CONNECTOR_ACCOUNT_ID });
      scheduleService.findDueSchedules.mockResolvedValue([schedule]);
      scheduleService.atomicClaim.mockResolvedValue(schedule);
      scheduleService.entityExists.mockResolvedValue(true);
      mockConnectionFolders(CONNECTION_FOLDER_IDS);
      // Even with a recent job present, the connection schedule still fires because
      // the per-entity debounce is intentionally skipped for connection actions.
      (dbService.client.dbJob.findFirst as jest.Mock).mockResolvedValue({ id: 'job_recent' });

      await service.evaluateSchedules();

      expect(dbService.client.dbJob.findFirst).not.toHaveBeenCalled();
      expect(bullEnqueuerService.enqueuePullLinkedFolderFilesJob).toHaveBeenCalled();
    });
  });
});
