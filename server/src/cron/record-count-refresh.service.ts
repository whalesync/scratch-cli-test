import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { RecordCountService } from 'src/record-count/record-count.service';

const LOG_SOURCE = 'RecordCountRefreshService';
// How many workbooks to load per page.
const PAGE_SIZE = 100;
// How many workbooks to recompute concurrently (each is one+ cheap tree walk on scratch-git).
const WORKBOOK_CONCURRENCY = 5;

@Injectable()
export class RecordCountRefreshService {
  constructor(
    private readonly db: DbService,
    private readonly recordCount: RecordCountService,
  ) {}

  /**
   * Periodically reconcile every workbook's denormalized DataFolder.recordCount with git.
   *
   * Pulls keep counts fresh for the folders they touch, but UI edits, syncs, and
   * remote-deletes can drift the stored value between pulls; this sweep corrects that. Counts
   * are derived from git truth, so re-running is idempotent. Events are suppressed
   * (emitEvent: false) to avoid a burst of SSE traffic on a periodic sweep — the per-pull
   * hooks emit for live freshness.
   *
   * Runs inline in batches; this is simple and cheap at current scale (one cheap GET per repo
   * per workbook). If the workbook count grows enough that an hourly sweep risks overrunning,
   * switch to enqueuing a per-workbook BullMQ job — the recompute is already a standalone
   * operation, so that migration is mechanical.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async refreshRecordCounts(): Promise<void> {
    WSLogger.info({ source: LOG_SOURCE, message: 'Waking up, starting record-count refresh' });
    let cursorId: string | undefined;
    let workbooksProcessed = 0;

    for (;;) {
      const workbooks = await this.db.client.workbook.findMany({
        // Only workbooks that have at least one git-backed connection, skipping any mid-delete.
        where: {
          isPendingDelete: false,
          connectorAccounts: { some: { repoPath: { not: null } } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });

      if (workbooks.length === 0) break;

      for (let start = 0; start < workbooks.length; start += WORKBOOK_CONCURRENCY) {
        const chunk = workbooks.slice(start, start + WORKBOOK_CONCURRENCY);
        await Promise.all(
          chunk.map(async (workbook) => {
            try {
              await this.recordCount.recomputeRecordCountsForWorkbook(workbook.id as WorkbookId, {
                emitEvent: false,
              });
            } catch (error) {
              WSLogger.warn({
                source: LOG_SOURCE,
                message: 'Failed to refresh record counts for workbook',
                workbookId: workbook.id,
                error,
              });
            }
          }),
        );
      }

      workbooksProcessed += workbooks.length;
      cursorId = workbooks[workbooks.length - 1]?.id;
      if (workbooks.length < PAGE_SIZE) break;
    }

    WSLogger.info({
      source: LOG_SOURCE,
      message: `Record-count refresh complete (${workbooksProcessed} workbook(s) processed)`,
    });
  }
}
