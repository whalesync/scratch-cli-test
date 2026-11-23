/**
 * Real-Postgres integration tests for DataFolderTableSpecStoreService (DEV-12616): the things mocks can't prove —
 * one row per folder, `onDelete: Cascade` from DataFolder and Workbook, that a write differing only in
 * `generatedAt` leaves the row (and `updatedAt`) alone, that the import never overwrites a real write, and that
 * TEXT keeps the spec's key order (jsonb would not). Requires the `data_folder_table_specs_in_db` migration.
 */

import { PrismaClient } from '@prisma/client';
import { createDataFolderId, createWorkbookId, type DataFolderId, type WorkbookId } from '@spinner/shared-types';
import { dotPath, type BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { DataFolderTableSpecStoreService } from 'src/workbook/table-spec-store/data-folder-table-spec-store.service';
import { createIntegrationTestDataFolderTableSpecStore } from './data-folder-table-spec-store-test-helper';

const CONNECTOR_ACCOUNT_ID = 'coa_tablespecdb';
const FOLDER_PATH = '/Base/Contacts';

function buildTableSpec(overrides: Partial<BaseJsonTableSpec> = {}): BaseJsonTableSpec {
  return {
    id: { wsId: 'tbl1', remoteId: ['tbl1'] },
    slug: 'contacts',
    name: 'Contacts',
    idPath: dotPath('id'),
    // Property order is column order: `zeta` before `alpha` must survive storage.
    schema: { type: 'object', properties: { zeta: { type: 'number' }, alpha: { type: 'string' } } },
    generatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  } as BaseJsonTableSpec;
}

describe('DataFolderTableSpecStoreService (real DB)', () => {
  let prisma: PrismaClient;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let store: DataFolderTableSpecStoreService;

  let orgId: string;
  let workbookId: WorkbookId;
  let dataFolderId: DataFolderId;
  let location: { dataFolderId: string; connectorAccountId: string; folderPath: string };

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('org/wkb/coa'),
      writeSchemaToGit: jest.fn().mockResolvedValue(undefined),
      writeViewToGit: jest.fn().mockResolvedValue(undefined),
      readSchemaFromGit: jest.fn().mockResolvedValue(null),
      readViewFromGit: jest.fn().mockResolvedValue(null),
      readSchemaFileContentFromGitOrThrow: jest.fn().mockResolvedValue(null),
      readViewFileContentFromGitOrThrow: jest.fn().mockResolvedValue(null),
      parseSchemaFileContentFromGit: jest.fn((_repoId: string, _folderPath: string, content: string): unknown =>
        JSON.parse(content),
      ),
    } as unknown as jest.Mocked<ScratchGitService>;
    store = createIntegrationTestDataFolderTableSpecStore({ prisma, scratchGitService, postgresReadsEnabled: true });

    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const org = await prisma.organization.create({
      data: { id: `org_tablespec_${uniqueSuffix}`, name: 'Test Org', clerkId: `clerk_tablespec_${uniqueSuffix}` },
    });
    orgId = org.id;
    const user = await prisma.user.create({
      data: {
        id: `user_tablespec_${uniqueSuffix}`,
        email: `tablespec-${uniqueSuffix}@example.com`,
        organizationId: org.id,
      },
    });
    workbookId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: workbookId, name: 'Table Specs', userId: user.id, organizationId: org.id },
    });
    dataFolderId = createDataFolderId();
    await prisma.dataFolder.create({ data: { id: dataFolderId, name: 'Contacts', workbookId, path: FOLDER_PATH } });
    location = { dataFolderId, connectorAccountId: CONNECTOR_ACCOUNT_ID, folderPath: FOLDER_PATH };
  });

  afterEach(async () => {
    await prisma.workbook.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps one row per folder', async () => {
    await store.writeTableSpec(location, buildTableSpec(), 'pull');
    await expect(
      prisma.dataFolderTableSpec.create({ data: { dataFolderId, tableSpecContent: '{}', source: 'pull' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('stores the spec byte-for-byte as formatRecordJson and reads it back in key order', async () => {
    const tableSpec = buildTableSpec();
    await store.writeTableSpec(location, tableSpec, 'pull');

    const storedRow = await prisma.dataFolderTableSpec.findUniqueOrThrow({ where: { dataFolderId } });
    expect(storedRow.tableSpecContent).toBe(JSON.stringify(tableSpec, null, 2) + '\n');
    const readBack = await store.readTableSpec(location);
    expect(Object.keys((readBack?.schema as unknown as { properties: object }).properties)).toEqual(['zeta', 'alpha']);
  });

  it('leaves the row untouched when only generatedAt changed, and rewrites it on a real change', async () => {
    await store.writeTableSpec(location, buildTableSpec(), 'pull');
    const firstRow = await prisma.dataFolderTableSpec.findUniqueOrThrow({ where: { dataFolderId } });

    await expect(
      store.writeTableSpec(location, buildTableSpec({ generatedAt: '2026-11-23T00:00:00.000Z' }), 'refresh-schema'),
    ).resolves.toBe('unchanged');
    const unchangedRow = await prisma.dataFolderTableSpec.findUniqueOrThrow({ where: { dataFolderId } });
    expect(unchangedRow).toEqual(firstRow);

    await expect(store.writeTableSpec(location, buildTableSpec({ name: 'Renamed' }), 'refresh-schema')).resolves.toBe(
      'updated',
    );
    const updatedRow = await prisma.dataFolderTableSpec.findUniqueOrThrow({ where: { dataFolderId } });
    expect(updatedRow.source).toBe('refresh-schema');
    expect(updatedRow.updatedAt.getTime()).toBeGreaterThanOrEqual(firstRow.updatedAt.getTime());
  });

  it('stores the default view on the same row', async () => {
    await store.writeTableSpec(location, buildTableSpec(), 'pull');
    await store.writeDefaultView(location, { columns: [] } as never, 'pull');
    await expect(store.readDefaultView(location)).resolves.toEqual({ columns: [] });
  });

  it('never lets the git import overwrite a real write', async () => {
    await store.writeTableSpec(location, buildTableSpec({ name: 'From the pull' }), 'pull');
    scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(
      JSON.stringify(buildTableSpec({ name: 'From git' })),
    );

    await expect(store.importTableSpecFromGitIfAbsent(location, { dryRun: false })).resolves.toEqual({
      kind: 'row-already-present',
    });
    await expect(store.readTableSpec(location)).resolves.toMatchObject({ name: 'From the pull' });
  });

  it('imports from git when the folder has no row', async () => {
    scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(
      JSON.stringify(buildTableSpec({ name: 'From git' })),
    );
    await expect(store.importTableSpecFromGitIfAbsent(location, { dryRun: false })).resolves.toEqual({
      kind: 'imported',
      importedDefaultView: false,
    });
    const importedRow = await prisma.dataFolderTableSpec.findUniqueOrThrow({ where: { dataFolderId } });
    expect(importedRow.source).toBe('git-import');
  });

  it('reports a deleted folder instead of storing a row for it', async () => {
    await prisma.dataFolder.delete({ where: { id: dataFolderId } });
    await expect(store.writeTableSpec(location, buildTableSpec(), 'pull')).resolves.toBe('data-folder-deleted');
  });

  it('cascades from DataFolder delete', async () => {
    await store.writeTableSpec(location, buildTableSpec(), 'pull');
    await prisma.dataFolder.delete({ where: { id: dataFolderId } });
    await expect(prisma.dataFolderTableSpec.count({ where: { dataFolderId } })).resolves.toBe(0);
  });

  it('cascades from Workbook delete', async () => {
    await store.writeTableSpec(location, buildTableSpec(), 'pull');
    await prisma.workbook.delete({ where: { id: workbookId } });
    await expect(prisma.dataFolderTableSpec.count({ where: { dataFolderId } })).resolves.toBe(0);
  });
});
