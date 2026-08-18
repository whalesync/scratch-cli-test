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

function makeService(deps: { stagingDirs: GitStagingDir[]; nonTerminalJobs: { id: string; syncId: string | null }[] }) {
  const listStaging = jest.fn().mockResolvedValue({ stagingDirs: deps.stagingDirs });
  const cleanupStaging = jest.fn().mockResolvedValue(undefined);
  const scratchGitService = { listStaging, cleanupStaging } as unknown as ScratchGitService;

  const db = {
    client: {
      dbJob: {
        findMany: jest.fn().mockResolvedValue(deps.nonTerminalJobs),
      },
    },
  } as unknown as DbService;

  const metricsService = { logValue: jest.fn() };

  const service = new StagingDirReaperService(db, scratchGitService, metricsService as unknown as CustomMetricsService);
  return { service, listStaging, cleanupStaging, metricsService };
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

  it('emits a 0 gauge and does nothing when there are no staging dirs', async () => {
    const { service, cleanupStaging, metricsService } = makeService({
      stagingDirs: [],
      nonTerminalJobs: [],
    });

    await service.reapStagingDirs();

    expect(cleanupStaging).not.toHaveBeenCalled();
    expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 0);
    expect(metricsService.logValue).not.toHaveBeenCalledWith(CustomMetric.STAGING_DIR_REAPED, 1);
  });
});
