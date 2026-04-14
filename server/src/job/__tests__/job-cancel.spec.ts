/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { WorkbookId, WorkspacePermissionId } from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { Actor } from 'src/users/types';
import { JobService } from '../job.service';

// ── BullMQ mock ─────────────────────────────────────────────────────
const mockGetJob = jest.fn();
const mockQueueClose = jest.fn();
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    getJob: mockGetJob,
    close: mockQueueClose,
  })),
}));

// ── Redis mock ──────────────────────────────────────────────────────
const mockPublish = jest.fn().mockResolvedValue(1);
jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    publish: mockPublish,
  })),
);

// ── Helpers ─────────────────────────────────────────────────────────

const ACTOR: Actor = {
  userId: 'usr_1',
  organizationId: 'org_1',
  workspacePermissions: [{ id: 'wp_1' as WorkspacePermissionId, workbookId: 'wkb_1' as WorkbookId, role: 'editor' }],
};
const BULL_JOB_ID = 'publish-run-usr_1-wkb_1-abc';

function makeDbJob(overrides?: Record<string, unknown>) {
  return {
    id: 'job_1',
    bullJobId: BULL_JOB_ID,
    userId: 'usr_1',
    workbookId: 'wkb_1',
    status: 'active',
    type: 'publish-run',
    cancelRequestedAt: null,
    ...overrides,
  };
}

function makeBullJob(stateOverride: string = 'active') {
  return {
    id: BULL_JOB_ID,
    getState: jest.fn().mockResolvedValue(stateOverride),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('JobService.cancelJob', () => {
  let service: JobService;
  let mockFindFirst: jest.Mock;
  let mockUpdate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockFindFirst = jest.fn();
    mockUpdate = jest.fn();

    const db = {
      client: {
        dbJob: { findFirst: mockFindFirst, update: mockUpdate },
      },
    } as unknown as DbService;

    const config = {
      getRedisHost: () => 'localhost',
      getRedisPort: () => 6379,
      getRedisPassword: () => undefined,
    } as unknown as ScratchConfigService;

    service = new JobService(db, config);
  });

  it('throws NotFoundException when dbJob does not exist', async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(service.cancelJob(BULL_JOB_ID, ACTOR)).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when actor lacks workspace permission', async () => {
    const actorWithoutAccess: Actor = { userId: 'usr_2', organizationId: 'org_1' };
    mockFindFirst.mockResolvedValue(makeDbJob());

    await expect(service.cancelJob(BULL_JOB_ID, actorWithoutAccess)).rejects.toThrow(ForbiddenException);
  });

  it('returns success=false when DB status is already terminal', async () => {
    for (const status of ['completed', 'failed', 'canceled']) {
      mockFindFirst.mockResolvedValue(makeDbJob({ status }));

      const result = await service.cancelJob(BULL_JOB_ID, ACTOR);

      expect(result.success).toBe(false);
      expect(result.message).toContain(status);
    }
  });

  it('immediately marks job as canceled in DB before checking BullMQ', async () => {
    mockFindFirst.mockResolvedValue(makeDbJob());
    mockUpdate.mockResolvedValue(makeDbJob());
    mockGetJob.mockResolvedValue(makeBullJob());

    await service.cancelJob(BULL_JOB_ID, ACTOR);

    // First update should set status to canceled along with cancelRequestedAt
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_1' },
        data: expect.objectContaining({
          status: 'canceled',
          cancelRequestedAt: expect.any(Date),
          finishedOn: expect.any(Date),
        }),
      }),
    );
  });

  it('marks zombie job as canceled when BullMQ job is missing', async () => {
    mockFindFirst.mockResolvedValue(makeDbJob());
    mockUpdate.mockResolvedValue(makeDbJob());
    mockGetJob.mockResolvedValue(null);

    const result = await service.cancelJob(BULL_JOB_ID, ACTOR);

    expect(result.success).toBe(true);
    expect(result.message).toContain('canceled');

    // The immediate update already set canceled status — no separate zombie update needed
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'canceled', finishedOn: expect.any(Date) }),
      }),
    );
  });

  it('syncs DB status when BullMQ says job is already completed', async () => {
    mockFindFirst.mockResolvedValue(makeDbJob());
    mockUpdate.mockResolvedValue(makeDbJob());
    mockGetJob.mockResolvedValue(makeBullJob('completed'));

    const result = await service.cancelJob(BULL_JOB_ID, ACTOR);

    expect(result.success).toBe(false);
    expect(result.message).toContain('already completed');

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  it('publishes Redis cancellation signal for active jobs', async () => {
    mockFindFirst.mockResolvedValue(makeDbJob());
    mockUpdate.mockResolvedValue(makeDbJob());
    mockGetJob.mockResolvedValue(makeBullJob('active'));

    const result = await service.cancelJob(BULL_JOB_ID, ACTOR);

    expect(result.success).toBe(true);
    expect(mockPublish).toHaveBeenCalledWith(`job-cancel:${BULL_JOB_ID}`, expect.stringContaining(BULL_JOB_ID));
  });
});

describe('JobService.updateJobStatus', () => {
  let service: JobService;
  let mockUpdateMany: jest.Mock;
  let mockFindUniqueOrThrow: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockUpdateMany = jest.fn();
    mockFindUniqueOrThrow = jest.fn();

    const db = {
      client: {
        dbJob: { updateMany: mockUpdateMany, findUniqueOrThrow: mockFindUniqueOrThrow },
      },
    } as unknown as DbService;

    const config = {
      getRedisHost: () => 'localhost',
      getRedisPort: () => 6379,
      getRedisPassword: () => undefined,
    } as unknown as ScratchConfigService;

    service = new JobService(db, config);
  });

  it('does not overwrite canceled status with completed', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockFindUniqueOrThrow.mockResolvedValue(makeDbJob({ status: 'canceled' }));

    const result = await service.updateJobStatus({ id: 'job_1', status: 'completed', finishedOn: new Date() });

    expect(result.status).toBe('canceled');
    // updateMany should have been called with the guard
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_1', status: { not: 'canceled' } },
      }),
    );
  });

  it('updates status normally when not canceled', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockFindUniqueOrThrow.mockResolvedValue(makeDbJob({ status: 'completed' }));

    const result = await service.updateJobStatus({ id: 'job_1', status: 'completed', finishedOn: new Date() });

    expect(result.status).toBe('completed');
  });
});

describe('JobService.updateJobProgressAndCheckCancel', () => {
  let service: JobService;
  let mockUpdate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockUpdate = jest.fn();

    const db = {
      client: {
        dbJob: { update: mockUpdate },
      },
    } as unknown as DbService;

    const config = {
      getRedisHost: () => 'localhost',
      getRedisPort: () => 6379,
      getRedisPassword: () => undefined,
    } as unknown as ScratchConfigService;

    service = new JobService(db, config);
  });

  it('returns false when cancelRequestedAt is null', async () => {
    mockUpdate.mockResolvedValue({ cancelRequestedAt: null });

    const result = await service.updateJobProgressAndCheckCancel('job_1', { timestamp: Date.now() });

    expect(result).toBe(false);
  });

  it('returns true when cancelRequestedAt is set', async () => {
    mockUpdate.mockResolvedValue({ cancelRequestedAt: new Date() });

    const result = await service.updateJobProgressAndCheckCancel('job_1', { timestamp: Date.now() });

    expect(result).toBe(true);
  });

  it('writes progress in the same call', async () => {
    const progress = { timestamp: Date.now(), publicProgress: { status: 'running' } };
    mockUpdate.mockResolvedValue({ cancelRequestedAt: null });

    await service.updateJobProgressAndCheckCancel('job_1', progress);

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'job_1' },
      data: { progress },
      select: { cancelRequestedAt: true },
    });
  });
});
