import { Injectable } from '@nestjs/common';
import {
  JobType,
  OrganizationMonthlyRunCounts,
  RunType,
  createOrganizationMonthlyRunCountId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';

const LOG_SOURCE = 'RunCountService';

/**
 * Maps a BullMQ {@link JobType} to the run-count {@link RunType} bucket it belongs to. Only
 * user-facing run executions are counted; everything not in this map is intentionally NOT counted:
 *  - `apply-patches` is part of the publish flow — counting it would double-count a single publish
 *    (the `publish` job already increments PUBLISH).
 *  - `rehost-assets`, `delete-workbook`, `temporary-sync-with-pull` are internal/throwaway.
 */
export const RUN_COUNTABLE_JOB_TYPES: Readonly<Record<string, RunType>> = {
  [JobType.PullLinkedFolderFiles]: RunType.PULL,
  [JobType.RefreshRecords]: RunType.PULL,
  [JobType.Publish]: RunType.PUBLISH,
  [JobType.SyncDataFolders]: RunType.SYNC,
};

/** The {@link RunType} a job type counts toward, or `undefined` if the job type is not counted. */
export function runTypeForJobType(jobType: string): RunType | undefined {
  return RUN_COUNTABLE_JOB_TYPES[jobType];
}

/** First instant (UTC) of the calendar month containing `date`. Used as the monthly bucket key. */
export function monthStartUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Tracks high-level run executions (Pull / Publish / Sync / Routine) per organization, bucketed by
 * calendar month, in the {@link OrganizationMonthlyRunCount} table — a monetization lever (DEV-10543).
 * NOT the deprecated `Action` table.
 *
 * Distinct from `RecordCountService`, which counts record *files*; this counts run *executions*.
 *
 * Every record-* method is **non-fatal**: a counter failure logs a warning and never propagates, so
 * it can never break the job or routine that triggered it (same contract as PostHog tracking).
 */
@Injectable()
export class RunCountService {
  constructor(private readonly db: DbService) {}

  /**
   * Record one Pull/Publish/Sync run for the job that just reached a terminal, non-cancelled state
   * (completed or failed — the caller filters out cancellations). No-op for job types that are not
   * counted (see {@link RUN_COUNTABLE_JOB_TYPES}).
   *
   * `organizationId` is taken from the job data when present (pull/sync carry it) and otherwise
   * resolved from the workbook (publish does not carry it). Routine-triggered step jobs are counted
   * here too — by product decision they count in BOTH their type bucket and `routine`.
   */
  async recordJobRun(params: {
    jobType: string;
    workbookId?: string;
    organizationId?: string;
    occurredAt?: Date;
  }): Promise<void> {
    const runType = runTypeForJobType(params.jobType);
    if (!runType) {
      return;
    }
    try {
      const organizationId = await this.resolveOrganizationId(params.organizationId, params.workbookId);
      if (!organizationId) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Skipping run count: could not resolve organization for job',
          jobType: params.jobType,
          workbookId: params.workbookId,
        });
        return;
      }
      await this.incrementBucket(organizationId, runType, params.occurredAt ?? new Date());
    } catch (error) {
      WSLogger.warn({ source: LOG_SOURCE, message: 'Failed to record job run count', jobType: params.jobType, error });
    }
  }

  /**
   * Record one Routine run for a routine that just reached a terminal, non-cancelled state. The org
   * is resolved from the routine run's workbook.
   */
  async recordRoutineRun(params: { workbookId: string; occurredAt?: Date }): Promise<void> {
    try {
      const organizationId = await this.resolveOrganizationId(undefined, params.workbookId);
      if (!organizationId) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Skipping run count: could not resolve organization for routine',
          workbookId: params.workbookId,
        });
        return;
      }
      await this.incrementBucket(organizationId, RunType.ROUTINE, params.occurredAt ?? new Date());
    } catch (error) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to record routine run count',
        workbookId: params.workbookId,
        error,
      });
    }
  }

  /** Current-calendar-month (UTC) run counts for an organization, by type, plus their sum. */
  async getCurrentMonthRunCounts(organizationId: string): Promise<OrganizationMonthlyRunCounts> {
    const periodStart = monthStartUtc(new Date());
    const rows = await this.db.client.organizationMonthlyRunCount.findMany({
      where: { organizationId, periodStart },
      select: { runType: true, count: true },
    });

    // Keyed by the raw `runType` string from the DB; reading by the typed RunType values keeps the
    // breakdown stable and ignores any unknown bucket without an unsafe enum-vs-string comparison.
    const countByRunType = new Map(rows.map((row) => [row.runType, row.count]));
    const pull = countByRunType.get(RunType.PULL) ?? 0;
    const publish = countByRunType.get(RunType.PUBLISH) ?? 0;
    const sync = countByRunType.get(RunType.SYNC) ?? 0;
    const routine = countByRunType.get(RunType.ROUTINE) ?? 0;
    return { total: pull + publish + sync + routine, pull, publish, sync, routine };
  }

  /** Returns `organizationId` if given, else looks it up from the workbook; `undefined` if neither resolves. */
  private async resolveOrganizationId(
    organizationId: string | undefined,
    workbookId: string | undefined,
  ): Promise<string | undefined> {
    if (organizationId) {
      return organizationId;
    }
    if (!workbookId) {
      return undefined;
    }
    const workbook = await this.db.client.workbook.findUnique({
      where: { id: workbookId },
      select: { organizationId: true },
    });
    return workbook?.organizationId;
  }

  /**
   * Atomically create-or-increment the `(organizationId, periodStart, runType)` bucket by one. Uses a
   * raw `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` so concurrent completions on the same
   * bucket (e.g. two workers in the same month) are fully race-proof — including the create/create
   * window at the first run of a new month, which a Prisma `upsert` would lose to a unique violation.
   * `updatedAt` is set explicitly because raw SQL bypasses Prisma's `@updatedAt` management.
   */
  private async incrementBucket(organizationId: string, runType: RunType, occurredAt: Date): Promise<void> {
    const periodStart = monthStartUtc(occurredAt);
    const id = createOrganizationMonthlyRunCountId();
    await this.db.client.$executeRaw`
      INSERT INTO "OrganizationMonthlyRunCount" ("id", "updatedAt", "organizationId", "periodStart", "runType", "count")
      VALUES (${id}, NOW(), ${organizationId}, ${periodStart}, ${runType}, 1)
      ON CONFLICT ("organizationId", "periodStart", "runType")
      DO UPDATE SET "count" = "OrganizationMonthlyRunCount"."count" + 1, "updatedAt" = NOW()
    `;
  }
}
