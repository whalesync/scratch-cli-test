import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { RoutineExecutorService } from 'src/routine/routine-executor.service';
import { RoutineRunReaperService } from '../routine-run-reaper.service';

const RUN_ID = 'rrn_stuck1234';

function makeReaper(deps: {
  stuckRuns: Array<{ id: string; currentStepIndex: number; status: string }>;
  step: { id: string; stepIndex: number; jobId: string | null } | null;
  dbJob: { status: string; finishedOn: Date | null } | null;
  claimCount?: number;
}) {
  const routineRunUpdateMany = jest.fn().mockResolvedValue({ count: deps.claimCount ?? 1 });
  const db = {
    client: {
      routineRun: {
        findMany: jest.fn().mockResolvedValue(deps.stuckRuns),
        updateMany: routineRunUpdateMany,
      },
      routineRunStep: {
        findFirst: jest.fn().mockResolvedValue(deps.step),
      },
    },
  } as unknown as DbService;

  const jobService = {
    getJobByBullJobId: jest.fn().mockResolvedValue(deps.dbJob),
  } as unknown as JobService;

  const execute = jest.fn().mockResolvedValue(undefined);
  const routineExecutorService = { execute } as unknown as RoutineExecutorService;

  const metricsService = { logValue: jest.fn() };

  const service = new RoutineRunReaperService(
    db,
    jobService,
    routineExecutorService,
    metricsService as unknown as CustomMetricsService,
  );
  return { service, execute, routineRunUpdateMany, metricsService };
}

describe('RoutineRunReaperService', () => {
  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'warn').mockImplementation();
    jest.spyOn(WSLogger, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('resumes a stuck run whose current step job is already terminal', async () => {
    const { service, execute } = makeReaper({
      stuckRuns: [{ id: RUN_ID, currentStepIndex: 1, status: 'running' }],
      step: { id: 'rrs_1', stepIndex: 1, jobId: 'job_1' },
      // Finished well in the past (before the stale cutoff), so a live driver would have advanced.
      dbJob: { status: 'completed', finishedOn: new Date('2000-01-01') },
    });

    await service.reapStuckRoutineRuns();

    expect(execute).toHaveBeenCalledWith(RUN_ID);
  });

  it('does NOT reap a run whose current step job is still active (a worker owns it)', async () => {
    const { service, execute } = makeReaper({
      stuckRuns: [{ id: RUN_ID, currentStepIndex: 0, status: 'running' }],
      step: { id: 'rrs_0', stepIndex: 0, jobId: 'job_0' },
      dbJob: { status: 'active', finishedOn: null },
    });

    await service.reapStuckRoutineRuns();

    expect(execute).not.toHaveBeenCalled();
  });

  it('resumes when the current step has no job yet (driver died before enqueue)', async () => {
    const { service, execute } = makeReaper({
      stuckRuns: [{ id: RUN_ID, currentStepIndex: 0, status: 'running' }],
      step: { id: 'rrs_0', stepIndex: 0, jobId: null },
      dbJob: null,
    });

    await service.reapStuckRoutineRuns();

    expect(execute).toHaveBeenCalledWith(RUN_ID);
  });

  it('resumes a stale pending run that was never claimed, and counts it', async () => {
    // A run created but never claimed (instance died between create and claimRun) sits at step 0 with
    // its steps already created (jobId null). It occupies the same partial index that blocks retriggers.
    const { service, execute, metricsService } = makeReaper({
      stuckRuns: [{ id: RUN_ID, currentStepIndex: 0, status: 'pending' }],
      step: { id: 'rrs_0', stepIndex: 0, jobId: null },
      dbJob: null,
    });

    await service.reapStuckRoutineRuns();

    expect(execute).toHaveBeenCalledWith(RUN_ID);
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.ROUTINE_RUN_REAPED, 1);
  });

  it('does not drive when the atomic re-claim is lost to another reaper/driver', async () => {
    const { service, execute } = makeReaper({
      stuckRuns: [{ id: RUN_ID, currentStepIndex: 1, status: 'running' }],
      step: { id: 'rrs_1', stepIndex: 1, jobId: 'job_1' },
      dbJob: { status: 'completed', finishedOn: new Date('2000-01-01') },
      claimCount: 0, // re-claim updateMany matched nothing — someone else won
    });

    await service.reapStuckRoutineRuns();

    expect(execute).not.toHaveBeenCalled();
  });

  it('does nothing when there are no stuck runs', async () => {
    const { service, execute, routineRunUpdateMany } = makeReaper({
      stuckRuns: [],
      step: null,
      dbJob: null,
    });

    await service.reapStuckRoutineRuns();

    expect(execute).not.toHaveBeenCalled();
    expect(routineRunUpdateMany).not.toHaveBeenCalled();
  });
});
