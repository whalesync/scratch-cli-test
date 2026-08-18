import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GitStagingDir } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { hours } from 'src/utils/duration';

const LOG_SOURCE = 'StagingDirReaperService';

/**
 * A `{staging_dir}/{jobId}` dir is only a reap candidate once it is older than this. scratch-git
 * routes every pull and sync through staging before an atomic commit and the caller removes the dir
 * in a best-effort `finally`; a crash/redeploy in between strands it forever (DEV-11253 RC2). The age
 * gate is generous so it never races the deliberate crash-resume design (a mid-run dir keeps getting
 * written and stays young); the liveness gate below is the real safety mechanism. 72h both covers pulls
 * that legitimately run for days and leaves a window to debug a failed pull's staging dir before it is
 * swept. Kept in sync with the git service's own `GIT_STAGING_REAP_MAX_AGE_HOURS` boot-time backstop
 * (default 72h).
 */
const STAGING_REAP_MAX_AGE = hours(72);

// The DbJob statuses that mean a worker still owns the job (so its staging dir is off-limits). A job
// left non-terminal by a dead worker is reconciled to a terminal state by StaleJobReaperService within
// ~30 min, after which the next hourly staging sweep reaps its dir — so this self-heals.
const NON_TERMINAL_JOB_STATUSES = ['created', 'active'];

/**
 * Hourly reaper for orphaned scratch-git staging directories (DEV-11317, parent DEV-11253 RC2).
 *
 * Reaps a `{staging_dir}/{jobId}` dir only when it is BOTH older than {@link STAGING_REAP_MAX_AGE}
 * AND not owned by a live job — never a boot-wipe, honoring the crash-resume design in scratch-git's
 * `staging.rs`. The staging `jobId` is NOT a BullMQ id, so liveness is gated on the DbJob table (the
 * source both key schemes derive from):
 *   - pull staging dir  → named exactly `DbJob.id`;
 *   - sync staging dir  → named `sync-<DbJob.syncId>-<folderId>-<rand>`.
 * A dir is "live" if its name is a non-terminal DbJob id, or it is prefixed by a non-terminal sync
 * job's `sync-<syncId>-`. Idempotent and non-fatal per the cron conventions in this dir's CLAUDE.md.
 */
@Injectable()
export class StagingDirReaperService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async reapStagingDirs(): Promise<void> {
    WSLogger.info({ source: LOG_SOURCE, message: 'Waking up, starting staging-dir reaper sweep' });

    const stagingDirs = await this.scratchGitService.listStaging();
    if (stagingDirs.stagingDirs.length === 0) {
      // Still emit the gauge (0) so it stays a continuous series for dashboards/alerts.
      this.metricsService.logValue(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 0);
      WSLogger.info({ source: LOG_SOURCE, message: 'Staging-dir reaper sweep complete: no staging dirs.' });
      return;
    }

    // Snapshot of live jobs, keyed both ways so pull (id) and sync (sync-<syncId>-) dirs both match.
    const nonTerminalJobs = await this.db.client.dbJob.findMany({
      where: { status: { in: NON_TERMINAL_JOB_STATUSES } },
      select: { id: true, syncId: true },
    });
    const activeJobIds = new Set(nonTerminalJobs.map((job) => job.id));
    const activeSyncPrefixes = nonTerminalJobs
      .filter((job): job is { id: string; syncId: string } => job.syncId !== null)
      .map((job) => `sync-${job.syncId}-`);

    const cutoffMs = STAGING_REAP_MAX_AGE.inPast().getTime();

    let reaped = 0;
    let skippedLive = 0;
    let skippedFresh = 0;
    let failed = 0;
    // Reclaimable orphan bytes seen this sweep (old + not live), whether or not the delete succeeds.
    let orphanBytes = 0;

    for (const dir of stagingDirs.stagingDirs) {
      const isOld = dir.mtimeMs < cutoffMs;
      if (!isOld) {
        skippedFresh += 1;
        continue;
      }
      if (this.isLive(dir, activeJobIds, activeSyncPrefixes)) {
        skippedLive += 1;
        continue;
      }

      orphanBytes += dir.sizeBytes;
      try {
        await this.scratchGitService.cleanupStaging(dir.jobId);
        reaped += 1;
        this.metricsService.logValue(CustomMetric.STAGING_DIR_REAPED, 1);
        WSLogger.info({
          source: LOG_SOURCE,
          message: 'Reaped orphaned staging dir',
          jobId: dir.jobId,
          ageMs: Date.now() - dir.mtimeMs,
          sizeBytes: dir.sizeBytes,
        });
      } catch (error) {
        failed += 1;
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Failed to reap orphaned staging dir',
          jobId: dir.jobId,
          error,
        });
      }
    }

    this.metricsService.logValue(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, orphanBytes);

    WSLogger.info({
      source: LOG_SOURCE,
      message: `Staging-dir reaper sweep complete (${stagingDirs.stagingDirs.length} scanned, ${reaped} reaped, ${skippedLive} live, ${skippedFresh} fresh, ${failed} failed).`,
      scanned: stagingDirs.stagingDirs.length,
      reaped,
      skippedLive,
      skippedFresh,
      failed,
      orphanBytes,
    });
  }

  private isLive(dir: GitStagingDir, activeJobIds: Set<string>, activeSyncPrefixes: string[]): boolean {
    return activeJobIds.has(dir.jobId) || activeSyncPrefixes.some((prefix) => dir.jobId.startsWith(prefix));
  }
}
