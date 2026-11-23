import type { PrismaClient } from '@prisma/client';
import type {
  DataFolderTableSpecGitDivergenceOutcome,
  DataFolderTableSpecGitImportOutcome,
} from 'src/workbook/table-spec-store/data-folder-table-spec-store.service';
import {
  buildDataFolderTableSpecGitDivergenceSummaryRows,
  buildDataFolderTableSpecGitImportSummaryRows,
  DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_MIGRATION_NAME,
  pickRandomDataFolderIdToStartWalkAfter,
  runDataFolderTableSpecGitDivergenceReport,
  runDataFolderTableSpecGitImport,
} from '../data-folder-table-spec-git-import';

type CandidateFolder = { id: string; connectorAccountId: string; path: string };
type IdFilter = { gt?: string; lte?: string };

function candidateFolders(count: number): CandidateFolder[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `dfd_${String(index).padStart(4, '0')}`,
    connectorAccountId: 'coa_1',
    path: `/Base/Table ${index}`,
  }));
}

function matchesIdFilter(folderId: string, idFilter: IdFilter | undefined): boolean {
  if (!idFilter) return true;
  if (idFilter.gt !== undefined && !(folderId > idFilter.gt)) return false;
  if (idFilter.lte !== undefined && !(folderId <= idFilter.lte)) return false;
  return true;
}

/**
 * A `prisma.dataFolder` fake over a fixed candidate list, honoring the walk's `id: { gt, lte }` keyset filters,
 * `take`, and `skip`, and recording every page query. `count` without an id filter answers `remainingCount`.
 */
function fakePrismaServingCandidates(allCandidateFolders: CandidateFolder[], remainingCandidateFolderCount?: number) {
  const findManyQueries: Array<{ where: { id?: IdFilter; workbookId?: unknown } }> = [];
  const countQueries: Array<{ where: { id?: IdFilter } }> = [];
  const prisma = {
    dataFolder: {
      findMany: jest.fn((query: { where: { id?: IdFilter; workbookId?: unknown }; take: number }) => {
        findManyQueries.push(query);
        return Promise.resolve(
          allCandidateFolders.filter((folder) => matchesIdFilter(folder.id, query.where.id)).slice(0, query.take),
        );
      }),
      findFirst: jest.fn((query: { skip: number }) => Promise.resolve(allCandidateFolders[query.skip] ?? null)),
      count: jest.fn((query: { where: { id?: IdFilter } }) => {
        countQueries.push(query);
        return Promise.resolve(
          query.where.id === undefined && remainingCandidateFolderCount !== undefined
            ? remainingCandidateFolderCount
            : allCandidateFolders.filter((folder) => matchesIdFilter(folder.id, query.where.id)).length,
        );
      }),
    },
  } as unknown as PrismaClient;
  return { prisma, findManyQueries, countQueries };
}

function fakeImportStore(
  outcomeForDataFolderId: (dataFolderId: string) => DataFolderTableSpecGitImportOutcome | Error,
) {
  return {
    importTableSpecFromGitIfAbsent: jest.fn(({ dataFolderId }: { dataFolderId: string }) => {
      const outcome = outcomeForDataFolderId(dataFolderId);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    }),
  };
}

describe('runDataFolderTableSpecGitImport', () => {
  it('imports exactly qty folders, then reports the candidates it did not reach', async () => {
    const { prisma } = fakePrismaServingCandidates(candidateFolders(250));
    const dataFolderTableSpecStore = fakeImportStore(() => ({ kind: 'imported', importedDefaultView: true }));

    const result = await runDataFolderTableSpecGitImport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'limited', maximumFoldersToCount: 13, startAfterDataFolderId: undefined }, dryRun: false },
    );

    expect(result.importedDataFolderIds).toHaveLength(13);
    expect(dataFolderTableSpecStore.importTableSpecFromGitIfAbsent).toHaveBeenCalledTimes(13);
    expect(result.summary.importedFolderWithDefaultViewCount).toBe(13);
    expect(result.summary.unreachedCandidateFolderCount).toBe(250 - 13);
  });

  it('starts after the given folder and wraps around to the beginning', async () => {
    const { prisma } = fakePrismaServingCandidates(candidateFolders(10));
    const visitedDataFolderIds: string[] = [];
    const dataFolderTableSpecStore = {
      importTableSpecFromGitIfAbsent: jest.fn(({ dataFolderId }: { dataFolderId: string }) => {
        visitedDataFolderIds.push(dataFolderId);
        return Promise.resolve<DataFolderTableSpecGitImportOutcome>({ kind: 'no-table-spec-in-git' });
      }),
    };

    const result = await runDataFolderTableSpecGitImport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'limited', maximumFoldersToCount: 5, startAfterDataFolderId: 'dfd_0006' }, dryRun: false },
    );

    expect(visitedDataFolderIds).toEqual(
      ['0007', '0008', '0009', '0000', '0001', '0002', '0003', '0004', '0005', '0006'].map((suffix) => `dfd_${suffix}`),
    );
    expect(result.summary.examinedFolderCount).toBe(10);
    expect(result.summary.unreachedCandidateFolderCount).toBe(0);
  });

  it('does not stall behind folders with nothing in git: it pages past them by id', async () => {
    // The 150 lowest ids have no spec in git; only the later ones can be imported.
    const { prisma, findManyQueries } = fakePrismaServingCandidates(candidateFolders(200));
    const dataFolderTableSpecStore = fakeImportStore((dataFolderId) =>
      dataFolderId < 'dfd_0150' ? { kind: 'no-table-spec-in-git' } : { kind: 'imported', importedDefaultView: false },
    );

    const result = await runDataFolderTableSpecGitImport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'limited', maximumFoldersToCount: 20, startAfterDataFolderId: undefined }, dryRun: false },
    );

    expect(result.summary.noTableSpecInGitFolderCount).toBe(150);
    expect(result.summary.importedFolderCount).toBe(20);
    expect(result.importedDataFolderIds[0]).toBe('dfd_0150');
    expect(findManyQueries[1].where.id).toEqual({ gt: 'dfd_0099' });
  });

  it('caps the folders examined at 10 × qty', async () => {
    const { prisma } = fakePrismaServingCandidates(candidateFolders(500));
    const dataFolderTableSpecStore = fakeImportStore(() => ({ kind: 'no-table-spec-in-git' }));

    const result = await runDataFolderTableSpecGitImport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'limited', maximumFoldersToCount: 3, startAfterDataFolderId: undefined }, dryRun: false },
    );

    expect(result.summary.examinedFolderCount).toBe(30);
    expect(result.summary.importedFolderCount).toBe(0);
    expect(result.summary.unreachedCandidateFolderCount).toBe(470);
  });

  it('only counts folders that point at a remote table and have no row as candidates, including in remainingCount', async () => {
    const { prisma, findManyQueries, countQueries } = fakePrismaServingCandidates(candidateFolders(1));
    const dataFolderTableSpecStore = fakeImportStore(() => ({ kind: 'imported', importedDefaultView: false }));

    await runDataFolderTableSpecGitImport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'workbooks', workbookIds: ['wkb_1'] }, dryRun: false },
    );

    const expectedCandidateFilter = {
      connectorAccountId: { not: null },
      path: { not: null },
      tableId: { isEmpty: false },
      storedTableSpecRow: { is: null },
      workbook: { isPendingDelete: false },
    };
    expect(findManyQueries[0].where).toMatchObject(expectedCandidateFilter);
    expect(countQueries.at(-1)?.where).toEqual(expectedCandidateFilter);
  });

  it('imports every candidate in the requested workbooks, with no cap', async () => {
    const { prisma, findManyQueries } = fakePrismaServingCandidates(candidateFolders(230));
    const dataFolderTableSpecStore = fakeImportStore(() => ({ kind: 'imported', importedDefaultView: false }));

    const result = await runDataFolderTableSpecGitImport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'workbooks', workbookIds: ['wkb_1'] }, dryRun: false },
    );

    expect(result.summary.importedFolderCount).toBe(230);
    expect(result.summary.unreachedCandidateFolderCount).toBe(0);
    expect(findManyQueries[0].where.workbookId).toEqual({ in: ['wkb_1'] });
  });

  it('tallies every outcome and keeps going after a thrown error', async () => {
    const outcomesInIdOrder: Array<DataFolderTableSpecGitImportOutcome | Error> = [
      { kind: 'imported', importedDefaultView: true },
      { kind: 'row-already-present' },
      { kind: 'no-table-spec-in-git' },
      { kind: 'invalid-table-spec-in-git', reason: 'not an object' },
      { kind: 'connection-has-no-repo', error: new Error('no repoPath') },
      { kind: 'git-read-failed', error: new Error('503') },
      { kind: 'data-folder-deleted' },
      new Error('database unavailable'),
      { kind: 'imported', importedDefaultView: false },
    ];
    const folders = candidateFolders(outcomesInIdOrder.length);
    const { prisma } = fakePrismaServingCandidates(folders, 5);
    const dataFolderTableSpecStore = fakeImportStore(
      (dataFolderId) => outcomesInIdOrder[folders.findIndex((folder) => folder.id === dataFolderId)],
    );

    const { summary, importedDataFolderIds, remainingCandidateFolderCount } = await runDataFolderTableSpecGitImport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'workbooks', workbookIds: ['wkb_1'] }, dryRun: false },
    );

    expect(summary).toEqual({
      examinedFolderCount: 9,
      importedFolderCount: 2,
      importedFolderWithDefaultViewCount: 1,
      rowAlreadyPresentFolderCount: 1,
      noTableSpecInGitFolderCount: 1,
      invalidTableSpecInGitFolderCount: 1,
      connectionHasNoRepoFolderCount: 1,
      gitReadFailedFolderCount: 1,
      deletedDuringRunFolderCount: 1,
      erroredFolderCount: 1,
      unreachedCandidateFolderCount: 0,
    });
    expect(importedDataFolderIds).toEqual([folders[0].id, folders[8].id]);
    expect(remainingCandidateFolderCount).toBe(5);
  });

  it('passes dryRun through and labels the summary accordingly', async () => {
    const { prisma } = fakePrismaServingCandidates(candidateFolders(2));
    const dataFolderTableSpecStore = fakeImportStore(() => ({ kind: 'would-import', importedDefaultView: true }));

    const { summary } = await runDataFolderTableSpecGitImport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'limited', maximumFoldersToCount: 5, startAfterDataFolderId: undefined }, dryRun: true },
    );

    expect(dataFolderTableSpecStore.importTableSpecFromGitIfAbsent).toHaveBeenCalledWith(expect.anything(), {
      dryRun: true,
    });
    expect(buildDataFolderTableSpecGitImportSummaryRows(summary, true)).toEqual(
      expect.arrayContaining([{ label: 'folders whose table spec would be imported', count: 2 }]),
    );
  });
});

describe('pickRandomDataFolderIdToStartWalkAfter', () => {
  it('picks the candidate at the random fraction of the id order', async () => {
    const { prisma } = fakePrismaServingCandidates(candidateFolders(10));
    await expect(
      pickRandomDataFolderIdToStartWalkAfter(prisma, DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_MIGRATION_NAME, 0.35),
    ).resolves.toBe('dfd_0003');
    await expect(
      pickRandomDataFolderIdToStartWalkAfter(prisma, DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_MIGRATION_NAME, 0.9999),
    ).resolves.toBe('dfd_0009');
  });

  it('is undefined when there are no candidates', async () => {
    const { prisma } = fakePrismaServingCandidates([]);
    await expect(
      pickRandomDataFolderIdToStartWalkAfter(prisma, DATA_FOLDER_TABLE_SPEC_GIT_IMPORT_MIGRATION_NAME, 0.5),
    ).resolves.toBeUndefined();
  });
});

describe('runDataFolderTableSpecGitDivergenceReport', () => {
  it('lists the folders whose row differs from git, and never writes', async () => {
    const outcomesInIdOrder: DataFolderTableSpecGitDivergenceOutcome[] = [
      { kind: 'matches' },
      { kind: 'differs', tableSpecDiffers: true, defaultViewDiffers: false },
      { kind: 'differs', tableSpecDiffers: false, defaultViewDiffers: true },
      { kind: 'no-table-spec-in-git' },
      { kind: 'git-read-failed', error: new Error('503') },
    ];
    const folders = candidateFolders(outcomesInIdOrder.length);
    const { prisma } = fakePrismaServingCandidates(folders);
    const dataFolderTableSpecStore = {
      compareStoredRowWithGit: jest.fn(({ dataFolderId }: { dataFolderId: string }) =>
        Promise.resolve(outcomesInIdOrder[folders.findIndex((folder) => folder.id === dataFolderId)]),
      ),
    };

    const { divergentDataFolderIds, summary } = await runDataFolderTableSpecGitDivergenceReport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'workbooks', workbookIds: ['wkb_1'] } },
    );

    expect(divergentDataFolderIds).toEqual([folders[1].id, folders[2].id]);
    expect(summary).toMatchObject({
      examinedFolderCount: 5,
      matchingFolderCount: 1,
      tableSpecDiffersFolderCount: 1,
      onlyDefaultViewDiffersFolderCount: 1,
      noTableSpecInGitFolderCount: 1,
      gitReadFailedFolderCount: 1,
      unreachedCandidateFolderCount: 0,
    });
    expect(buildDataFolderTableSpecGitDivergenceSummaryRows(summary)).toEqual(
      expect.arrayContaining([{ label: 'folders whose row matches git', count: 1 }]),
    );
  });

  it('compares exactly qty folders in a limited run', async () => {
    const { prisma } = fakePrismaServingCandidates(candidateFolders(50));
    const dataFolderTableSpecStore = {
      compareStoredRowWithGit: jest.fn(() =>
        Promise.resolve<DataFolderTableSpecGitDivergenceOutcome>({ kind: 'matches' }),
      ),
    };

    const { summary } = await runDataFolderTableSpecGitDivergenceReport(
      { prisma, dataFolderTableSpecStore },
      { scope: { kind: 'limited', maximumFoldersToCount: 12, startAfterDataFolderId: 'dfd_0045' } },
    );

    expect(summary.examinedFolderCount).toBe(12);
    expect(summary.unreachedCandidateFolderCount).toBe(38);
  });
});
