/**
 * End-to-end Pass 3 (unmatched-destination) integration tests for the sync
 * DELETE policy — the sibling of the archive feature (sync-archive-e2e.spec.ts).
 *
 * When `unmatchedDestinationPolicy.withMatchKey` (or `withoutMatchKey`) is
 * `'delete'`, an unmatched destination record is removed from the dirty branch
 * instead of having constant column mappings applied. The motivating use case:
 * a source record is deleted upstream → its synced destination counterpart is
 * deleted too. Runs against a real Postgres DB with mocked git + data-folder
 * I/O, mirroring `sync-archive-e2e.spec.ts`.
 */

import { PrismaClient } from '@prisma/client';
import {
  createDataFolderId,
  createSyncId,
  createWorkbookId,
  DataFolderId,
  SyncId,
  TableMappingV2,
  WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { createReadRepoFilesByFolderMock } from './sync-test-helpers';

// Destination schema that DECLARES the match-key column (`email`), so Pass 3's
// "match-key column exists in destination schema" gate passes.
const DEST_SCHEMA_WITH_EMAIL = {
  idPath: 'id',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
    },
  },
};

describe('SyncService - Pass 3 unmatched-destination DELETE', () => {
  let prisma: PrismaClient;
  let syncService: SyncService;
  let dataFolderService: DataFolderService;
  let scratchGitService: ScratchGitService;
  let dbService: DbService;

  let workbookId: WorkbookId;
  let sourceFolderId: DataFolderId;
  let destFolderId: DataFolderId;
  let syncId: SyncId;
  let orgId: string;
  let userId: string;
  const actor: Actor = { userId: 'test-user', organizationId: 'test-org' };

  let writtenFiles: Array<{ path: string; content: string }>;
  let deletedPaths: string[];
  let gitSchemasByPath: Record<string, Record<string, unknown>>;

  const setFolderContents = (
    sourceFiles: Array<{ path: string; content: string }>,
    destFiles: Array<{ path: string; content: string }>,
  ): void => {
    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles.map((f) => ({ folderId: sourceFolderId, ...f })));
      }
      if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles.map((f) => ({ folderId: destFolderId, ...f })));
      }
      return Promise.resolve([]);
    });
  };

  const writtenByPath = (path: string): Record<string, unknown> | undefined => {
    const file = writtenFiles.find((f) => f.path === path);
    return file ? (JSON.parse(file.content) as Record<string, unknown>) : undefined;
  };

  // Copy `name` for matched records — no unmatched-side constants, since DELETE
  // applies no column mappings.
  const copyNameMapping = (): TableMappingV2['columnMappings'] => [
    { destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } },
  ];

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    writtenFiles = [];
    deletedPaths = [];
    gitSchemasByPath = {
      '/src': { idPath: 'id' },
      '/dest': DEST_SCHEMA_WITH_EMAIL,
    };

    dbService = { client: prisma } as unknown as DbService;

    dataFolderService = {
      getAllFileContentsByFolderId: jest.fn(),
      getFileContentsByFolderIdPaginated: jest.fn(),
      findOne: jest.fn(),
    } as unknown as DataFolderService;

    (dataFolderService.getFileContentsByFolderIdPaginated as jest.Mock).mockImplementation(
      async (wbId, folderId, actorArg, branch, cursor) => {
        if (cursor) {
          return { files: [], nextCursor: undefined };
        }
        const files = ((await (dataFolderService.getAllFileContentsByFolderId as jest.Mock)(
          wbId,
          folderId,
          actorArg,
          branch,
        )) ?? []) as { folderId: DataFolderId; path: string; content: string }[];
        return { files, nextCursor: undefined };
      },
    );

    scratchGitService = {
      resolveRepoId: jest.fn().mockImplementation((wkbId: WorkbookId) => Promise.resolve(wkbId)),
      resolveConnectionRepoPath: jest
        .fn()
        .mockImplementation((connectorAccountId: string) => Promise.resolve(connectorAccountId)),
      readRepoFilesByFolder: createReadRepoFilesByFolderMock({
        prisma,
        dataFolderService,
        getWorkbookId: () => workbookId,
        getActor: () => actor,
      }),
      readSchemaFromGit: jest.fn().mockImplementation((_repoId: string, folderPath: string) => {
        return Promise.resolve(gitSchemasByPath[folderPath] ?? null);
      }),
      commitFilesToBranch: jest
        .fn()
        .mockImplementation((_workbookId, _branch, files: Array<{ path: string; content: string }>) => {
          writtenFiles.push(...files);
          return Promise.resolve({ created: [], updated: [], unchanged: [] });
        }),
      deleteFilesFromBranch: jest.fn().mockImplementation((_repoId, _branch, paths: string[]) => {
        deletedPaths.push(...paths);
        return Promise.resolve();
      }),
    } as unknown as ScratchGitService;

    const scheduleService = { create: jest.fn(), update: jest.fn(), delete: jest.fn() } as unknown as ScheduleService;
    syncService = new SyncService(
      dbService,
      dataFolderService,
      {} as PostHogService,
      scheduleService,
      scratchGitService,
      {} as never,
      {} as never,
    );

    const org = await prisma.organization.create({
      data: { id: 'org_delete_' + Date.now(), name: 'Test Org', clerkId: 'clerk_delete_' + Date.now() },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: { id: 'user_delete_' + Date.now(), email: `delete-${Date.now()}@example.com`, organizationId: org.id },
    });
    userId = user.id;

    const wbId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: wbId, name: 'Test Workbook', userId: user.id, organizationId: org.id },
    });
    workbookId = wbId;

    const srcFolderId = createDataFolderId();
    await prisma.dataFolder.create({ data: { id: srcFolderId, name: 'Source Folder', workbookId, path: '/src' } });
    sourceFolderId = srcFolderId;

    const dstFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: { id: dstFolderId, name: 'Destination Folder', workbookId, path: '/dest' },
    });
    destFolderId = dstFolderId;

    (dataFolderService.findOne as jest.Mock).mockImplementation((folderId) => {
      if (folderId === destFolderId) return Promise.resolve({ path: '/dest' });
      return Promise.resolve({ path: '/src' });
    });

    const synId = createSyncId();
    await prisma.sync.create({ data: { id: synId, displayName: 'Test Sync', mappings: [] } });
    syncId = synId;
  });

  afterEach(async () => {
    await prisma.sync.delete({ where: { id: syncId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.syncMatchKeys.deleteMany({ where: { syncId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 2 sources / 4 destinations. d1/d2 are matched; d3 is unmatched with a
  // populated match key (source deleted upstream); d4 is hand-authored (no key).
  const seedDeleteFixture = (): void => {
    setFolderContents(
      [
        { path: 'src/s1.json', content: '{"id":"s1","email":"john@example.com","name":"John"}' },
        { path: 'src/s2.json', content: '{"id":"s2","email":"jane@example.com","name":"Jane"}' },
      ],
      [
        { path: 'dest/d1.json', content: '{"id":"dest1","email":"john@example.com","name":"John"}' },
        { path: 'dest/d2.json', content: '{"id":"dest2","email":"jane@example.com","name":"Jane"}' },
        { path: 'dest/d3.json', content: '{"id":"dest3","email":"bob@example.com","name":"Bob"}' },
        { path: 'dest/d4.json', content: '{"id":"dest4","email":"","name":"Hand authored"}' },
      ],
    );
  };

  it('deletes an unmatched-with-key record and leaves hand-authored content alone (the intended config)', async () => {
    seedDeleteFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: copyNameMapping(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'ignore' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.errors).toHaveLength(0);

    // d3 (unmatched, has key) is deleted by Pass 3.
    expect(deletedPaths).toEqual(['dest/d3.json']);
    // d4 (hand-authored, no key) is untouched. d1/d2 are matched, not deleted.
    expect(deletedPaths).not.toContain('dest/d4.json');
    expect(deletedPaths).not.toContain('dest/d1.json');

    // Pass 3 deletes the file; it is never written.
    expect(writtenByPath('dest/d3.json')).toBeUndefined();

    expect(result.recordsDeleted).toBe(1);
    expect(result.deletedPaths).toEqual(['dest/d3.json']);
    expect(result.unmatchedDestinationCounts.withMatchKey).toBe(1);
    expect(result.unmatchedDestinationCounts.withoutMatchKey).toBe(1); // d4 visited but ignored
    expect(result.unmatchedDestinationCounts.deleted).toBe(1);
    expect(result.unmatchedDestinationCounts.archived).toBe(0);
  });

  it('deletes hand-authored records too when withoutMatchKey is delete (sync owns the whole collection)', async () => {
    seedDeleteFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: copyNameMapping(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'delete' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.errors).toHaveLength(0);
    expect(deletedPaths.sort()).toEqual(['dest/d3.json', 'dest/d4.json']);
    expect(result.unmatchedDestinationCounts.deleted).toBe(2);
    expect(result.recordsDeleted).toBe(2);
  });

  it('mixes archive (withMatchKey apply) and a no-op withoutMatchKey ignore — no deletions', async () => {
    seedDeleteFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: copyNameMapping(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'ignore', withoutMatchKey: 'ignore' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(deletedPaths).toEqual([]);
    expect(result.unmatchedDestinationCounts.deleted).toBe(0);
    expect(result.recordsDeleted).toBe(0);
    expect(scratchGitService.deleteFilesFromBranch).not.toHaveBeenCalled();
  });

  it('is gated off when recordMatching is unset (no way to classify dest records)', async () => {
    seedDeleteFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: copyNameMapping(),
      // No recordMatching → Pass 3 cannot run.
      unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'delete' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(deletedPaths).toEqual([]);
    expect(result.unmatchedDestinationCounts.deleted).toBe(0);
  });

  it('surfaces an error and reports zero deletions when the batch delete fails', async () => {
    seedDeleteFixture();
    (scratchGitService.deleteFilesFromBranch as jest.Mock).mockRejectedValueOnce(new Error('git boom'));

    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: copyNameMapping(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'ignore' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.errors.some((e) => e.error.includes('Batch delete failed'))).toBe(true);
    // The run summary must not claim a deletion that didn't land.
    expect(result.unmatchedDestinationCounts.deleted).toBe(0);
    expect(result.recordsDeleted).toBe(0);
    expect(result.deletedPaths).toEqual([]);
  });
});
