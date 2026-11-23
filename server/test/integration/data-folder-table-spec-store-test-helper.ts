import { PrismaClient } from '@prisma/client';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { StubMetricsService } from 'src/metrics/stub-metrics.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { DataFolderTableSpecStoreService } from 'src/workbook/table-spec-store/data-folder-table-spec-store.service';
import { createIntegrationTestDbService } from './integration-db-service';

/**
 * A real `DataFolderTableSpecStoreService` (DEV-12616) for integration tests: real Postgres through the test's own
 * `PrismaClient`, the test's (usually mocked) `ScratchGitService` as the git fallback and mirror, and the two
 * rollout flags set explicitly. Defaults match production today: reads from git, writes mirrored to git.
 */
export function createIntegrationTestDataFolderTableSpecStore(params: {
  prisma: PrismaClient;
  scratchGitService: ScratchGitService;
  postgresReadsEnabled?: boolean;
  gitMirrorEnabled?: boolean;
}): DataFolderTableSpecStoreService {
  const { prisma, scratchGitService, postgresReadsEnabled = false, gitMirrorEnabled = true } = params;
  const scratchConfigServiceWithTableSpecFlags = {
    isTableSpecPostgresReadsEnabled: () => postgresReadsEnabled,
    isTableSpecGitMirrorEnabled: () => gitMirrorEnabled,
  } as unknown as ScratchConfigService;
  return new DataFolderTableSpecStoreService(
    createIntegrationTestDbService(prisma),
    scratchGitService,
    scratchConfigServiceWithTableSpecFlags,
    new StubMetricsService(),
  );
}

/**
 * A table spec store for sync specs whose fixture folders have NO connection: it reads each folder's spec from the
 * spec's mocked `ScratchGitService.readSchemaFromGit`, by folder path, the way the pre-DEV-12616 git store did.
 * The real store (like production) returns null for a folder with no connection, so these specs — which test sync
 * logic, not spec storage — would otherwise lose their per-folder `idPath` and FK schemas. Read-only: sync never
 * writes specs.
 */
export function createTableSpecStoreReadingMockedGitByFolderPath(
  scratchGitService: ScratchGitService,
): DataFolderTableSpecStoreService {
  const tableSpecStoreReadingMockedGitByFolderPath: Pick<
    DataFolderTableSpecStoreService,
    'readTableSpec' | 'readDefaultView'
  > = {
    readTableSpec: (location) =>
      scratchGitService.readSchemaFromGit(location.connectorAccountId ?? '', location.folderPath),
    readDefaultView: () => Promise.resolve(null),
  };
  return tableSpecStoreReadingMockedGitByFolderPath as DataFolderTableSpecStoreService;
}
