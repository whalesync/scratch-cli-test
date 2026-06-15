import { Injectable, Logger } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { JobService } from 'src/job/job.service';
import { MigrationLockService } from 'src/migration-lock/migration-lock.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import type { JobData } from 'src/worker/jobs/union-types';

/** Hard cap on how long the drain waits for in-flight jobs to stop before giving up. */
const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;
/** How often the drain re-checks the connection's live `active` job set. */
const DEFAULT_DRAIN_POLL_INTERVAL_MS = 1_000;

export interface QuiesceConnectionOptions {
  drainTimeoutMs?: number;
  drainPollIntervalMs?: number;
}

export interface QuiesceConnectionSummary {
  cancelledPublishPlans: number;
  cancelledJobs: number;
}

/**
 * Thrown by {@link ConnectionQuiesceService.quiesceConnection} when in-flight jobs
 * for the connection do not stop within the drain timeout. The migration catches
 * it, releases the connection (so it isn't left locked), and SKIPS that account —
 * a busy connection is retried on a later run rather than migrated unsafely.
 */
export class ConnectionDrainTimeoutError extends Error {
  constructor(
    readonly connectorAccountId: string,
    readonly remainingActiveJobs: number,
  ) {
    super(
      `Connection ${connectorAccountId} still has ${remainingActiveJobs} active job(s) after the drain timeout; ` +
        `skipping it this run.`,
    );
    this.name = 'ConnectionDrainTimeoutError';
  }
}

/**
 * DEV-9698 (T4) — wraps a per-connection code-migration in a quiesce / release
 * pair so the migration's folder moves never race live pipeline activity.
 *
 * `quiesceConnection` (acquire): lock the connection (blocks new edits + new job
 * enqueues), disable + mark its schedules, cancel its non-terminal publish plans,
 * then cancel + drain its in-flight jobs (waiting for the BullMQ `active` set to
 * clear — a cancelled job's worker keeps running until its next abort checkpoint).
 *
 * `unquiesceConnection` (release): restore the schedules this migration disabled,
 * unlock the connection, and emit a workbook event so open web clients refresh the
 * (now relocated) tree.
 *
 * The release must run in a `finally` so a mid-migration error still unlocks the
 * connection. A hard process crash that skips the release leaves the connection
 * locked and its schedules disabled (both marker-backed) — a re-run re-acquires,
 * finishes, and repairs that state; the lock is strict-by-design and does not
 * auto-expire.
 */
@Injectable()
export class ConnectionQuiesceService {
  private readonly logger = new Logger(ConnectionQuiesceService.name);

  constructor(
    private readonly migrationLock: MigrationLockService,
    private readonly scheduleService: ScheduleService,
    private readonly publishPlanBuildService: PublishPlanBuildService,
    private readonly jobService: JobService,
    private readonly workbookEventService: WorkbookEventService,
  ) {}

  /**
   * Acquire: lock → disable schedules → cancel publish plans → drain jobs. Throws
   * {@link ConnectionDrainTimeoutError} if the jobs don't stop in time (the lock is
   * still held; the caller releases it via {@link unquiesceConnection}).
   */
  async quiesceConnection(
    workbookId: string,
    connectorAccountId: string,
    options?: QuiesceConnectionOptions,
  ): Promise<QuiesceConnectionSummary> {
    // 1. Lock first — once set, new live edits and new job enqueues for this
    //    connection are rejected, so the steps below converge instead of racing.
    await this.migrationLock.lockConnection(connectorAccountId);

    // 2. Disable + mark the connection's schedules so none fires mid-migration.
    await this.scheduleService.disableSchedulesForConnectionMigration(workbookId as WorkbookId, connectorAccountId);

    // 3. Cancel non-terminal publish plans so a resumed plan can't commit to old paths.
    const cancelledPublishPlans =
      await this.publishPlanBuildService.cancelNonTerminalPlansForConnection(connectorAccountId);

    // 4. Cancel + drain in-flight jobs; wait for the worker(s) to actually stop.
    const cancelledJobs = await this.drainJobsForConnection(workbookId, connectorAccountId, options);

    this.logger.log(
      `quiesced connection ${connectorAccountId}: cancelledPublishPlans=${cancelledPublishPlans}, cancelledJobs=${cancelledJobs}`,
    );
    return { cancelledPublishPlans, cancelledJobs };
  }

  /**
   * Release: restore schedules (marker-driven, crash-safe) → unlock → notify open
   * clients. Safe to call even if the matching quiesce partially failed.
   */
  async unquiesceConnection(workbookId: string, connectorAccountId: string): Promise<void> {
    await this.scheduleService.restoreSchedulesForConnectionMigration(workbookId as WorkbookId, connectorAccountId);
    await this.migrationLock.unlockConnection(connectorAccountId);
    this.workbookEventService.sendWorkbookEvent(workbookId as WorkbookId, {
      type: 'workbook-updated',
      data: {
        source: 'job',
        entityId: workbookId,
        message: 'Folder layout updated by a migration — refresh to see the new structure.',
        connectorAccountId,
      },
    });
    this.logger.log(`released connection ${connectorAccountId}`);
  }

  /**
   * Cancel every non-terminal job for the connection, then poll until the
   * connection's BullMQ `active` set is empty (the worker has actually stopped) or
   * the timeout elapses. Returns the number of jobs cancelled.
   */
  private async drainJobsForConnection(
    workbookId: string,
    connectorAccountId: string,
    options?: QuiesceConnectionOptions,
  ): Promise<number> {
    const drainTimeoutMs = options?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const pollIntervalMs = options?.drainPollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;
    const deadline = Date.now() + drainTimeoutMs;

    // Accumulate across every pass — a job can transition created → active between
    // polls and get cancelled in a later pass, so the count must include those too.
    let totalCancelled = await this.cancelNonTerminalJobsForConnection(workbookId, connectorAccountId);

    for (;;) {
      const stillActive = await this.countActiveJobsForConnection(connectorAccountId);
      if (stillActive === 0) return totalCancelled;
      if (Date.now() >= deadline) {
        throw new ConnectionDrainTimeoutError(connectorAccountId, stillActive);
      }
      // A job may have transitioned created → active between passes; cancel any that did.
      totalCancelled += await this.cancelNonTerminalJobsForConnection(workbookId, connectorAccountId);
      await this.sleep(pollIntervalMs);
    }
  }

  /** Cancel the connection's non-terminal jobs (one pass). Returns how many it cancelled. */
  private async cancelNonTerminalJobsForConnection(workbookId: string, connectorAccountId: string): Promise<number> {
    const jobs = await this.jobService.getNonTerminalJobsForWorkbook(workbookId);
    let cancelled = 0;
    for (const job of jobs) {
      const connectorAccountIds = await this.migrationLock.resolveConnectorAccountIdsForJob(
        job.data as unknown as JobData,
      );
      if (connectorAccountIds.includes(connectorAccountId)) {
        await this.jobService.systemCancelJob(job);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** Count BullMQ jobs currently *running* (active) that touch the connection. */
  private async countActiveJobsForConnection(connectorAccountId: string): Promise<number> {
    const activeJobDatas = await this.jobService.getActiveBullJobDatas();
    let count = 0;
    for (const data of activeJobDatas) {
      const connectorAccountIds = await this.migrationLock.resolveConnectorAccountIdsForJob(data);
      if (connectorAccountIds.includes(connectorAccountId)) count += 1;
    }
    return count;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
