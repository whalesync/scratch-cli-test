/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Schedule } from '@prisma/client';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
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

  beforeEach(() => {
    // Silence logger during tests
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'debug').mockImplementation();
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
      enqueuePublishDataFolderJob: jest.fn(),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    dbService = {
      client: {
        dbJob: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null) },
        user: { findFirst: jest.fn() },
      },
    } as unknown as jest.Mocked<DbService>;

    service = new SchedulerService(scheduleService, bullEnqueuerService, dbService);
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
});
