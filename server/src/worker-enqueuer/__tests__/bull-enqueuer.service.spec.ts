/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { WSLogger } from 'src/logger';
import { BullEnqueuerService } from '../bull-enqueuer.service';

describe('BullEnqueuerService', () => {
  let service: BullEnqueuerService;
  let mockJobService: any;
  let mockQueue: any;

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'error').mockImplementation();

    mockJobService = {
      createJob: jest.fn().mockResolvedValue({ id: 'job_db-1' }),
      updateJobStatus: jest.fn().mockResolvedValue({}),
    };

    const mockConfigService = {
      getUseJobs: jest.fn().mockReturnValue(true),
      getRedisHost: jest.fn().mockReturnValue('localhost'),
      getRedisPort: jest.fn().mockReturnValue(6379),
      getRedisPassword: jest.fn().mockReturnValue(''),
    };

    service = new BullEnqueuerService(mockConfigService as any, mockJobService);

    // Replace the internal queue with a mock
    mockQueue = { add: jest.fn(), close: jest.fn(), getJob: jest.fn() };
    (service as any).queue = mockQueue;
  });

  afterEach(() => jest.restoreAllMocks());

  it('marks DbJob as failed when queue.add() throws', async () => {
    mockQueue.add.mockRejectedValue(new Error('Redis connection refused'));

    await expect(
      service.enqueueSyncDataFoldersJob(
        'wb_test' as any,
        'sync_test' as any,
        { userId: 'usr_1', organizationId: 'org_1' },
        undefined,
        { runId: 'run_1', source: 'scheduler' } as any,
      ),
    ).rejects.toThrow('Redis connection refused');

    expect(mockJobService.createJob).toHaveBeenCalled();
    expect(mockJobService.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'job_db-1',
        status: 'failed',
        error: expect.stringContaining('Redis connection refused'),
      }),
    );
  });

  it('does not mark DbJob as failed when queue.add() succeeds', async () => {
    mockQueue.add.mockResolvedValue({ id: 'bull-job-1' });

    const result = await service.enqueueSyncDataFoldersJob(
      'wb_test' as any,
      'sync_test' as any,
      { userId: 'usr_1', organizationId: 'org_1' },
      undefined,
      { runId: 'run_1', source: 'scheduler' } as any,
    );

    expect(result).toEqual({ id: 'bull-job-1' });
    expect(mockJobService.updateJobStatus).not.toHaveBeenCalled();
  });
});
