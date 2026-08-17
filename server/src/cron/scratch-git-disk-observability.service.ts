import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';

const LOG_SOURCE = 'ScratchGitDiskObservabilityService';
// How many git-backed connector-account repos to load per page.
const PAGE_SIZE = 100;
// How many repos to probe concurrently (each is one cheap `git count-objects -v` GET on scratch-git).
const REPO_CONCURRENCY = 5;
// Repos at or above this many loose objects are named in the finish log so a human can attribute the
// gauge to the offending repo(s). Set well below the alert threshold so build-up is visible in the logs
// before the `scratch_git_repo_loose_objects_high` alert fires (see terraform/modules/env/monitoring.tf).
const LOOSE_OBJECT_ATTRIBUTION_THRESHOLD = 10_000;
// Cap on how many offenders we name in a single finish-log line (worst first).
const MAX_OFFENDERS_TO_LOG = 10;

/**
 * Parse the loose-object count out of raw `git count-objects -v` output (the verbatim `stats` text
 * returned by scratch-git's count-objects endpoint). The `count:` line is the number of loose (unpacked)
 * objects — the RC1 signal from DEV-11253: a healthy repo GCs this back to 0, so a large value means
 * `git gc` is silently not running on that repo. Returns null when the line is absent/unparseable, so the
 * caller can skip the repo rather than mistake it for a healthy 0.
 */
export function parseLooseObjectCount(stats: string): number | null {
  const match = stats.match(/^count:\s*(\d+)\s*$/m);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

/**
 * Read-only disk observability for scratch-git (DEV-11315, parent DEV-11253 RC5). Nobody saw the prod
 * disk fill because there was no per-repo signal — the only alert was a VM-wide `disk > 80%` page that
 * fired far too late. This hourly sweep probes every git-backed connector-account repo with the existing
 * `getObjectCounts` endpoint and emits a single gauge: the WORST repo's loose-object count. That's the
 * dominant reclaimable-bloat signal (a GC-wedged repo accretes loose objects unbounded), and shipping it
 * BEFORE the Phase 2 GC fix is what makes the reclamation provable (watch the gauge fall after GC lands).
 *
 * The gauge is dimensionless (aggregate max) to keep Prometheus cardinality bounded — attribution to the
 * specific repo is via the finish log line, which names the worst offenders. Strictly read-only: it only
 * issues `count-objects` GETs and never mutates a repo. Idempotent and non-fatal (a failing repo is
 * warned and skipped), per the cron conventions in this directory's CLAUDE.md.
 */
@Injectable()
export class ScratchGitDiskObservabilityService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async emitDiskObservabilityMetrics(): Promise<void> {
    WSLogger.info({ source: LOG_SOURCE, message: 'Waking up, starting scratch-git disk observability sweep' });

    let cursorId: string | undefined;
    let reposScanned = 0;
    let reposFailed = 0;
    let maxLooseObjects = 0;
    let worstRepoPath: string | null = null;
    const offenders: { repoPath: string; looseObjects: number }[] = [];

    for (;;) {
      const connectorAccounts = await this.db.client.connectorAccount.findMany({
        // Every git-backed connection (repoPath is the scratch-git repo id), skipping any mid-delete workbook.
        where: {
          repoPath: { not: null },
          workbook: { isPendingDelete: false },
        },
        select: { id: true, repoPath: true },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });

      if (connectorAccounts.length === 0) break;

      for (let start = 0; start < connectorAccounts.length; start += REPO_CONCURRENCY) {
        const chunk = connectorAccounts.slice(start, start + REPO_CONCURRENCY);
        await Promise.all(
          chunk.map(async (connectorAccount) => {
            const repoPath = connectorAccount.repoPath;
            if (!repoPath) {
              // The `repoPath: { not: null }` filter should preclude this; guard so the type narrows
              // without a non-null assertion (banned by lint) and a data anomaly is skipped, not thrown.
              return;
            }
            try {
              // `ConnectorAccount.repoPath` IS the scratch-git repo id that `getObjectCounts` expects
              // (composite `{orgId}--{workbookId}--{connAccountId}`), so it is passed through directly.
              const objectCounts = await this.scratchGitService.getObjectCounts(repoPath);
              const looseObjects = parseLooseObjectCount(objectCounts.stats);
              if (looseObjects === null) {
                reposFailed += 1;
                WSLogger.warn({
                  source: LOG_SOURCE,
                  message: 'Could not parse loose-object count from count-objects output',
                  repoPath,
                });
                return;
              }
              // Synchronous section — no await between compare and assign, so concurrent chunk callbacks
              // can't interleave a lost update to the shared running max.
              reposScanned += 1;
              if (looseObjects > maxLooseObjects) {
                maxLooseObjects = looseObjects;
                worstRepoPath = repoPath;
              }
              if (looseObjects >= LOOSE_OBJECT_ATTRIBUTION_THRESHOLD) {
                offenders.push({ repoPath, looseObjects });
              }
            } catch (error) {
              reposFailed += 1;
              WSLogger.warn({
                source: LOG_SOURCE,
                message: 'Failed to read object counts for repo',
                repoPath,
                error,
              });
            }
          }),
        );
      }

      cursorId = connectorAccounts[connectorAccounts.length - 1]?.id;
      if (connectorAccounts.length < PAGE_SIZE) break;
    }

    // Emit even when the max is 0 / nothing was scanned, so the gauge is a continuous series dashboards
    // and the loose-object alert can read (a gap would read as "no data", not "healthy").
    this.metricsService.logValue(CustomMetric.SCRATCH_GIT_REPO_LOOSE_OBJECTS, maxLooseObjects);

    const topOffenders = offenders.sort((a, b) => b.looseObjects - a.looseObjects).slice(0, MAX_OFFENDERS_TO_LOG);
    // The worst repo is carried in the structured `worstRepoPath` field (not interpolated into the message)
    // so the message stays a plain string and a human can attribute the gauge from the log payload.
    WSLogger.info({
      source: LOG_SOURCE,
      message: `scratch-git disk observability sweep complete (${reposScanned} repo(s) scanned, ${reposFailed} skipped); worst loose-object count ${maxLooseObjects}.`,
      maxLooseObjects,
      worstRepoPath,
      reposScanned,
      reposFailed,
      offendersOverThreshold: offenders.length,
      topOffenders,
    });
  }
}
