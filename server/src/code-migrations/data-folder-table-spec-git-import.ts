import type { Prisma, PrismaClient } from '@prisma/client';
import type { MigrationResultSummaryRow } from '@spinner/shared-types';
import { WSLogger } from 'src/logger';
import { assertUnreachable } from 'src/utils/asserts';
import type {
  ConnectedTableSpecLocation,
  DataFolderTableSpecGitDivergenceOutcome,
  DataFolderTableSpecGitImportOutcome,
  DataFolderTableSpecStoreService,
} from 'src/workbook/table-spec-store/data-folder-table-spec-store.service';

export const DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_MIGRATION_NAME = 'data-folder-table-spec-git-import';
export const DATA_FOLDER_TABLE_SPEC_GIT_DIVERGENCE_REPORT_MIGRATION_NAME =
  'data-folder-table-spec-git-divergence-report';

/** Folders read from Postgres per page of the id walk. */
const DATA_FOLDER_PAGE_SIZE = 100;

/** Folders whose git copies are read at once (read-only scratch-git calls). */
const MAXIMUM_CONCURRENT_FOLDER_VISITS = 10;

/**
 * In `qty` mode a run stops after examining this many folders per requested folder, so a long run of folders that
 * can't be imported (never pulled, or a failed first write) can't turn one synchronous request into a full scan.
 */
const MAXIMUM_FOLDERS_EXAMINED_PER_REQUESTED_FOLDER = 10;

/** Connector-linked folders with a path in a workbook that isn't pending deletion: the only folders with a spec. */
const LINKED_DATA_FOLDER_WITH_PATH_WHERE_CLAUSE: Prisma.DataFolderWhereInput = {
  connectorAccountId: { not: null },
  path: { not: null },
  workbook: { isPendingDelete: false },
};

/**
 * Import candidates: linked folders that point at a remote table (`tableId` set) and have no `DataFolderTableSpec`
 * row yet. Also defines `remainingCount`. A folder with no `tableId` can never have a spec — every spec write (create
 * folder, schema refresh, publish build, and pull) fetches it by `tableId` — so counting it would keep
 * `remainingCount` from ever reaching the "only real gaps are left" state the fallback's removal waits for.
 */
const DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_CANDIDATE_WHERE_CLAUSE: Prisma.DataFolderWhereInput = {
  ...LINKED_DATA_FOLDER_WITH_PATH_WHERE_CLAUSE,
  tableId: { isEmpty: false },
  storedTableSpecRow: { is: null },
};

/** Divergence-report candidates: linked folders that DO have a row. */
const DATA_FOLDER_TABLE_SPEC_GIT_DIVERGENCE_CANDIDATE_WHERE_CLAUSE: Prisma.DataFolderWhereInput = {
  ...LINKED_DATA_FOLDER_WITH_PATH_WHERE_CLAUSE,
  storedTableSpecRow: { isNot: null },
};

/** How much of a run's candidate set to walk. */
export type DataFolderWalkScope =
  /** Every candidate in these workbooks, in id order. */
  | { kind: 'workbooks'; workbookIds: string[] }
  /**
   * Walk candidates in id order starting AFTER `startAfterDataFolderId` and wrapping around to the beginning (no
   * start ⇒ from the beginning), stopping once `maximumFoldersToCount` visits counted toward the limit or
   * 10 × that many folders were examined. The controller picks a random start each run, so folders that can never
   * be processed can't pin every run to the same stretch of ids.
   */
  | { kind: 'limited'; maximumFoldersToCount: number; startAfterDataFolderId: string | undefined };

interface DataFolderWalkResult {
  examinedFolderCount: number;
  /** Candidates the walk never reached because it stopped at its limit or examination cap (0 = it saw them all). */
  unreachedCandidateFolderCount: number;
}

/**
 * Walks the folders matching `candidateWhereClause` by id (keyset pages, a few concurrent visits at a time) and
 * calls `visitFolder` for each. `visitFolder` returns whether the folder counts toward a `limited` scope's limit;
 * no more visits are started than the limit still allows, so the limit is an exact upper bound.
 */
async function walkDataFoldersInIdOrder(
  prisma: PrismaClient,
  candidateWhereClause: Prisma.DataFolderWhereInput,
  scope: DataFolderWalkScope,
  visitFolder: (location: ConnectedTableSpecLocation) => Promise<{ countsTowardLimit: boolean }>,
): Promise<DataFolderWalkResult> {
  const workbookScopedWhereClause: Prisma.DataFolderWhereInput =
    scope.kind === 'workbooks'
      ? { ...candidateWhereClause, workbookId: { in: scope.workbookIds } }
      : candidateWhereClause;
  const maximumFoldersToCount = scope.kind === 'limited' ? scope.maximumFoldersToCount : Number.POSITIVE_INFINITY;
  const maximumFoldersToExamine = maximumFoldersToCount * MAXIMUM_FOLDERS_EXAMINED_PER_REQUESTED_FOLDER;
  const startAfterDataFolderId = scope.kind === 'limited' ? scope.startAfterDataFolderId : undefined;

  // The id ranges to walk, in order: after the start, then (wrapping around) up to and including the start.
  const idRangesToWalk: Array<{ idGreaterThan?: string; idAtMost?: string }> =
    startAfterDataFolderId === undefined
      ? [{}]
      : [{ idGreaterThan: startAfterDataFolderId }, { idAtMost: startAfterDataFolderId }];

  let examinedFolderCount = 0;
  let countedFolderCount = 0;
  const walkMayContinue = (): boolean =>
    countedFolderCount < maximumFoldersToCount && examinedFolderCount < maximumFoldersToExamine;

  const idFilterForRange = (
    range: { idGreaterThan?: string; idAtMost?: string },
    lastExaminedIdInRange: string | undefined,
  ): Prisma.StringFilter | undefined => {
    const idGreaterThan = lastExaminedIdInRange ?? range.idGreaterThan;
    if (idGreaterThan === undefined && range.idAtMost === undefined) return undefined;
    return {
      ...(idGreaterThan !== undefined ? { gt: idGreaterThan } : {}),
      ...(range.idAtMost !== undefined ? { lte: range.idAtMost } : {}),
    };
  };

  for (let rangeIndex = 0; rangeIndex < idRangesToWalk.length; rangeIndex++) {
    const range = idRangesToWalk[rangeIndex];
    let lastExaminedIdInRange: string | undefined;
    let rangeExhausted = false;

    while (!rangeExhausted && walkMayContinue()) {
      const idFilter = idFilterForRange(range, lastExaminedIdInRange);
      const folderPage = await prisma.dataFolder.findMany({
        where: { ...workbookScopedWhereClause, ...(idFilter ? { id: idFilter } : {}) },
        orderBy: { id: 'asc' },
        take: DATA_FOLDER_PAGE_SIZE,
        select: { id: true, connectorAccountId: true, path: true },
      });
      if (folderPage.length === 0) {
        rangeExhausted = true;
        break;
      }

      let nextIndexInPage = 0;
      while (nextIndexInPage < folderPage.length && walkMayContinue()) {
        const concurrentBatchSize = Math.min(
          MAXIMUM_CONCURRENT_FOLDER_VISITS,
          maximumFoldersToCount - countedFolderCount,
          maximumFoldersToExamine - examinedFolderCount,
          folderPage.length - nextIndexInPage,
        );
        const concurrentBatch = folderPage.slice(nextIndexInPage, nextIndexInPage + concurrentBatchSize);
        nextIndexInPage += concurrentBatch.length;
        lastExaminedIdInRange = concurrentBatch[concurrentBatch.length - 1].id;

        await Promise.all(
          concurrentBatch.map(async ({ id: dataFolderId, connectorAccountId, path: folderPath }) => {
            examinedFolderCount++;
            if (!connectorAccountId || !folderPath) return; // excluded by the where clause; narrows the types
            const { countsTowardLimit } = await visitFolder({ dataFolderId, connectorAccountId, folderPath });
            if (countsTowardLimit) countedFolderCount++;
          }),
        );
      }
      if (nextIndexInPage === folderPage.length && folderPage.length < DATA_FOLDER_PAGE_SIZE) rangeExhausted = true;
    }

    if (!rangeExhausted) {
      // Stopped part-way: count what this range (past the last examined id) and every later range still hold.
      let unreachedCandidateFolderCount = 0;
      for (let unwalkedRangeIndex = rangeIndex; unwalkedRangeIndex < idRangesToWalk.length; unwalkedRangeIndex++) {
        const unwalkedIdFilter = idFilterForRange(
          idRangesToWalk[unwalkedRangeIndex],
          unwalkedRangeIndex === rangeIndex ? lastExaminedIdInRange : undefined,
        );
        unreachedCandidateFolderCount += await prisma.dataFolder.count({
          where: { ...workbookScopedWhereClause, ...(unwalkedIdFilter ? { id: unwalkedIdFilter } : {}) },
        });
      }
      return { examinedFolderCount, unreachedCandidateFolderCount };
    }
  }
  return { examinedFolderCount, unreachedCandidateFolderCount: 0 };
}

/**
 * A random candidate id to start a `qty` run after (the walk wraps around), so folders that can never be imported
 * don't pin every run to the same stretch of ids. `randomFraction` is in [0, 1) — the caller passes
 * `Math.random()`. Undefined when there are no candidates.
 */
export async function pickRandomDataFolderIdToStartWalkAfter(
  prisma: PrismaClient,
  migrationName: string,
  randomFraction: number,
): Promise<string | undefined> {
  const candidateWhereClause =
    migrationName === DATA_FOLDER_TABLE_SPEC_GIT_DIVERGENCE_REPORT_MIGRATION_NAME
      ? DATA_FOLDER_TABLE_SPEC_GIT_DIVERGENCE_CANDIDATE_WHERE_CLAUSE
      : DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_CANDIDATE_WHERE_CLAUSE;
  const candidateFolderCount = await prisma.dataFolder.count({ where: candidateWhereClause });
  if (candidateFolderCount === 0) return undefined;
  const startFolder = await prisma.dataFolder.findFirst({
    where: candidateWhereClause,
    orderBy: { id: 'asc' },
    skip: Math.min(candidateFolderCount - 1, Math.floor(randomFraction * candidateFolderCount)),
    select: { id: true },
  });
  return startFolder?.id;
}

// =====================================================================================================
// data-folder-table-spec-git-import
// =====================================================================================================

export interface DataFolderTableSpecGitImportSummary {
  examinedFolderCount: number;
  importedFolderCount: number;
  importedFolderWithDefaultViewCount: number;
  rowAlreadyPresentFolderCount: number;
  noTableSpecInGitFolderCount: number;
  invalidTableSpecInGitFolderCount: number;
  connectionHasNoRepoFolderCount: number;
  gitReadFailedFolderCount: number;
  deletedDuringRunFolderCount: number;
  erroredFolderCount: number;
  unreachedCandidateFolderCount: number;
}

export interface DataFolderTableSpecGitImportRunResult {
  /** Folders imported, or (dry-run) folders that would be imported. */
  importedDataFolderIds: string[];
  summary: DataFolderTableSpecGitImportSummary;
  /** Candidates left after this run, across all workbooks. */
  remainingCandidateFolderCount: number;
}

/**
 * DEV-12616: copies each linked folder's table spec and default view from git `main`
 * (`.scratch/{folder}/schema.json`, or the legacy `{folder}/.schema.json`, plus `views/default.json`) into its
 * `DataFolderTableSpec` row, for folders that have no row yet. Reads fall back to git for those folders; this
 * drains the long tail so the fallback can be removed.
 *
 * Insert-if-absent: a pull, schema refresh, or publish build that writes the folder meanwhile always wins. Never
 * writes git, so it needs no connection quiesce. A folder with nothing in git (never pulled), invalid content, no
 * repo, or a failed git read gets no row and stays a candidate.
 */
export async function runDataFolderTableSpecGitImport(
  dependencies: {
    prisma: PrismaClient;
    dataFolderTableSpecStore: Pick<DataFolderTableSpecStoreService, 'importTableSpecFromGitIfAbsent'>;
  },
  options: { scope: DataFolderWalkScope; dryRun: boolean },
): Promise<DataFolderTableSpecGitImportRunResult> {
  const { prisma, dataFolderTableSpecStore } = dependencies;
  const { scope, dryRun } = options;

  const summary: DataFolderTableSpecGitImportSummary = {
    examinedFolderCount: 0,
    importedFolderCount: 0,
    importedFolderWithDefaultViewCount: 0,
    rowAlreadyPresentFolderCount: 0,
    noTableSpecInGitFolderCount: 0,
    invalidTableSpecInGitFolderCount: 0,
    connectionHasNoRepoFolderCount: 0,
    gitReadFailedFolderCount: 0,
    deletedDuringRunFolderCount: 0,
    erroredFolderCount: 0,
    unreachedCandidateFolderCount: 0,
  };
  const importedDataFolderIds: string[] = [];

  const walkResult = await walkDataFoldersInIdOrder(
    prisma,
    DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_CANDIDATE_WHERE_CLAUSE,
    scope,
    async (location) => {
      let importOutcome: DataFolderTableSpecGitImportOutcome | { kind: 'errored'; error: unknown };
      try {
        importOutcome = await dataFolderTableSpecStore.importTableSpecFromGitIfAbsent(location, { dryRun });
      } catch (error) {
        importOutcome = { kind: 'errored', error };
      }
      const imported = tallyImportOutcome(summary, location, importOutcome);
      if (imported) importedDataFolderIds.push(location.dataFolderId);
      return { countsTowardLimit: imported };
    },
  );
  summary.examinedFolderCount = walkResult.examinedFolderCount;
  summary.unreachedCandidateFolderCount = walkResult.unreachedCandidateFolderCount;

  const remainingCandidateFolderCount = await prisma.dataFolder.count({
    where: DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_CANDIDATE_WHERE_CLAUSE,
  });

  WSLogger.info({
    source: 'runDataFolderTableSpecGitImport',
    message: `${DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_MIGRATION_NAME} complete`,
    dryRun,
    summary,
    remainingCandidateFolderCount,
  });

  return { importedDataFolderIds, summary, remainingCandidateFolderCount };
}

/** Tallies one folder's outcome; true when it was imported (or would be, on a dry-run). */
function tallyImportOutcome(
  summary: DataFolderTableSpecGitImportSummary,
  location: ConnectedTableSpecLocation,
  importOutcome: DataFolderTableSpecGitImportOutcome | { kind: 'errored'; error: unknown },
): boolean {
  const { dataFolderId, folderPath } = location;
  switch (importOutcome.kind) {
    case 'imported':
    case 'would-import':
      summary.importedFolderCount++;
      if (importOutcome.importedDefaultView) summary.importedFolderWithDefaultViewCount++;
      return true;
    case 'row-already-present':
      summary.rowAlreadyPresentFolderCount++;
      return false;
    case 'no-table-spec-in-git':
      summary.noTableSpecInGitFolderCount++;
      return false;
    case 'invalid-table-spec-in-git':
      summary.invalidTableSpecInGitFolderCount++;
      WSLogger.warn({
        source: 'runDataFolderTableSpecGitImport',
        message: `Skipped a folder whose git table spec is invalid: ${importOutcome.reason}`,
        dataFolderId,
        folderPath,
      });
      return false;
    case 'connection-has-no-repo':
      summary.connectionHasNoRepoFolderCount++;
      WSLogger.warn({
        source: 'runDataFolderTableSpecGitImport',
        message: "Skipped a folder whose connection has no git repo; it can't be imported",
        dataFolderId,
        folderPath,
        error: importOutcome.error,
      });
      return false;
    case 'git-read-failed':
      summary.gitReadFailedFolderCount++;
      WSLogger.warn({
        source: 'runDataFolderTableSpecGitImport',
        message: 'Could not read the folder from git; it stays a candidate for the next run',
        dataFolderId,
        folderPath,
        error: importOutcome.error,
      });
      return false;
    case 'data-folder-deleted':
      summary.deletedDuringRunFolderCount++;
      return false;
    case 'errored':
      summary.erroredFolderCount++;
      WSLogger.error({
        source: 'runDataFolderTableSpecGitImport',
        message: 'Failed to import the folder table spec; it stays a candidate for the next run',
        dataFolderId,
        folderPath,
        error: importOutcome.error,
      });
      return false;
    default:
      return assertUnreachable(importOutcome);
  }
}

/** The admin UI's per-outcome breakdown for the import. */
export function buildDataFolderTableSpecGitImportSummaryRows(
  summary: DataFolderTableSpecGitImportSummary,
  dryRun: boolean,
): MigrationResultSummaryRow[] {
  return [
    { label: 'folders examined', count: summary.examinedFolderCount },
    {
      label: dryRun ? 'folders whose table spec would be imported' : 'folders whose table spec was imported',
      count: summary.importedFolderCount,
    },
    { label: 'of those, with a default view', count: summary.importedFolderWithDefaultViewCount },
    { label: 'folders that already had a row (a concurrent write won)', count: summary.rowAlreadyPresentFolderCount },
    {
      label: 'folders with no table spec in git (no row written; they stay candidates)',
      count: summary.noTableSpecInGitFolderCount,
    },
    {
      label: 'folders whose git table spec is invalid (no row written; investigate)',
      count: summary.invalidTableSpecInGitFolderCount,
    },
    {
      label: 'folders whose connection has no git repo (no row written; cannot be imported)',
      count: summary.connectionHasNoRepoFolderCount,
    },
    {
      label: 'folders whose git read failed (no row written; retried next run)',
      count: summary.gitReadFailedFolderCount,
    },
    { label: 'folders deleted during the run', count: summary.deletedDuringRunFolderCount },
    { label: 'folders errored (no row written; retried next run)', count: summary.erroredFolderCount },
    {
      label: 'candidates this run did not reach (it stopped at its qty or examination cap)',
      count: summary.unreachedCandidateFolderCount,
    },
  ];
}

// =====================================================================================================
// data-folder-table-spec-git-divergence-report
// =====================================================================================================

export interface DataFolderTableSpecGitDivergenceSummary {
  examinedFolderCount: number;
  matchingFolderCount: number;
  tableSpecDiffersFolderCount: number;
  onlyDefaultViewDiffersFolderCount: number;
  /**
   * DEV-13025: compared folders (matching or not) whose git `schema.json` bytes differ from the stored text, e.g.
   * only in `generatedAt`. Today's CLI caches hold the git bytes, so this is how many caches the first `scratchmd`
   * refresh from the server rewrites (each rewrite clears that folder's `enforce_schema` results).
   */
  tableSpecBytesDifferFolderCount: number;
  /** DEV-13025: the same, for `views/default.json` (including a view stored in only one place). */
  defaultViewBytesDifferFolderCount: number;
  noTableSpecInGitFolderCount: number;
  invalidTableSpecInGitFolderCount: number;
  connectionHasNoRepoFolderCount: number;
  gitReadFailedFolderCount: number;
  erroredFolderCount: number;
  unreachedCandidateFolderCount: number;
}

/**
 * DEV-12616, READ-ONLY: compares each linked folder's `DataFolderTableSpec` row with its git copy (ignoring
 * `generatedAt`) and lists the folders where they differ. While the git mirror is on they should match; a
 * difference means a write landed in only one place — a revision that predates the table wrote git only (a mixed
 * fleet during rollout, or a code rollback past DEV-12616), or a mirror write failed. Run it before turning on
 * TABLE_SPEC_POSTGRES_READS_ENABLED (and after any code rollback), and "Refresh Schema" (or re-pull) the listed
 * folders: that rewrites both from the connector. It never writes either side because which one is newer can't
 * be known from the two copies alone.
 */
export async function runDataFolderTableSpecGitDivergenceReport(
  dependencies: {
    prisma: PrismaClient;
    dataFolderTableSpecStore: Pick<DataFolderTableSpecStoreService, 'compareStoredRowWithGit'>;
  },
  options: { scope: DataFolderWalkScope },
): Promise<{ divergentDataFolderIds: string[]; summary: DataFolderTableSpecGitDivergenceSummary }> {
  const { prisma, dataFolderTableSpecStore } = dependencies;
  const summary: DataFolderTableSpecGitDivergenceSummary = {
    examinedFolderCount: 0,
    matchingFolderCount: 0,
    tableSpecDiffersFolderCount: 0,
    onlyDefaultViewDiffersFolderCount: 0,
    tableSpecBytesDifferFolderCount: 0,
    defaultViewBytesDifferFolderCount: 0,
    noTableSpecInGitFolderCount: 0,
    invalidTableSpecInGitFolderCount: 0,
    connectionHasNoRepoFolderCount: 0,
    gitReadFailedFolderCount: 0,
    erroredFolderCount: 0,
    unreachedCandidateFolderCount: 0,
  };
  const divergentDataFolderIds: string[] = [];

  const walkResult = await walkDataFoldersInIdOrder(
    prisma,
    DATA_FOLDER_TABLE_SPEC_GIT_DIVERGENCE_CANDIDATE_WHERE_CLAUSE,
    options.scope,
    async (location) => {
      let divergenceOutcome: DataFolderTableSpecGitDivergenceOutcome | { kind: 'errored'; error: unknown };
      try {
        divergenceOutcome = await dataFolderTableSpecStore.compareStoredRowWithGit(location);
      } catch (error) {
        divergenceOutcome = { kind: 'errored', error };
      }
      const differs = tallyDivergenceOutcome(summary, location, divergenceOutcome);
      if (differs) divergentDataFolderIds.push(location.dataFolderId);
      // Every compared folder counts toward `qty`: the report has no "useful subset" to stop at.
      return { countsTowardLimit: true };
    },
  );
  summary.examinedFolderCount = walkResult.examinedFolderCount;
  summary.unreachedCandidateFolderCount = walkResult.unreachedCandidateFolderCount;

  WSLogger.info({
    source: 'runDataFolderTableSpecGitDivergenceReport',
    message: `${DATA_FOLDER_TABLE_SPEC_GIT_DIVERGENCE_REPORT_MIGRATION_NAME} complete`,
    summary,
    divergentDataFolderIds,
  });
  return { divergentDataFolderIds, summary };
}

/** Tallies one folder's comparison; true when its row and git copy differ. */
function tallyDivergenceOutcome(
  summary: DataFolderTableSpecGitDivergenceSummary,
  location: ConnectedTableSpecLocation,
  divergenceOutcome: DataFolderTableSpecGitDivergenceOutcome | { kind: 'errored'; error: unknown },
): boolean {
  const { dataFolderId, folderPath } = location;
  if (divergenceOutcome.kind === 'matches' || divergenceOutcome.kind === 'differs') {
    if (divergenceOutcome.tableSpecBytesDiffer) summary.tableSpecBytesDifferFolderCount++;
    if (divergenceOutcome.defaultViewBytesDiffer) summary.defaultViewBytesDifferFolderCount++;
  }
  switch (divergenceOutcome.kind) {
    case 'matches':
      summary.matchingFolderCount++;
      return false;
    case 'differs':
      if (divergenceOutcome.tableSpecDiffers) summary.tableSpecDiffersFolderCount++;
      else summary.onlyDefaultViewDiffersFolderCount++;
      return true;
    case 'no-row':
      // Its row vanished between the page read and the comparison (the folder was deleted); nothing to compare.
      return false;
    case 'no-table-spec-in-git':
      summary.noTableSpecInGitFolderCount++;
      return false;
    case 'invalid-table-spec-in-git':
      summary.invalidTableSpecInGitFolderCount++;
      return false;
    case 'connection-has-no-repo':
      summary.connectionHasNoRepoFolderCount++;
      return false;
    case 'git-read-failed':
      summary.gitReadFailedFolderCount++;
      WSLogger.warn({
        source: 'runDataFolderTableSpecGitDivergenceReport',
        message: 'Could not read the folder from git to compare it',
        dataFolderId,
        folderPath,
        error: divergenceOutcome.error,
      });
      return false;
    case 'errored':
      summary.erroredFolderCount++;
      WSLogger.error({
        source: 'runDataFolderTableSpecGitDivergenceReport',
        message: 'Failed to compare the folder table spec with git',
        dataFolderId,
        folderPath,
        error: divergenceOutcome.error,
      });
      return false;
    default:
      return assertUnreachable(divergenceOutcome);
  }
}

/** The admin UI's per-outcome breakdown for the divergence report. */
export function buildDataFolderTableSpecGitDivergenceSummaryRows(
  summary: DataFolderTableSpecGitDivergenceSummary,
): MigrationResultSummaryRow[] {
  return [
    { label: 'folders compared', count: summary.examinedFolderCount },
    { label: 'folders whose row matches git', count: summary.matchingFolderCount },
    {
      label: 'folders whose table spec differs from git (Refresh Schema them; ids listed)',
      count: summary.tableSpecDiffersFolderCount,
    },
    {
      label: 'folders where only the default view differs (Refresh Schema them; ids listed)',
      count: summary.onlyDefaultViewDiffersFolderCount,
    },
    {
      label:
        'folders whose git schema.json bytes differ from the stored text (the first scratchmd refresh rewrites them)',
      count: summary.tableSpecBytesDifferFolderCount,
    },
    {
      label: 'folders whose git views/default.json bytes differ from the stored text',
      count: summary.defaultViewBytesDifferFolderCount,
    },
    { label: 'folders with no table spec in git', count: summary.noTableSpecInGitFolderCount },
    { label: 'folders whose git table spec is invalid', count: summary.invalidTableSpecInGitFolderCount },
    { label: 'folders whose connection has no git repo', count: summary.connectionHasNoRepoFolderCount },
    { label: 'folders whose git read failed (re-run)', count: summary.gitReadFailedFolderCount },
    { label: 'folders errored (re-run)', count: summary.erroredFolderCount },
    {
      label: 'folders this run did not reach (it stopped at its qty)',
      count: summary.unreachedCandidateFolderCount,
    },
  ];
}
