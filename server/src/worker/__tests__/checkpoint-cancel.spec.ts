/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { JobService } from 'src/job/job.service';
import { Progress } from 'src/types/progress';
import { JobCanceledError } from '../job-errors';

/**
 * Tests for the checkpoint cancellation flow.
 *
 * The real checkpoint function lives inside QueueService.processJob, which is tightly coupled
 * to BullMQ Worker + Redis. Rather than spinning up infrastructure, we extract the checkpoint
 * logic and test it in isolation: given an AbortController and a mock JobService, verify that
 * checkpoint correctly throws JobCanceledError when DB-based cancellation is detected.
 */

/**
 * Replicates the checkpoint closure from bull-worker.service.ts.
 */
function createCheckpoint(params: {
  jobService: Pick<JobService, 'updateJobProgressAndCheckCancel'>;
  dbJobId: string;
  jobId: string;
  abortController: AbortController;
  bullJobUpdateProgress: (p: Progress) => Promise<void>;
}) {
  const { jobService, dbJobId, jobId, abortController, bullJobUpdateProgress } = params;
  let latestProgress: Progress = {} as Progress;

  const checkpoint = async (progress: Omit<Progress, 'timestamp'>) => {
    if (progress) {
      const newProgress = { ...progress, timestamp: Date.now() } as Progress;
      latestProgress = newProgress;
      await bullJobUpdateProgress(newProgress);
      const cancelRequested = await jobService.updateJobProgressAndCheckCancel(dbJobId, newProgress);
      if (cancelRequested) {
        abortController.abort();
      }
    }
    if (abortController.signal.aborted) {
      throw new JobCanceledError(jobId);
    }
  };

  return { checkpoint, getLatestProgress: () => latestProgress };
}

const RUNNING_PROGRESS: Omit<Progress, 'timestamp'> = {
  publicProgress: { status: 'running' },
  jobProgress: {},
  connectorProgress: {},
};

describe('checkpoint cancellation via DB flag', () => {
  const DB_JOB_ID = 'job_1';
  const JOB_ID = 'publish-run-usr_1-wkb_1-abc';

  let abortController: AbortController;
  let mockUpdateProgressAndCheckCancel: jest.Mock;
  let mockBullJobUpdateProgress: jest.Mock;
  let checkpoint: (progress: Omit<Progress, 'timestamp'>) => Promise<void>;

  beforeEach(() => {
    abortController = new AbortController();
    mockUpdateProgressAndCheckCancel = jest.fn().mockResolvedValue(false);
    mockBullJobUpdateProgress = jest.fn().mockResolvedValue(undefined);

    const result = createCheckpoint({
      jobService: { updateJobProgressAndCheckCancel: mockUpdateProgressAndCheckCancel },
      dbJobId: DB_JOB_ID,
      jobId: JOB_ID,
      abortController,
      bullJobUpdateProgress: mockBullJobUpdateProgress,
    });
    checkpoint = result.checkpoint;
  });

  it('does not throw when cancelRequestedAt is null', async () => {
    mockUpdateProgressAndCheckCancel.mockResolvedValue(false);

    await expect(checkpoint(RUNNING_PROGRESS)).resolves.toBeUndefined();
  });

  it('throws JobCanceledError when DB returns cancelRequested=true', async () => {
    mockUpdateProgressAndCheckCancel.mockResolvedValue(true);

    await expect(checkpoint(RUNNING_PROGRESS)).rejects.toThrow(JobCanceledError);
  });

  it('sets the AbortController signal when DB cancellation is detected', async () => {
    mockUpdateProgressAndCheckCancel.mockResolvedValue(true);

    try {
      await checkpoint(RUNNING_PROGRESS);
    } catch {
      // expected
    }

    expect(abortController.signal.aborted).toBe(true);
  });

  it('throws JobCanceledError when abortController was already aborted (pub/sub fast path)', async () => {
    // Simulate pub/sub cancellation arriving before checkpoint
    abortController.abort();
    mockUpdateProgressAndCheckCancel.mockResolvedValue(false); // DB hasn't caught up yet

    await expect(checkpoint(RUNNING_PROGRESS)).rejects.toThrow(JobCanceledError);
  });

  it('writes progress to both BullMQ and DB', async () => {
    mockUpdateProgressAndCheckCancel.mockResolvedValue(false);

    await checkpoint(RUNNING_PROGRESS);

    expect(mockBullJobUpdateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ publicProgress: { status: 'running' }, timestamp: expect.any(Number) }),
    );
    expect(mockUpdateProgressAndCheckCancel).toHaveBeenCalledWith(
      DB_JOB_ID,
      expect.objectContaining({ publicProgress: { status: 'running' }, timestamp: expect.any(Number) }),
    );
  });
});
