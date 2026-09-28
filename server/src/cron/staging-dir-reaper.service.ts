import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GitStagingDir, isRoutineRunId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { TERMINAL_ROUTINE_RUN_STATUSES } from 'src/routine/routine.types';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { hours } from 'src/utils/duration';

const LOG_SOURCE = 'StagingDirReaperService';

/** Staging keys with this prefix are Live Export run stores (`le-<routineRunId>`), not pull/sync staging dirs. */
const RUN_STORE_STAGING_KEY_PREFIX = 'le-';

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

/**
 * Age threshold for Live Export run store dirs (`le-<runId>`). A Live Export run is never resumed a
 * day later — the routine simply runs again — so a dead run's store only needs to outlive a debugging
 * window. Kept in sync with scratch-git's `RUN_STORE_STAGING_REAP_MAX_AGE` boot-time backstop (24h).
 */
const RUN_STORE_STAGING_REAP_MAX_AGE = hours(24);

/**
 * Fallback for scratch-git's `GIT_LE_RUN_STORE_MAX_BYTES` (5 GiB) when an older scratch-git build
 * doesn't report `runStoreMaxBytes` in its staging listing.
 */
const DEFAULT_RUN_STORE_MAX_BYTES = 5 * 1024 * 1024 * 1024;

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
 * job's `sync-<syncId>-`.
 *
 * Live Export run store dirs (`le-<runId>`, scratch-git-2/docs/RUN_STORE.md) follow their own rules:
 *   - the key is always `le-<routineRunId>` (an `rrn_…` id). A run store is live while that RoutineRun
 *     exists and is non-terminal; anything else under `le-` (no such RoutineRun, not an `rrn_…` id) is
 *     dead;
 *   - reaped once older than {@link RUN_STORE_STAGING_REAP_MAX_AGE} (24h) and dead;
 *   - byte budget: when all `le-` dirs together exceed scratch-git's `runStoreMaxBytes`, the oldest
 *     dead ones are deleted first regardless of age; if the total is still over, it logs an error.
 * Idempotent and non-fatal per the cron conventions in this dir's CLAUDE.md.
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
      // Still emit the gauges (0) so they stay continuous series for dashboards/alerts.
      this.metricsService.logValue(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, 0);
      this.metricsService.logValue(CustomMetric.SCRATCH_GIT_RUN_STORE_BYTES, 0);
      WSLogger.info({ source: LOG_SOURCE, message: 'Staging-dir reaper sweep complete: no staging dirs.' });
      return;
    }
    const runStoreMaxBytes = stagingDirs.runStoreMaxBytes ?? DEFAULT_RUN_STORE_MAX_BYTES;

    // Snapshot of live jobs, keyed both ways so pull (id) and sync (sync-<syncId>-) dirs both match.
    const nonTerminalJobs = await this.db.client.dbJob.findMany({
      where: { status: { in: NON_TERMINAL_JOB_STATUSES } },
      select: { id: true, syncId: true },
    });
    const activeJobIds = new Set(nonTerminalJobs.map((job) => job.id));
    const activeSyncPrefixes = nonTerminalJobs
      .filter((job): job is { id: string; syncId: string } => job.syncId !== null)
      .map((job) => `sync-${job.syncId}-`);

    const runStoreDirs = stagingDirs.stagingDirs.filter((dir) => this.isRunStoreDir(dir));
    const liveRunStoreStagingKeys = await this.findLiveRunStoreStagingKeys(runStoreDirs);

    const stagingCutoffMs = STAGING_REAP_MAX_AGE.inPast().getTime();
    const runStoreCutoffMs = RUN_STORE_STAGING_REAP_MAX_AGE.inPast().getTime();

    let reaped = 0;
    let skippedLive = 0;
    let skippedFresh = 0;
    let failed = 0;
    // Reclaimable orphan bytes seen this sweep (old + not live), whether or not the delete succeeds.
    let orphanBytes = 0;
    const reapedRunStoreStagingKeys = new Set<string>();

    for (const dir of stagingDirs.stagingDirs) {
      const isRunStore = this.isRunStoreDir(dir);
      const isOld = dir.mtimeMs < (isRunStore ? runStoreCutoffMs : stagingCutoffMs);
      if (!isOld) {
        skippedFresh += 1;
        continue;
      }
      const isLive = isRunStore
        ? liveRunStoreStagingKeys.has(dir.jobId)
        : this.isLive(dir, activeJobIds, activeSyncPrefixes);
      if (isLive) {
        skippedLive += 1;
        continue;
      }

      orphanBytes += dir.sizeBytes;
      if (await this.reapStagingDir(dir, 'orphaned')) {
        reaped += 1;
        if (isRunStore) {
          reapedRunStoreStagingKeys.add(dir.jobId);
        }
      } else {
        failed += 1;
      }
    }

    // Byte budget for run stores: over budget, delete the oldest dead ones (any age) until back under.
    const remainingRunStoreDirs = runStoreDirs.filter((dir) => !reapedRunStoreStagingKeys.has(dir.jobId));
    const runStoreBytesBeforeBudgetPass = remainingRunStoreDirs.reduce((total, dir) => total + dir.sizeBytes, 0);
    let runStoreBytes = runStoreBytesBeforeBudgetPass;
    let runStoreReapedForBudget = 0;
    if (runStoreBytes > runStoreMaxBytes) {
      const deadRunStoreDirsOldestFirst = remainingRunStoreDirs
        .filter((dir) => !liveRunStoreStagingKeys.has(dir.jobId))
        .sort((left, right) => left.mtimeMs - right.mtimeMs);
      for (const dir of deadRunStoreDirsOldestFirst) {
        if (runStoreBytes <= runStoreMaxBytes) {
          break;
        }
        if (await this.reapStagingDir(dir, 'over the run store byte budget')) {
          runStoreReapedForBudget += 1;
          reaped += 1;
          runStoreBytes -= dir.sizeBytes;
        } else {
          failed += 1;
        }
      }
      if (runStoreBytes > runStoreMaxBytes) {
        WSLogger.error({
          source: LOG_SOURCE,
          message:
            'Live Export run stores are still over their byte budget after reaping every dead one; ' +
            'new runs will fail to create their run store until live runs finish',
          runStoreBytes,
          runStoreMaxBytes,
          liveRunStoreStagingKeys: [...liveRunStoreStagingKeys],
        });
      }
    }

    this.metricsService.logValue(CustomMetric.SCRATCH_GIT_STAGING_ORPHAN_BYTES, orphanBytes);
    this.metricsService.logValue(CustomMetric.SCRATCH_GIT_RUN_STORE_BYTES, runStoreBytes);

    WSLogger.info({
      source: LOG_SOURCE,
      message:
        `Staging-dir reaper sweep complete (${stagingDirs.stagingDirs.length} scanned, ${reaped} reaped, ` +
        `${skippedLive} live, ${skippedFresh} fresh, ${failed} failed; ` +
        `${RUN_STORE_STAGING_KEY_PREFIX} run stores: ${runStoreDirs.length} scanned, ` +
        `${reapedRunStoreStagingKeys.size + runStoreReapedForBudget} reaped, ${runStoreBytes} of ${runStoreMaxBytes} bytes).`,
      scanned: stagingDirs.stagingDirs.length,
      reaped,
      skippedLive,
      skippedFresh,
      failed,
      orphanBytes,
      runStoreDirsScanned: runStoreDirs.length,
      runStoreReapedAsOrphans: reapedRunStoreStagingKeys.size,
      runStoreReapedForBudget,
      runStoreBytesBeforeBudgetPass,
      runStoreBytes,
      runStoreMaxBytes,
    });
  }

  private isLive(dir: GitStagingDir, activeJobIds: Set<string>, activeSyncPrefixes: string[]): boolean {
    return activeJobIds.has(dir.jobId) || activeSyncPrefixes.some((prefix) => dir.jobId.startsWith(prefix));
  }

  private isRunStoreDir(dir: GitStagingDir): boolean {
    return dir.jobId.startsWith(RUN_STORE_STAGING_KEY_PREFIX);
  }

  /** Delete one staging dir; non-fatal — a failure is logged and reported as `false`. */
  private async reapStagingDir(dir: GitStagingDir, reason: string): Promise<boolean> {
    try {
      await this.scratchGitService.cleanupStaging(dir.jobId);
      this.metricsService.logValue(CustomMetric.STAGING_DIR_REAPED, 1);
      WSLogger.info({
        source: LOG_SOURCE,
        message: `Reaped staging dir (${reason})`,
        jobId: dir.jobId,
        ageMs: Date.now() - dir.mtimeMs,
        sizeBytes: dir.sizeBytes,
      });
      return true;
    } catch (error) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: `Failed to reap staging dir (${reason})`,
        jobId: dir.jobId,
        error,
      });
      return false;
    }
  }

  /**
   * The `le-<routineRunId>` staging keys whose RoutineRun still exists and is non-terminal. A key whose
   * suffix is not an `rrn_…` id, or whose RoutineRun is gone, is dead.
   */
  private async findLiveRunStoreStagingKeys(runStoreDirs: GitStagingDir[]): Promise<Set<string>> {
    const routineRunIdByStagingKey = new Map<string, string>();
    for (const dir of runStoreDirs) {
      const routineRunIdCandidate = dir.jobId.slice(RUN_STORE_STAGING_KEY_PREFIX.length);
      if (isRoutineRunId(routineRunIdCandidate)) {
        routineRunIdByStagingKey.set(dir.jobId, routineRunIdCandidate);
      }
    }
    if (routineRunIdByStagingKey.size === 0) {
      return new Set();
    }

    const routineRuns = await this.db.client.routineRun.findMany({
      where: { id: { in: [...new Set(routineRunIdByStagingKey.values())] } },
      select: { id: true, status: true },
    });
    const nonTerminalRoutineRunIds = new Set(
      routineRuns
        .filter((routineRun) => !TERMINAL_ROUTINE_RUN_STATUSES.includes(routineRun.status))
        .map((routineRun) => routineRun.id),
    );

    const liveRunStoreStagingKeys = new Set<string>();
    for (const [stagingKey, routineRunId] of routineRunIdByStagingKey) {
      if (nonTerminalRoutineRunIds.has(routineRunId)) {
        liveRunStoreStagingKeys.add(stagingKey);
      }
    }
    return liveRunStoreStagingKeys;
  }
}
