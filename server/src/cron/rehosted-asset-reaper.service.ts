import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { isWorkbookId } from '@spinner/shared-types';
import { chunk } from 'lodash';
import { REHOSTED_ASSET_OBJECT_KEY_ROOT_PREFIX } from 'src/asset/asset.types';
import { AssetBucketLiveObjectDeleteOutcome, ObjectStorageService } from 'src/asset/object-storage.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { assertUnreachable } from 'src/utils/asserts';
import { days } from 'src/utils/duration';

const LOG_SOURCE = 'RehostedAssetReaperService';

/**
 * An object is a reap candidate only once it is older than this, measured from its `timeCreated` (its upload).
 * Rehosting uploads the object BEFORE it writes the `Asset.rehostedUrl` that references it, so a young
 * unreferenced object may be a rehost still in flight, or one that crashed between the two steps.
 */
export const REHOSTED_ASSET_REAP_MIN_OBJECT_AGE = days(7);

/**
 * The most objects one sweep selects for reaping, so a bad sweep has a bounded blast radius; a bigger backlog
 * drains over several nights. A dry run selects (and logs) at most this many too, so it mirrors a real run.
 */
export const MAX_REHOSTED_ASSET_OBJECTS_SELECTED_FOR_REAPING_PER_SWEEP = 25_000;

/** This many failed deletes in a row means something systemic (e.g. lost bucket permissions): abort the sweep. */
export const MAX_CONSECUTIVE_FAILED_REHOSTED_ASSET_DELETES = 50;

/** Deletes run this many at a time. */
const REHOSTED_ASSET_DELETE_CONCURRENCY = 25;

/** One object selected for reaping, with the generation it was listed at (the delete's precondition). */
interface RehostedAssetObjectToReap {
  key: string;
  generation: string;
}

/** What happened to one object a real (non-dry-run) sweep tried to delete. */
type RehostedAssetObjectReapOutcome = AssetBucketLiveObjectDeleteOutcome | 'failed';

/** Per-object tallies, kept per workbook key prefix and summed into the sweep's. */
interface RehostedAssetObjectTallies {
  objectsScanned: number;
  objectsKeptAsReferenced: number;
  /** Younger than the minimum age, or listed without the creation time / generation needed to reap it safely. */
  objectsKeptAsTooYoung: number;
  /** Unreferenced, old enough, and within the per-sweep cap: deleted, or in a dry run only logged. */
  objectsSelectedForReaping: number;
  objectsReaped: number;
  objectsAlreadyGone: number;
  objectsChangedSinceListed: number;
  objectsFailedToReap: number;
}

interface RehostedAssetReaperSweepState {
  deletesEnabled: boolean;
  publicUrlPrefix: string;
  objectsCreatedBeforeThisAreOldEnoughToReap: Date;
  consecutiveFailedDeletes: number;
  workbookKeyPrefixesScanned: number;
  nonWorkbookKeyPrefixesSkipped: number;
  perSweepSelectionCapReached: boolean;
  objectTallies: RehostedAssetObjectTallies;
}

/**
 * Nightly reaper for rehosted asset files that nothing references any more (DEV-12324).
 *
 * Rehosting copies an asset into the public GCS assets bucket at `v1/{workbookId}/…` and records the public URL
 * in `Asset.rehostedUrl`. Nothing deletes those files inline: deleting a workbook or a data folder cascades its
 * `Asset` rows away, and this sweep then reconciles the bucket against the database. It walks each
 * `v1/{workbookId}/` prefix and deletes the live objects that are BOTH older than
 * {@link REHOSTED_ASSET_REAP_MIN_OBJECT_AGE} AND not referenced by any `Asset` row:
 *   - a reference is any row's `rehostedUrl` or `url` equal to the object's public URL, in ANY workbook. `url`
 *     counts because Notion pulls index hot-linked bucket URLs into it, so a live folder that hot-links a file
 *     keeps it. A hot-link in an external service with no Scratch row behind it does NOT keep a file: its
 *     workbook or folder was deliberately deleted, and bucket versioning keeps the file recoverable;
 *   - each delete is guarded by the generation it was listed at, so an object re-uploaded since is left alone,
 *     and it deletes only the live object, which versioning keeps as a recoverable noncurrent version.
 *
 * Safety:
 *   - deletes happen only while the fail-closed {@link SystemFeatureFlag.REHOSTED_ASSET_REAPER_DELETES_ENABLED}
 *     flag is on; otherwise the sweep is a dry run that logs exactly what it would delete;
 *   - it runs only in Cloud Run, or locally with `REHOSTED_ASSET_REAPER_ALLOW_LOCAL=true`, because a local
 *     database pointed at a shared bucket knows none of that environment's references;
 *   - it aborts without deleting anything if any `rehostedUrl` is not under its own workbook's prefix in this
 *     bucket (bucket renamed or URL format changed — every object would otherwise look unreferenced), and
 *     aborts on any database or listing error rather than treating a failed query as "no references";
 *   - it selects at most {@link MAX_REHOSTED_ASSET_OBJECTS_SELECTED_FOR_REAPING_PER_SWEEP} objects per sweep and
 *     aborts after {@link MAX_CONSECUTIVE_FAILED_REHOSTED_ASSET_DELETES} failed deletes in a row.
 * Idempotent and non-fatal per the cron conventions in this dir's CLAUDE.md.
 */
@Injectable()
export class RehostedAssetReaperService {
  constructor(
    private readonly db: DbService,
    private readonly objectStorage: ObjectStorageService,
    private readonly config: ScratchConfigService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
    private readonly experimentsService: ExperimentsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async reapUnreferencedRehostedAssetObjects(): Promise<void> {
    WSLogger.info({ source: LOG_SOURCE, message: 'Waking up, starting rehosted-asset reaper sweep' });

    if (!this.objectStorage.isConfigured()) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'Rehosted-asset reaper sweep skipped: GCS_ASSET_BUCKET is not configured',
      });
      return;
    }
    if (
      !ScratchConfigService.isRunningInCloudRun() &&
      !this.config.isRehostedAssetReaperAllowedToRunOutsideCloudRun()
    ) {
      WSLogger.info({
        source: LOG_SOURCE,
        message:
          'Rehosted-asset reaper sweep skipped: not running in Cloud Run and REHOSTED_ASSET_REAPER_ALLOW_LOCAL is not set',
      });
      return;
    }

    const sweepState: RehostedAssetReaperSweepState = {
      deletesEnabled: false,
      publicUrlPrefix: '',
      objectsCreatedBeforeThisAreOldEnoughToReap: REHOSTED_ASSET_REAP_MIN_OBJECT_AGE.inPast(),
      consecutiveFailedDeletes: 0,
      workbookKeyPrefixesScanned: 0,
      nonWorkbookKeyPrefixesSkipped: 0,
      perSweepSelectionCapReached: false,
      objectTallies: createEmptyRehostedAssetObjectTallies(),
    };

    try {
      sweepState.deletesEnabled = await this.experimentsService.getBooleanFlag(
        SystemFeatureFlag.REHOSTED_ASSET_REAPER_DELETES_ENABLED,
        false,
      );
      sweepState.publicUrlPrefix = this.objectStorage.buildPublicUrlPrefixForAssetBucket();
      await this.assertEveryRehostedUrlIsUnderItsOwnWorkbookKeyPrefix(sweepState.publicUrlPrefix);

      const workbookKeyPrefixes = await this.objectStorage.listWorkbookKeyPrefixesInAssetBucket();
      for (const workbookKeyPrefix of workbookKeyPrefixes) {
        if (
          sweepState.objectTallies.objectsSelectedForReaping >=
          MAX_REHOSTED_ASSET_OBJECTS_SELECTED_FOR_REAPING_PER_SWEEP
        ) {
          sweepState.perSweepSelectionCapReached = true;
        }
        if (sweepState.perSweepSelectionCapReached) {
          break;
        }
        if (!isWorkbookKeyPrefix(workbookKeyPrefix)) {
          sweepState.nonWorkbookKeyPrefixesSkipped += 1;
          continue;
        }
        sweepState.workbookKeyPrefixesScanned += 1;
        await this.reapWorkbookKeyPrefix(workbookKeyPrefix, sweepState);
      }
    } catch (error) {
      this.metricsService.logValue(CustomMetric.REHOSTED_ASSET_REAPER_SWEEP_ABORTED, 1);
      WSLogger.error({
        source: LOG_SOURCE,
        message: 'Rehosted-asset reaper sweep aborted; nothing further was deleted this run',
        error,
        ...summarizeSweepStateForLog(sweepState),
      });
      return;
    }

    const { objectTallies } = sweepState;
    WSLogger.info({
      source: LOG_SOURCE,
      message:
        `Rehosted-asset reaper sweep complete (${sweepState.deletesEnabled ? 'deletes enabled' : 'dry run'}; ` +
        `${sweepState.workbookKeyPrefixesScanned} workbook prefixes scanned, ` +
        `${sweepState.nonWorkbookKeyPrefixesSkipped} other prefixes skipped; ` +
        `${objectTallies.objectsScanned} objects scanned, ${objectTallies.objectsKeptAsReferenced} referenced, ` +
        `${objectTallies.objectsKeptAsTooYoung} too young, ${objectTallies.objectsSelectedForReaping} selected for reaping, ` +
        `${objectTallies.objectsReaped} reaped, ${objectTallies.objectsAlreadyGone} already gone, ` +
        `${objectTallies.objectsChangedSinceListed} changed since listed, ${objectTallies.objectsFailedToReap} failed` +
        `${sweepState.perSweepSelectionCapReached ? '; per-sweep cap reached, the rest wait for the next run' : ''}).`,
      ...summarizeSweepStateForLog(sweepState),
    });
  }

  /**
   * Abort the sweep unless every `Asset.rehostedUrl` is `<publicUrlPrefix>v1/<its own workbookId>/…`. Rehosting
   * keys objects by the asset's own workbook and sync copies never leave their workbook, so this holds by
   * construction. If it ever doesn't (the bucket was renamed or relocated, or the public-URL format changed),
   * stored URLs no longer match the objects the sweep lists, every object would look unreferenced, and the
   * sweep must not delete anything.
   */
  private async assertEveryRehostedUrlIsUnderItsOwnWorkbookKeyPrefix(publicUrlPrefix: string): Promise<void> {
    const rehostedUrlsOutsideTheirOwnWorkbookKeyPrefixCount = await countRehostedUrlsOutsideTheirOwnWorkbookKeyPrefix(
      this.db,
      publicUrlPrefix,
    );
    if (rehostedUrlsOutsideTheirOwnWorkbookKeyPrefixCount > 0) {
      throw new Error(
        `${rehostedUrlsOutsideTheirOwnWorkbookKeyPrefixCount} Asset.rehostedUrl values are not under ` +
          `${publicUrlPrefix}${REHOSTED_ASSET_OBJECT_KEY_ROOT_PREFIX}<their workbookId>/ — the bucket or the public ` +
          'URL format changed, so stored URLs no longer match the listed objects. Refusing to reap until they are reconciled.',
      );
    }
  }

  /** List, match, and reap one `v1/{workbookId}/` prefix, adding its tallies to the sweep's. */
  private async reapWorkbookKeyPrefix(
    workbookKeyPrefix: string,
    sweepState: RehostedAssetReaperSweepState,
  ): Promise<void> {
    const prefixTallies = createEmptyRehostedAssetObjectTallies();
    try {
      // List first, then load references: the reference snapshot is then as fresh as possible when deletes
      // start, and an object re-uploaded after the listing is protected by the generation precondition.
      const objectsOldEnoughToReap: RehostedAssetObjectToReap[] = [];
      for await (const listedObject of this.objectStorage.listLiveObjectsInAssetBucketWithKeyPrefix(
        workbookKeyPrefix,
      )) {
        prefixTallies.objectsScanned += 1;
        if (
          listedObject.timeCreatedOrNull === null ||
          listedObject.generationOrNull === null ||
          listedObject.timeCreatedOrNull >= sweepState.objectsCreatedBeforeThisAreOldEnoughToReap
        ) {
          prefixTallies.objectsKeptAsTooYoung += 1;
          continue;
        }
        objectsOldEnoughToReap.push({ key: listedObject.key, generation: listedObject.generationOrNull });
      }
      if (objectsOldEnoughToReap.length === 0) {
        return;
      }

      const referencedPublicUrls = await loadAssetUrlsReferencingPublicUrlPrefix(
        this.db,
        `${sweepState.publicUrlPrefix}${workbookKeyPrefix}`,
      );
      const unreferencedObjectsOldEnoughToReap = objectsOldEnoughToReap.filter(
        (objectToReap) => !referencedPublicUrls.has(`${sweepState.publicUrlPrefix}${objectToReap.key}`),
      );
      prefixTallies.objectsKeptAsReferenced +=
        objectsOldEnoughToReap.length - unreferencedObjectsOldEnoughToReap.length;

      const remainingSelectionsInSweep =
        MAX_REHOSTED_ASSET_OBJECTS_SELECTED_FOR_REAPING_PER_SWEEP - sweepState.objectTallies.objectsSelectedForReaping;
      if (unreferencedObjectsOldEnoughToReap.length > remainingSelectionsInSweep) {
        sweepState.perSweepSelectionCapReached = true;
      }
      const objectsSelectedForReaping = unreferencedObjectsOldEnoughToReap.slice(0, remainingSelectionsInSweep);

      for (const objectsToReapTogether of chunk(objectsSelectedForReaping, REHOSTED_ASSET_DELETE_CONCURRENCY)) {
        prefixTallies.objectsSelectedForReaping += objectsToReapTogether.length;
        if (!sweepState.deletesEnabled) {
          WSLogger.info({
            source: LOG_SOURCE,
            message: `Dry run: would reap ${objectsToReapTogether.length} unreferenced rehosted asset objects (REHOSTED_ASSET_REAPER_DELETES_ENABLED is off)`,
            workbookKeyPrefix,
            objectsWouldReap: objectsToReapTogether,
          });
          continue;
        }
        await this.reapObjectsTogether(objectsToReapTogether, workbookKeyPrefix, sweepState, prefixTallies);
      }
    } finally {
      addRehostedAssetObjectTallies(sweepState.objectTallies, prefixTallies);
      if (prefixTallies.objectsScanned > 0) {
        WSLogger.info({
          source: LOG_SOURCE,
          message: `Rehosted-asset reaper finished prefix ${workbookKeyPrefix}`,
          workbookKeyPrefix,
          deletesEnabled: sweepState.deletesEnabled,
          ...prefixTallies,
        });
      }
    }
  }

  /** Delete one chunk of objects concurrently, then tally the outcomes in order. */
  private async reapObjectsTogether(
    objectsToReapTogether: RehostedAssetObjectToReap[],
    workbookKeyPrefix: string,
    sweepState: RehostedAssetReaperSweepState,
    prefixTallies: RehostedAssetObjectTallies,
  ): Promise<void> {
    const reapOutcomes = await Promise.all(objectsToReapTogether.map((objectToReap) => this.reapObject(objectToReap)));

    const objectsReapedTogether: RehostedAssetObjectToReap[] = [];
    reapOutcomes.forEach((reapOutcome, objectIndex) => {
      switch (reapOutcome) {
        case 'deleted':
          prefixTallies.objectsReaped += 1;
          objectsReapedTogether.push(objectsToReapTogether[objectIndex]);
          break;
        case 'already-gone':
          prefixTallies.objectsAlreadyGone += 1;
          break;
        case 'changed-since-listed':
          prefixTallies.objectsChangedSinceListed += 1;
          break;
        case 'failed':
          prefixTallies.objectsFailedToReap += 1;
          break;
        default:
          assertUnreachable(reapOutcome);
      }
      sweepState.consecutiveFailedDeletes = reapOutcome === 'failed' ? sweepState.consecutiveFailedDeletes + 1 : 0;
    });

    if (objectsReapedTogether.length > 0) {
      // The exact keys and generations, so any of them can be restored from its noncurrent version.
      WSLogger.info({
        source: LOG_SOURCE,
        message: `Reaped ${objectsReapedTogether.length} unreferenced rehosted asset objects`,
        workbookKeyPrefix,
        objectsReaped: objectsReapedTogether,
      });
    }
    if (sweepState.consecutiveFailedDeletes >= MAX_CONSECUTIVE_FAILED_REHOSTED_ASSET_DELETES) {
      throw new Error(
        `${sweepState.consecutiveFailedDeletes} rehosted asset object deletes failed in a row; aborting the sweep`,
      );
    }
  }

  /** Delete one object; non-fatal — a failure is logged and reported as `'failed'`. */
  private async reapObject(objectToReap: RehostedAssetObjectToReap): Promise<RehostedAssetObjectReapOutcome> {
    try {
      const deleteOutcome = await this.objectStorage.deleteLiveObjectFromAssetBucketIfGenerationMatches(
        objectToReap.key,
        objectToReap.generation,
      );
      if (deleteOutcome === 'deleted') {
        this.metricsService.logValue(CustomMetric.REHOSTED_ASSET_OBJECT_REAPED, 1);
      }
      return deleteOutcome;
    } catch (error) {
      this.metricsService.logValue(CustomMetric.REHOSTED_ASSET_OBJECT_REAP_FAILED, 1);
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to reap rehosted asset object',
        key: objectToReap.key,
        generation: objectToReap.generation,
        error,
      });
      return 'failed';
    }
  }
}

/**
 * How many `Asset.rehostedUrl` values are NOT under `<publicUrlPrefix>v1/<their own workbookId>/` — the drift
 * tripwire's count, which must be 0 before a sweep may delete anything. `starts_with` (not LIKE) so the `_` in
 * workbook ids is matched literally.
 */
export async function countRehostedUrlsOutsideTheirOwnWorkbookKeyPrefix(
  db: DbService,
  publicUrlPrefix: string,
): Promise<number> {
  const publicUrlPrefixOfKeyRoot = `${publicUrlPrefix}${REHOSTED_ASSET_OBJECT_KEY_ROOT_PREFIX}`;
  const [tripwireRow] = await db.client.$queryRaw<{ rehostedUrlsOutsideTheirOwnWorkbookKeyPrefix: number }[]>`
    SELECT COUNT(*)::int AS "rehostedUrlsOutsideTheirOwnWorkbookKeyPrefix"
    FROM "Asset"
    WHERE "rehostedUrl" IS NOT NULL
      AND NOT starts_with("rehostedUrl", ${publicUrlPrefixOfKeyRoot}::text || "workbookId" || '/')`;
  if (!tripwireRow) {
    throw new Error('Rehosted-asset reaper tripwire query returned no row');
  }
  return tripwireRow.rehostedUrlsOutsideTheirOwnWorkbookKeyPrefix;
}

/**
 * Every `Asset.rehostedUrl` and `Asset.url` under `publicUrlPrefixToMatch`, from ANY workbook, with query strings
 * and fragments stripped so a hot-linked `url` matches the bare object URL. Prisma's `startsWith` may read the
 * `_` in `wkb_` as a LIKE wildcard; that can only over-match, which keeps more files, so it is safe.
 */
export async function loadAssetUrlsReferencingPublicUrlPrefix(
  db: DbService,
  publicUrlPrefixToMatch: string,
): Promise<Set<string>> {
  const [assetsWithMatchingRehostedUrl, assetsWithMatchingUrl] = await Promise.all([
    db.client.asset.findMany({
      where: { rehostedUrl: { startsWith: publicUrlPrefixToMatch } },
      select: { rehostedUrl: true },
      distinct: ['rehostedUrl'],
    }),
    db.client.asset.findMany({
      where: { url: { startsWith: publicUrlPrefixToMatch } },
      select: { url: true },
      distinct: ['url'],
    }),
  ]);

  const referencedPublicUrls = new Set<string>();
  for (const { rehostedUrl } of assetsWithMatchingRehostedUrl) {
    if (rehostedUrl !== null) {
      referencedPublicUrls.add(stripQueryStringAndFragment(rehostedUrl));
    }
  }
  for (const { url } of assetsWithMatchingUrl) {
    if (url !== null) {
      referencedPublicUrls.add(stripQueryStringAndFragment(url));
    }
  }
  return referencedPublicUrls;
}

/** True for a `v1/{workbookId}/` prefix; anything else under the key root is never reaped. */
function isWorkbookKeyPrefix(keyPrefix: string): boolean {
  if (!keyPrefix.startsWith(REHOSTED_ASSET_OBJECT_KEY_ROOT_PREFIX) || !keyPrefix.endsWith('/')) {
    return false;
  }
  return isWorkbookId(keyPrefix.slice(REHOSTED_ASSET_OBJECT_KEY_ROOT_PREFIX.length, -1));
}

function stripQueryStringAndFragment(url: string): string {
  return url.split(/[?#]/, 1)[0];
}

function createEmptyRehostedAssetObjectTallies(): RehostedAssetObjectTallies {
  return {
    objectsScanned: 0,
    objectsKeptAsReferenced: 0,
    objectsKeptAsTooYoung: 0,
    objectsSelectedForReaping: 0,
    objectsReaped: 0,
    objectsAlreadyGone: 0,
    objectsChangedSinceListed: 0,
    objectsFailedToReap: 0,
  };
}

function addRehostedAssetObjectTallies(
  sweepObjectTallies: RehostedAssetObjectTallies,
  prefixObjectTallies: RehostedAssetObjectTallies,
): void {
  sweepObjectTallies.objectsScanned += prefixObjectTallies.objectsScanned;
  sweepObjectTallies.objectsKeptAsReferenced += prefixObjectTallies.objectsKeptAsReferenced;
  sweepObjectTallies.objectsKeptAsTooYoung += prefixObjectTallies.objectsKeptAsTooYoung;
  sweepObjectTallies.objectsSelectedForReaping += prefixObjectTallies.objectsSelectedForReaping;
  sweepObjectTallies.objectsReaped += prefixObjectTallies.objectsReaped;
  sweepObjectTallies.objectsAlreadyGone += prefixObjectTallies.objectsAlreadyGone;
  sweepObjectTallies.objectsChangedSinceListed += prefixObjectTallies.objectsChangedSinceListed;
  sweepObjectTallies.objectsFailedToReap += prefixObjectTallies.objectsFailedToReap;
}

function summarizeSweepStateForLog(sweepState: RehostedAssetReaperSweepState) {
  return {
    deletesEnabled: sweepState.deletesEnabled,
    workbookKeyPrefixesScanned: sweepState.workbookKeyPrefixesScanned,
    nonWorkbookKeyPrefixesSkipped: sweepState.nonWorkbookKeyPrefixesSkipped,
    perSweepSelectionCapReached: sweepState.perSweepSelectionCapReached,
    ...sweepState.objectTallies,
  };
}
