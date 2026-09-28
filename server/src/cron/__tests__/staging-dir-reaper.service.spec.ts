import { GitStagingDir } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { StagingDirReaperService } from '../staging-dir-reaper.service';

const HOUR_MS = 60 * 60 * 1000;
// Comfortably older than the service's 72h cutoff (which it recomputes as Date.now() - 72h).
const OLD_MTIME_MS = Date.now() - 73 * HOUR_MS;
// Well under 72h old.
const FRESH_MTIME_MS = Date.now();
// Older than the 24h run store cutoff but younger than the 72h pull/sync one.
const RUN_STORE_OLD_MTIME_MS = Date.now() - 25 * HOUR_MS;

interface NonTerminalJobFixture {
  id: string;
  syncId: string | null;
}

function makeService(deps: {
  stagingDirs: GitStagingDir[];
  nonTerminalJobs: NonTerminalJobFixture[];
  runStoreMaxBytes?: number;
  routineRuns?: { id: string; status: string }[];
}) {
  const listStaging = jest.fn().mockResolvedValue({
    stagingDirs: deps.stagingDirs,
    ...(deps.runStoreMaxBytes !== undefined && { runStoreMaxBytes: deps.runStoreMaxBytes }),
  });
  const cleanupStaging = jest.fn().mockResolvedValue(undefined);
  const scratchGitService = { listStaging, cleanupStaging } as unknown as ScratchGitService;

  const dbJobFindMany = jest.fn().mockResolvedValue(deps.nonTerminalJobs);
  const routineRunFindMany = jest.fn().mockImplementation((args: { where: { id: { in: string[] } } }) => {
    const requestedIds = new Set(args.where.id.in);
    return Promise.resolve((deps.routineRuns ?? []).filter((run) => requestedIds.has(run.id)));
  });
  const db = {
    client: {
      dbJob: { findMany: dbJobFindMany },
      routineRun: { findMany: routineRunFindMany },
    },
  } as unknown as DbService;

  const metricsService = { logValue: jest.fn() };

  const service = new StagingDirReaperService(db, scratchGitService, metricsService as unknown as CustomMetricsService);
  return { service, listStaging, cleanupStaging, metricsService, routineRunFindMany };
}

describe('StagingDirReaperService', () => {
  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'warn').mockImplementation();
    jest.spyOn(WSLogger, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('reaps an old staging dir with no live job and counts it', async () => {
    const { service, cleanupStaging, metricsService } = makeService({
      stagingDirs: [{ jobId: 'job_dead', mtimeMs: OLD_MTIME_MS, sizeBytes: 4_700_000 }],
      nonTerminalJobs: [],
    });

    await service.reapStagingDirs();

    expect(cleanupStaging).toHaveBeenCalledTimes(1);
    expect(cleanupStaging).toHaveBeenCalledWith('job_dead');
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.STAGING_DIR_REAPED, 1);
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 4_700_000);
  });

  it('leaves a fresh dir alone (age gate)', async () => {
    const { service, cleanupStaging, metricsService } = makeService({
      stagingDirs: [{ jobId: 'job_fresh', mtimeMs: FRESH_MTIME_MS, sizeBytes: 1_000 }],
      nonTerminalJobs: [],
    });

    await service.reapStagingDirs();

    expect(cleanupStaging).not.toHaveBeenCalled();
    expect(metricsService.logValue).not.toHaveBeenCalledWith(CustomMetric.STAGING_DIR_REAPED, 1);
    // No orphan bytes when the only dir is fresh.
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 0);
  });

  it('leaves an old pull dir alone while its DbJob is still live', async () => {
    // A pull staging dir is named exactly after its DbJob id.
    const { service, cleanupStaging, metricsService } = makeService({
      stagingDirs: [{ jobId: 'job_live_pull', mtimeMs: OLD_MTIME_MS, sizeBytes: 9_999 }],
      nonTerminalJobs: [{ id: 'job_live_pull', syncId: null }],
    });

    await service.reapStagingDirs();

    expect(cleanupStaging).not.toHaveBeenCalled();
    expect(metricsService.logValue).not.toHaveBeenCalledWith(CustomMetric.STAGING_DIR_REAPED, 1);
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 0);
  });

  it('leaves an old sync dir alone while a sync job for it is still live', async () => {
    // A sync staging dir is named `sync-<syncId>-<folderId>-<rand>`.
    const { service, cleanupStaging, metricsService } = makeService({
      stagingDirs: [{ jobId: 'sync-syn_abc-fld_1-rand99', mtimeMs: OLD_MTIME_MS, sizeBytes: 160_000 }],
      nonTerminalJobs: [{ id: 'job_sync_driver', syncId: 'syn_abc' }],
    });

    await service.reapStagingDirs();

    expect(cleanupStaging).not.toHaveBeenCalled();
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 0);
  });

  it('reaps only the old dead dirs from a mix and sums their bytes into the orphan gauge', async () => {
    const { service, cleanupStaging, metricsService } = makeService({
      stagingDirs: [
        { jobId: 'job_dead_1', mtimeMs: OLD_MTIME_MS, sizeBytes: 100 },
        { jobId: 'job_dead_2', mtimeMs: OLD_MTIME_MS, sizeBytes: 200 },
        { jobId: 'job_live_pull', mtimeMs: OLD_MTIME_MS, sizeBytes: 4_000 },
        { jobId: 'job_fresh', mtimeMs: FRESH_MTIME_MS, sizeBytes: 8_000 },
      ],
      nonTerminalJobs: [{ id: 'job_live_pull', syncId: null }],
    });

    await service.reapStagingDirs();

    expect(cleanupStaging).toHaveBeenCalledTimes(2);
    expect(cleanupStaging).toHaveBeenCalledWith('job_dead_1');
    expect(cleanupStaging).toHaveBeenCalledWith('job_dead_2');
    expect(cleanupStaging).not.toHaveBeenCalledWith('job_live_pull');
    expect(cleanupStaging).not.toHaveBeenCalledWith('job_fresh');
    // Only the two reaped dirs contribute to the orphan-bytes gauge.
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 300);
  });

  it('is non-fatal: a cleanup failure does not stop the rest of the sweep', async () => {
    const { service, cleanupStaging, metricsService } = makeService({
      stagingDirs: [
        { jobId: 'job_boom', mtimeMs: OLD_MTIME_MS, sizeBytes: 500 },
        { jobId: 'job_ok', mtimeMs: OLD_MTIME_MS, sizeBytes: 700 },
      ],
      nonTerminalJobs: [],
    });
    cleanupStaging.mockRejectedValueOnce(new Error('boom'));
    const warnSpy = jest.spyOn(WSLogger, 'warn');

    await service.reapStagingDirs();

    expect(cleanupStaging).toHaveBeenCalledTimes(2);
    // Only the successful delete counts as a reap.
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.STAGING_DIR_REAPED, 1);
    expect(warnSpy).toHaveBeenCalled();
    // Both dirs were old + dead, so both count as observed orphan bytes even though one delete failed.
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 1_200);
  });

  // RoutineRun ids must have the real 14-character shape (`rrn_` + 10) — `isRoutineRunId` checks it.
  describe('Live Export run store dirs (le-<runId>)', () => {
    it('reaps a >24h run store whose RoutineRun (rrn_ key) is terminal, but not one whose run is still running', async () => {
      const { service, cleanupStaging } = makeService({
        stagingDirs: [
          { jobId: 'le-rrn_DoneDone01', mtimeMs: RUN_STORE_OLD_MTIME_MS, sizeBytes: 1_000 },
          { jobId: 'le-rrn_Running001', mtimeMs: RUN_STORE_OLD_MTIME_MS, sizeBytes: 2_000 },
        ],
        nonTerminalJobs: [],
        routineRuns: [
          { id: 'rrn_DoneDone01', status: 'completed' },
          { id: 'rrn_Running001', status: 'running' },
        ],
      });

      await service.reapStagingDirs();

      expect(cleanupStaging).toHaveBeenCalledTimes(1);
      expect(cleanupStaging).toHaveBeenCalledWith('le-rrn_DoneDone01');
    });

    it('treats an le- dir whose RoutineRun is missing, or whose suffix is not an rrn_ id, as dead', async () => {
      const { service, cleanupStaging, routineRunFindMany } = makeService({
        stagingDirs: [
          { jobId: 'le-rrn_GoneGone01', mtimeMs: RUN_STORE_OLD_MTIME_MS, sizeBytes: 100 },
          { jobId: 'le-run_notARoutineRun', mtimeMs: RUN_STORE_OLD_MTIME_MS, sizeBytes: 100 },
          { jobId: 'le-rrn_Running001', mtimeMs: RUN_STORE_OLD_MTIME_MS, sizeBytes: 100 },
        ],
        nonTerminalJobs: [],
        routineRuns: [{ id: 'rrn_Running001', status: 'running' }],
      });

      await service.reapStagingDirs();

      expect(cleanupStaging).toHaveBeenCalledTimes(2);
      expect(cleanupStaging).toHaveBeenCalledWith('le-rrn_GoneGone01');
      expect(cleanupStaging).toHaveBeenCalledWith('le-run_notARoutineRun');
      // Only rrn_ suffixes are looked up.
      expect(routineRunFindMany).toHaveBeenCalledWith({
        where: { id: { in: ['rrn_GoneGone01', 'rrn_Running001'] } },
        select: { id: true, status: true },
      });
    });

    it('never treats a live pull DbJob as keeping an le- dir alive', async () => {
      const { service, cleanupStaging } = makeService({
        stagingDirs: [{ jobId: 'le-rrn_DoneDone01', mtimeMs: RUN_STORE_OLD_MTIME_MS, sizeBytes: 100 }],
        nonTerminalJobs: [{ id: 'le-rrn_DoneDone01', syncId: null }],
        routineRuns: [{ id: 'rrn_DoneDone01', status: 'completed' }],
      });

      await service.reapStagingDirs();

      expect(cleanupStaging).toHaveBeenCalledWith('le-rrn_DoneDone01');
    });

    it('uses the 24h threshold for run stores while pull/sync dirs keep 72h', async () => {
      const { service, cleanupStaging } = makeService({
        stagingDirs: [
          { jobId: 'le-rrn_DoneDone01', mtimeMs: RUN_STORE_OLD_MTIME_MS, sizeBytes: 100 },
          { jobId: 'job_dead_25h', mtimeMs: RUN_STORE_OLD_MTIME_MS, sizeBytes: 100 },
          { jobId: 'le-rrn_DoneFresh1', mtimeMs: FRESH_MTIME_MS, sizeBytes: 100 },
        ],
        nonTerminalJobs: [],
        routineRuns: [
          { id: 'rrn_DoneDone01', status: 'completed' },
          { id: 'rrn_DoneFresh1', status: 'completed' },
        ],
      });

      await service.reapStagingDirs();

      expect(cleanupStaging).toHaveBeenCalledTimes(1);
      expect(cleanupStaging).toHaveBeenCalledWith('le-rrn_DoneDone01');
    });

    it('over budget: deletes the oldest dead run stores (any age) until back under, never a live one', async () => {
      const { service, cleanupStaging, metricsService } = makeService({
        runStoreMaxBytes: 1_000,
        stagingDirs: [
          { jobId: 'le-rrn_LiveOldest', mtimeMs: FRESH_MTIME_MS - 3_000, sizeBytes: 600 },
          { jobId: 'le-rrn_DeadOld001', mtimeMs: FRESH_MTIME_MS - 2_000, sizeBytes: 500 },
          { jobId: 'le-rrn_DeadNewer1', mtimeMs: FRESH_MTIME_MS - 1_000, sizeBytes: 400 },
          { jobId: 'le-rrn_DeadNewest', mtimeMs: FRESH_MTIME_MS, sizeBytes: 50 },
        ],
        nonTerminalJobs: [],
        routineRuns: [
          { id: 'rrn_LiveOldest', status: 'running' },
          { id: 'rrn_DeadOld001', status: 'completed' },
          { id: 'rrn_DeadNewer1', status: 'cancelled' },
          { id: 'rrn_DeadNewest', status: 'failed' },
        ],
      });
      const errorSpy = jest.spyOn(WSLogger, 'error');

      await service.reapStagingDirs();

      // 1,550 bytes → delete DeadOld (1,050) → delete DeadNewer (650 ≤ 1,000) → stop.
      expect(cleanupStaging.mock.calls.map((call: unknown[]) => call[0])).toEqual([
        'le-rrn_DeadOld001',
        'le-rrn_DeadNewer1',
      ]);
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_RUN_STORE_BYTES, 650);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('over budget with only live run stores left: deletes nothing live and logs an error', async () => {
      const { service, cleanupStaging, metricsService } = makeService({
        runStoreMaxBytes: 1_000,
        stagingDirs: [
          { jobId: 'le-rrn_LiveAAAAAA', mtimeMs: FRESH_MTIME_MS, sizeBytes: 800 },
          { jobId: 'le-rrn_LiveBBBBBB', mtimeMs: FRESH_MTIME_MS, sizeBytes: 800 },
        ],
        nonTerminalJobs: [],
        routineRuns: [
          { id: 'rrn_LiveAAAAAA', status: 'running' },
          { id: 'rrn_LiveBBBBBB', status: 'pending' },
        ],
      });
      const errorSpy = jest.spyOn(WSLogger, 'error');

      await service.reapStagingDirs();

      expect(cleanupStaging).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_RUN_STORE_BYTES, 1_600);
    });

    it('does not count pull/sync staging bytes against the run store budget', async () => {
      const { service, cleanupStaging, metricsService } = makeService({
        runStoreMaxBytes: 1_000,
        stagingDirs: [
          { jobId: 'job_live_pull', mtimeMs: FRESH_MTIME_MS, sizeBytes: 50_000 },
          { jobId: 'le-rrn_DoneDone01', mtimeMs: FRESH_MTIME_MS, sizeBytes: 500 },
        ],
        nonTerminalJobs: [{ id: 'job_live_pull', syncId: null }],
        routineRuns: [{ id: 'rrn_DoneDone01', status: 'completed' }],
      });

      await service.reapStagingDirs();

      expect(cleanupStaging).not.toHaveBeenCalled();
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_RUN_STORE_BYTES, 500);
    });

    it('includes the run store footprint in the summary log line', async () => {
      const { service } = makeService({
        stagingDirs: [{ jobId: 'le-rrn_Running001', mtimeMs: FRESH_MTIME_MS, sizeBytes: 1_234 }],
        nonTerminalJobs: [],
        routineRuns: [{ id: 'rrn_Running001', status: 'running' }],
      });
      const infoSpy = jest.spyOn(WSLogger, 'info');

      await service.reapStagingDirs();

      const summaryLogEntry = infoSpy.mock.calls
        .map((call: unknown[]) => call[0] as { message: string; [field: string]: unknown })
        .find((entry) => entry.message.startsWith('Staging-dir reaper sweep complete'));
      expect(summaryLogEntry?.message).toContain('le- run stores: 1 scanned, 0 reaped, 1234 of 5368709120 bytes');
      expect(summaryLogEntry).toMatchObject({
        runStoreDirsScanned: 1,
        runStoreBytes: 1_234,
        runStoreMaxBytes: 5_368_709_120,
      });
    });

    it('skips the run store lookups entirely when there are no run store dirs', async () => {
      const { service, routineRunFindMany } = makeService({
        stagingDirs: [{ jobId: 'job_dead', mtimeMs: OLD_MTIME_MS, sizeBytes: 1 }],
        nonTerminalJobs: [],
      });

      await service.reapStagingDirs();

      expect(routineRunFindMany).not.toHaveBeenCalled();
    });
  });

  it('emits a 0 gauge and does nothing when there are no staging dirs', async () => {
    const { service, cleanupStaging, metricsService } = makeService({
      stagingDirs: [],
      nonTerminalJobs: [],
    });

    await service.reapStagingDirs();

    expect(cleanupStaging).not.toHaveBeenCalled();
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 0);
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_RUN_STORE_BYTES, 0);
    expect(metricsService.logValue).not.toHaveBeenCalledWith(CustomMetric.STAGING_DIR_REAPED, 1);
  });
});
