import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatRecordJson, type TableView } from '@spinner/shared-types';
import { createHash } from 'crypto';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { dotPath, type BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import {
  ScratchGitBadRequestError,
  ScratchGitIndexBuildRequestBodyTooLargeError,
  ScratchGitRequestEntityTooLargeError,
} from 'src/scratch-git/scratch-git.client';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { DataFolderTableSpecStoreService } from '../data-folder-table-spec-store.service';

const DATA_FOLDER_ID = 'dfd_contacts01';
const CONNECTOR_ACCOUNT_ID = 'coa_airtable01';
const FOLDER_PATH = '/Airtable/Contacts';
const REPO_ID = 'org_1/wkb_1/coa_airtable01';
const CONNECTED_LOCATION = {
  dataFolderId: DATA_FOLDER_ID,
  connectorAccountId: CONNECTOR_ACCOUNT_ID,
  folderPath: FOLDER_PATH,
};

function buildTableSpec(overrides: Partial<BaseJsonTableSpec> = {}): BaseJsonTableSpec {
  return {
    id: { wsId: 'tbl1', remoteId: ['tbl1'] },
    slug: 'contacts',
    name: 'Contacts',
    idPath: dotPath('id'),
    schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    generatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  } as BaseJsonTableSpec;
}

const DEFAULT_VIEW = { columns: [{ path: 'name' }] } as unknown as TableView;

function prismaKnownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' });
}

describe('DataFolderTableSpecStoreService', () => {
  let dataFolderTableSpecDelegate: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    createMany: jest.Mock;
  };
  let scratchGitService: {
    resolveConnectionRepoPath: jest.Mock;
    readSchemaFromGit: jest.Mock;
    readViewFromGit: jest.Mock;
    writeSchemaToGit: jest.Mock;
    writeViewToGit: jest.Mock;
    readSchemaFileContentFromGitOrThrow: jest.Mock;
    readViewFileContentFromGitOrThrow: jest.Mock;
    parseSchemaFileContentFromGit: jest.Mock;
    buildIndex: jest.Mock;
  };
  let dataFolderDelegate: { findMany: jest.Mock };
  let connectorAccountDelegate: { findMany: jest.Mock };
  let postgresReadsEnabled: boolean;
  let gitMirrorEnabled: boolean;
  let metricsService: { logValue: jest.Mock };
  let store: DataFolderTableSpecStoreService;

  beforeEach(() => {
    dataFolderTableSpecDelegate = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue(REPO_ID),
      readSchemaFromGit: jest.fn().mockResolvedValue(null),
      readViewFromGit: jest.fn().mockResolvedValue(null),
      writeSchemaToGit: jest.fn().mockResolvedValue(undefined),
      writeViewToGit: jest.fn().mockResolvedValue(undefined),
      readSchemaFileContentFromGitOrThrow: jest.fn().mockResolvedValue(null),
      readViewFileContentFromGitOrThrow: jest.fn().mockResolvedValue(null),
      parseSchemaFileContentFromGit: jest.fn((_repoId: string, _folderPath: string, content: string): unknown =>
        JSON.parse(content),
      ),
      buildIndex: jest.fn().mockResolvedValue({ count: 0 }),
    };
    dataFolderDelegate = { findMany: jest.fn().mockResolvedValue([]) };
    connectorAccountDelegate = { findMany: jest.fn().mockResolvedValue([]) };
    postgresReadsEnabled = false;
    gitMirrorEnabled = true;
    metricsService = { logValue: jest.fn() };
    store = new DataFolderTableSpecStoreService(
      {
        client: {
          dataFolderTableSpec: dataFolderTableSpecDelegate,
          dataFolder: dataFolderDelegate,
          connectorAccount: connectorAccountDelegate,
        },
      } as unknown as DbService,
      scratchGitService as unknown as ScratchGitService,
      {
        isTableSpecPostgresReadsEnabled: () => postgresReadsEnabled,
        isTableSpecGitMirrorEnabled: () => gitMirrorEnabled,
      } as unknown as ScratchConfigService,
      metricsService as unknown as CustomMetricsService,
    );
  });

  describe('readTableSpec', () => {
    it('returns null for a folder with no connection, without touching Postgres or git', async () => {
      postgresReadsEnabled = true;
      await expect(store.readTableSpec({ ...CONNECTED_LOCATION, connectorAccountId: null })).resolves.toBeNull();
      expect(dataFolderTableSpecDelegate.findUnique).not.toHaveBeenCalled();
      expect(scratchGitService.readSchemaFromGit).not.toHaveBeenCalled();
    });

    it('reads the git copy, not Postgres, while Postgres reads are off', async () => {
      const gitTableSpec = buildTableSpec();
      scratchGitService.readSchemaFromGit.mockResolvedValue(gitTableSpec);

      await expect(store.readTableSpec(CONNECTED_LOCATION)).resolves.toBe(gitTableSpec);
      expect(scratchGitService.resolveConnectionRepoPath).toHaveBeenCalledWith(CONNECTOR_ACCOUNT_ID);
      expect(scratchGitService.readSchemaFromGit).toHaveBeenCalledWith(REPO_ID, FOLDER_PATH);
      expect(dataFolderTableSpecDelegate.findUnique).not.toHaveBeenCalled();
      expect(metricsService.logValue).not.toHaveBeenCalled();
    });

    it('returns the stored row when Postgres reads are on', async () => {
      postgresReadsEnabled = true;
      const storedTableSpec = buildTableSpec({ name: 'Stored' });
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({ tableSpecContent: formatRecordJson(storedTableSpec) });

      await expect(store.readTableSpec(CONNECTED_LOCATION)).resolves.toEqual(storedTableSpec);
      expect(dataFolderTableSpecDelegate.findUnique).toHaveBeenCalledWith({
        where: { dataFolderId: DATA_FOLDER_ID },
        select: { tableSpecContent: true },
      });
      expect(scratchGitService.readSchemaFromGit).not.toHaveBeenCalled();
    });

    it('falls back to git (read-only) and counts it when the folder has no row', async () => {
      postgresReadsEnabled = true;
      const gitTableSpec = buildTableSpec();
      scratchGitService.readSchemaFromGit.mockResolvedValue(gitTableSpec);

      await expect(store.readTableSpec(CONNECTED_LOCATION)).resolves.toBe(gitTableSpec);
      expect(metricsService.logValue).toHaveBeenCalledWith(
        CustomMetric.DATA_FOLDER_TABLE_SPEC_READ_FELL_BACK_TO_GIT,
        1,
      );
      expect(dataFolderTableSpecDelegate.upsert).not.toHaveBeenCalled();
      expect(dataFolderTableSpecDelegate.createMany).not.toHaveBeenCalled();
    });

    it('throws when the stored row is not a JSON object (the port contract: unreadable storage throws)', async () => {
      postgresReadsEnabled = true;
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({ tableSpecContent: '[1, 2]' });
      await expect(store.readTableSpec(CONNECTED_LOCATION)).rejects.toThrow(DATA_FOLDER_ID);
    });
  });

  describe('readDefaultView', () => {
    it('returns the stored view when Postgres reads are on', async () => {
      postgresReadsEnabled = true;
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({ defaultViewContent: formatRecordJson(DEFAULT_VIEW) });
      await expect(store.readDefaultView(CONNECTED_LOCATION)).resolves.toEqual(DEFAULT_VIEW);
      expect(scratchGitService.readViewFromGit).not.toHaveBeenCalled();
    });

    it('falls back to git, without counting a fallback, when the row has no view', async () => {
      postgresReadsEnabled = true;
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({ defaultViewContent: null });
      scratchGitService.readViewFromGit.mockResolvedValue(DEFAULT_VIEW);

      await expect(store.readDefaultView(CONNECTED_LOCATION)).resolves.toBe(DEFAULT_VIEW);
      expect(scratchGitService.readViewFromGit).toHaveBeenCalledWith(REPO_ID, FOLDER_PATH, 'default');
      expect(metricsService.logValue).not.toHaveBeenCalled();
    });

    it('falls back to git and counts it when the folder has no row', async () => {
      postgresReadsEnabled = true;
      scratchGitService.readViewFromGit.mockResolvedValue(DEFAULT_VIEW);

      await expect(store.readDefaultView(CONNECTED_LOCATION)).resolves.toBe(DEFAULT_VIEW);
      expect(metricsService.logValue).toHaveBeenCalledWith(
        CustomMetric.DATA_FOLDER_TABLE_SPEC_READ_FELL_BACK_TO_GIT,
        1,
      );
    });

    it('reads the git copy while Postgres reads are off', async () => {
      scratchGitService.readViewFromGit.mockResolvedValue(DEFAULT_VIEW);
      await expect(store.readDefaultView(CONNECTED_LOCATION)).resolves.toBe(DEFAULT_VIEW);
      expect(dataFolderTableSpecDelegate.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('writeTableSpec', () => {
    it('inserts a new row with formatRecordJson bytes and mirrors the stored spec to git', async () => {
      const tableSpec = buildTableSpec();
      const tableSpecContent = formatRecordJson(tableSpec as unknown as Record<string, unknown>);
      dataFolderTableSpecDelegate.findUnique
        .mockResolvedValueOnce(null) // the write's own read
        .mockResolvedValueOnce({ tableSpecContent }); // the mirror's re-read

      await expect(store.writeTableSpec(CONNECTED_LOCATION, tableSpec, 'pull')).resolves.toBe('created');
      expect(dataFolderTableSpecDelegate.upsert).toHaveBeenCalledWith({
        where: { dataFolderId: DATA_FOLDER_ID },
        create: { dataFolderId: DATA_FOLDER_ID, tableSpecContent, source: 'pull' },
        update: { tableSpecContent, source: 'pull' },
      });
      expect(scratchGitService.writeSchemaToGit).toHaveBeenCalledWith(REPO_ID, FOLDER_PATH, tableSpec);
    });

    it('rewrites a changed row', async () => {
      const storedTableSpec = buildTableSpec({ name: 'Old name' });
      const newTableSpec = buildTableSpec({ name: 'New name' });
      dataFolderTableSpecDelegate.findUnique
        .mockResolvedValueOnce({ tableSpecContent: formatRecordJson(storedTableSpec) })
        .mockResolvedValueOnce({ tableSpecContent: formatRecordJson(newTableSpec) });

      await expect(store.writeTableSpec(CONNECTED_LOCATION, newTableSpec, 'refresh-schema')).resolves.toBe('updated');
      expect(dataFolderTableSpecDelegate.upsert).toHaveBeenCalledTimes(1);
    });

    it('leaves the row alone when only generatedAt differs, but still mirrors the STORED spec', async () => {
      const storedTableSpec = buildTableSpec({ generatedAt: '2026-01-01T00:00:00.000Z' });
      const storedTableSpecContent = formatRecordJson(storedTableSpec);
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({ tableSpecContent: storedTableSpecContent });

      const outcome = await store.writeTableSpec(
        CONNECTED_LOCATION,
        buildTableSpec({ generatedAt: '2026-11-23T00:00:00.000Z' }),
        'pull',
      );

      expect(outcome).toBe('unchanged');
      expect(dataFolderTableSpecDelegate.upsert).not.toHaveBeenCalled();
      expect(scratchGitService.writeSchemaToGit).toHaveBeenCalledWith(REPO_ID, FOLDER_PATH, storedTableSpec);
    });

    it('overwrites a stored row that is not a JSON object', async () => {
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({ tableSpecContent: '"not an object"' });
      await expect(store.writeTableSpec(CONNECTED_LOCATION, buildTableSpec(), 'pull')).resolves.toBe('updated');
      expect(dataFolderTableSpecDelegate.upsert).toHaveBeenCalledTimes(1);
    });

    it('stores and mirrors nothing when the folder was deleted mid-write (P2003)', async () => {
      dataFolderTableSpecDelegate.upsert.mockRejectedValue(prismaKnownRequestError('P2003'));
      await expect(store.writeTableSpec(CONNECTED_LOCATION, buildTableSpec(), 'pull')).resolves.toBe(
        'data-folder-deleted',
      );
      expect(scratchGitService.writeSchemaToGit).not.toHaveBeenCalled();
    });

    it('propagates any other database error (Postgres is the source of truth)', async () => {
      dataFolderTableSpecDelegate.upsert.mockRejectedValue(new Error('connection lost'));
      await expect(store.writeTableSpec(CONNECTED_LOCATION, buildTableSpec(), 'pull')).rejects.toThrow(
        'connection lost',
      );
      expect(scratchGitService.writeSchemaToGit).not.toHaveBeenCalled();
    });

    it('does not mirror when the git mirror is off', async () => {
      gitMirrorEnabled = false;
      await store.writeTableSpec(CONNECTED_LOCATION, buildTableSpec(), 'pull');
      expect(scratchGitService.writeSchemaToGit).not.toHaveBeenCalled();
    });

    it('never throws when the mirror fails', async () => {
      const tableSpec = buildTableSpec();
      dataFolderTableSpecDelegate.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ tableSpecContent: formatRecordJson(tableSpec) });
      scratchGitService.resolveConnectionRepoPath.mockRejectedValue(new Error('no repoPath'));

      await expect(store.writeTableSpec(CONNECTED_LOCATION, tableSpec, 'pull')).resolves.toBe('created');
    });
  });

  describe('writeDefaultView', () => {
    it('stores a changed view and mirrors the stored view', async () => {
      const defaultViewContent = formatRecordJson(DEFAULT_VIEW as unknown as Record<string, unknown>);
      dataFolderTableSpecDelegate.findUnique
        .mockResolvedValueOnce({ defaultViewContent: null })
        .mockResolvedValueOnce({ defaultViewContent });

      await expect(store.writeDefaultView(CONNECTED_LOCATION, DEFAULT_VIEW, 'pull')).resolves.toBe('updated');
      expect(dataFolderTableSpecDelegate.update).toHaveBeenCalledWith({
        where: { dataFolderId: DATA_FOLDER_ID },
        data: { defaultViewContent, source: 'pull' },
      });
      expect(scratchGitService.writeViewToGit).toHaveBeenCalledWith(REPO_ID, FOLDER_PATH, 'default', DEFAULT_VIEW);
    });

    it('does not rewrite an identical view', async () => {
      const defaultViewContent = formatRecordJson(DEFAULT_VIEW as unknown as Record<string, unknown>);
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({ defaultViewContent });
      await expect(store.writeDefaultView(CONNECTED_LOCATION, DEFAULT_VIEW, 'pull')).resolves.toBe('unchanged');
      expect(dataFolderTableSpecDelegate.update).not.toHaveBeenCalled();
    });

    it('stores and mirrors nothing when the folder has no row', async () => {
      await expect(store.writeDefaultView(CONNECTED_LOCATION, DEFAULT_VIEW, 'pull')).resolves.toBe('no-table-spec-row');
      expect(dataFolderTableSpecDelegate.update).not.toHaveBeenCalled();
      expect(scratchGitService.writeViewToGit).not.toHaveBeenCalled();
    });
  });

  describe('importTableSpecFromGitIfAbsent', () => {
    const gitTableSpec = buildTableSpec();

    it('skips a folder that already has a row', async () => {
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({ dataFolderId: DATA_FOLDER_ID });
      await expect(store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: false })).resolves.toEqual({
        kind: 'row-already-present',
      });
      expect(scratchGitService.readSchemaFileContentFromGitOrThrow).not.toHaveBeenCalled();
    });

    it('reports nothing in git', async () => {
      await expect(store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: false })).resolves.toEqual({
        kind: 'no-table-spec-in-git',
      });
    });

    it('reports a git read failure (not absence) when scratch-git errors', async () => {
      const gitError = new Error('scratch-git 503');
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockRejectedValue(gitError);
      await expect(store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: false })).resolves.toEqual({
        kind: 'git-read-failed',
        error: gitError,
      });
    });

    it.each([
      ['invalid JSON', '{ not json'],
      ['a non-object', '[1, 2, 3]'],
      ['an object with no schema', '{"name": "Contacts"}'],
    ])('refuses %s', async (_description, schemaFileContent) => {
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(schemaFileContent);
      const outcome = await store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: false });
      expect(outcome.kind).toBe('invalid-table-spec-in-git');
      expect(dataFolderTableSpecDelegate.createMany).not.toHaveBeenCalled();
    });

    it('imports the spec and view with insert-if-absent', async () => {
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(formatRecordJson(gitTableSpec));
      scratchGitService.readViewFileContentFromGitOrThrow.mockResolvedValue(JSON.stringify(DEFAULT_VIEW));

      await expect(store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: false })).resolves.toEqual({
        kind: 'imported',
        importedDefaultView: true,
      });
      expect(dataFolderTableSpecDelegate.createMany).toHaveBeenCalledWith({
        data: [
          {
            dataFolderId: DATA_FOLDER_ID,
            tableSpecContent: formatRecordJson(gitTableSpec),
            defaultViewContent: formatRecordJson(DEFAULT_VIEW as unknown as Record<string, unknown>),
            source: 'git-import',
          },
        ],
        skipDuplicates: true,
      });
      expect(scratchGitService.writeSchemaToGit).not.toHaveBeenCalled();
    });

    it('imports the spec without an unreadable view', async () => {
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(formatRecordJson(gitTableSpec));
      scratchGitService.readViewFileContentFromGitOrThrow.mockResolvedValue('not json');
      await expect(store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: false })).resolves.toEqual({
        kind: 'imported',
        importedDefaultView: false,
      });
    });

    it('lets a concurrent real write win', async () => {
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(formatRecordJson(gitTableSpec));
      dataFolderTableSpecDelegate.createMany.mockResolvedValue({ count: 0 });
      await expect(store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: false })).resolves.toEqual({
        kind: 'row-already-present',
      });
    });

    it('reports a folder deleted during the import', async () => {
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(formatRecordJson(gitTableSpec));
      dataFolderTableSpecDelegate.createMany.mockRejectedValue(prismaKnownRequestError('P2003'));
      await expect(store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: false })).resolves.toEqual({
        kind: 'data-folder-deleted',
      });
    });

    it('writes nothing on a dry-run', async () => {
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(formatRecordJson(gitTableSpec));
      await expect(store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: true })).resolves.toEqual({
        kind: 'would-import',
        importedDefaultView: false,
      });
      expect(dataFolderTableSpecDelegate.createMany).not.toHaveBeenCalled();
    });
  });
  describe('importTableSpecFromGitIfAbsent: connection with no repo', () => {
    it('reports a connection with no repo separately from a failed git read', async () => {
      const missingRepoPathError = new Error('Connector account coa_airtable01 has no repoPath');
      scratchGitService.resolveConnectionRepoPath.mockRejectedValue(missingRepoPathError);
      await expect(store.importTableSpecFromGitIfAbsent(CONNECTED_LOCATION, { dryRun: false })).resolves.toEqual({
        kind: 'connection-has-no-repo',
        error: missingRepoPathError,
      });
    });
  });

  describe('compareStoredRowWithGit', () => {
    const storedTableSpec = buildTableSpec({ generatedAt: '2026-01-01T00:00:00.000Z' });

    it('reports a folder with no row', async () => {
      await expect(store.compareStoredRowWithGit(CONNECTED_LOCATION)).resolves.toEqual({ kind: 'no-row' });
      expect(scratchGitService.readSchemaFileContentFromGitOrThrow).not.toHaveBeenCalled();
    });

    it('matches when only generatedAt differs and both views are equal', async () => {
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({
        tableSpecContent: formatRecordJson(storedTableSpec),
        defaultViewContent: formatRecordJson(DEFAULT_VIEW as unknown as Record<string, unknown>),
      });
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(
        formatRecordJson(buildTableSpec({ generatedAt: '2026-11-23T00:00:00.000Z' })),
      );
      scratchGitService.readViewFileContentFromGitOrThrow.mockResolvedValue(JSON.stringify(DEFAULT_VIEW));

      // The CLI cache holds the git bytes today, so a generatedAt-only difference is a cache the first scratchmd
      // refresh rewrites; JSON.stringify's compact view isn't the stored formatRecordJson text either.
      await expect(store.compareStoredRowWithGit(CONNECTED_LOCATION)).resolves.toEqual({
        kind: 'matches',
        tableSpecBytesDiffer: true,
        defaultViewBytesDiffer: true,
      });
    });

    it('reports no byte difference when git holds the stored text exactly', async () => {
      const storedDefaultViewContent = formatRecordJson(DEFAULT_VIEW as unknown as Record<string, unknown>);
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({
        tableSpecContent: formatRecordJson(storedTableSpec),
        defaultViewContent: storedDefaultViewContent,
      });
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(formatRecordJson(storedTableSpec));
      scratchGitService.readViewFileContentFromGitOrThrow.mockResolvedValue(storedDefaultViewContent);

      await expect(store.compareStoredRowWithGit(CONNECTED_LOCATION)).resolves.toEqual({
        kind: 'matches',
        tableSpecBytesDiffer: false,
        defaultViewBytesDiffer: false,
      });
    });

    it('reports a table spec that a git-only write changed', async () => {
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({
        tableSpecContent: formatRecordJson(storedTableSpec),
        defaultViewContent: null,
      });
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(
        formatRecordJson(buildTableSpec({ name: 'Renamed by an old revision' })),
      );

      await expect(store.compareStoredRowWithGit(CONNECTED_LOCATION)).resolves.toEqual({
        kind: 'differs',
        tableSpecDiffers: true,
        defaultViewDiffers: false,
        tableSpecBytesDiffer: true,
        defaultViewBytesDiffer: false,
      });
    });

    it('reports a default view that exists in only one place', async () => {
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({
        tableSpecContent: formatRecordJson(storedTableSpec),
        defaultViewContent: null,
      });
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(formatRecordJson(storedTableSpec));
      scratchGitService.readViewFileContentFromGitOrThrow.mockResolvedValue(JSON.stringify(DEFAULT_VIEW));

      await expect(store.compareStoredRowWithGit(CONNECTED_LOCATION)).resolves.toEqual({
        kind: 'differs',
        tableSpecDiffers: false,
        defaultViewDiffers: true,
        tableSpecBytesDiffer: false,
        defaultViewBytesDiffer: true,
      });
    });

    it('never writes Postgres or git', async () => {
      dataFolderTableSpecDelegate.findUnique.mockResolvedValue({
        tableSpecContent: formatRecordJson(storedTableSpec),
        defaultViewContent: null,
      });
      scratchGitService.readSchemaFileContentFromGitOrThrow.mockResolvedValue(
        formatRecordJson(buildTableSpec({ name: 'Different' })),
      );
      await store.compareStoredRowWithGit(CONNECTED_LOCATION);
      expect(dataFolderTableSpecDelegate.upsert).not.toHaveBeenCalled();
      expect(dataFolderTableSpecDelegate.update).not.toHaveBeenCalled();
      expect(dataFolderTableSpecDelegate.createMany).not.toHaveBeenCalled();
      expect(scratchGitService.writeSchemaToGit).not.toHaveBeenCalled();
      expect(scratchGitService.writeViewToGit).not.toHaveBeenCalled();
    });
  });
  describe('readTableSpecsAndDefaultViewsForCliCacheRefresh', () => {
    const WORKBOOK_ID = 'wkb_1';
    const storedTableSpecContent = formatRecordJson(buildTableSpec());
    const storedDefaultViewContent = formatRecordJson(DEFAULT_VIEW as unknown as Record<string, unknown>);
    const storedRowUpdatedAt = new Date('2026-11-20T00:00:00Z');

    function sha256OfUtf8(text: string): string {
      return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    }

    function linkedFolder(
      dataFolderId: string,
      path: string | null,
      storedRow: { tableSpecContent: string; defaultViewContent: string | null } | null,
    ) {
      return {
        id: dataFolderId,
        path,
        storedTableSpecRow: storedRow ? { ...storedRow, updatedAt: storedRowUpdatedAt } : null,
      };
    }

    it('serves present, absent, and unreadable files, with the stored text verbatim', async () => {
      connectorAccountDelegate.findMany.mockResolvedValue([
        {
          id: CONNECTOR_ACCOUNT_ID,
          dataFolders: [
            linkedFolder('dfd_with_view', '/Airtable/Contacts', {
              tableSpecContent: storedTableSpecContent,
              defaultViewContent: storedDefaultViewContent,
            }),
            linkedFolder('dfd_null_view', '/Airtable/Accounts', {
              tableSpecContent: storedTableSpecContent,
              defaultViewContent: null,
            }),
            linkedFolder('dfd_no_row', '/Airtable/Deals', null),
            linkedFolder('dfd_not_object', '/Airtable/Broken', {
              tableSpecContent: '[1, 2]',
              defaultViewContent: 'not json',
            }),
          ],
        },
      ]);

      const connections = await store.readTableSpecsAndDefaultViewsForCliCacheRefresh(WORKBOOK_ID, {
        includeContent: true,
      });

      expect(connectorAccountDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workbookId: WORKBOOK_ID } }),
      );
      expect(connections).toEqual([
        {
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          dataFolders: [
            {
              dataFolderId: 'dfd_null_view',
              folderPath: '/Airtable/Accounts',
              storedRowUpdatedAt,
              tableSpec: {
                status: 'present',
                sha256: sha256OfUtf8(storedTableSpecContent),
                content: storedTableSpecContent,
              },
              defaultView: { status: 'absent' },
            },
            {
              dataFolderId: 'dfd_not_object',
              folderPath: '/Airtable/Broken',
              storedRowUpdatedAt,
              tableSpec: { status: 'unreadable', reason: 'stored-content-not-a-json-object' },
              defaultView: { status: 'unreadable', reason: 'stored-content-not-a-json-object' },
            },
            {
              dataFolderId: 'dfd_with_view',
              folderPath: '/Airtable/Contacts',
              storedRowUpdatedAt,
              tableSpec: {
                status: 'present',
                sha256: sha256OfUtf8(storedTableSpecContent),
                content: storedTableSpecContent,
              },
              defaultView: {
                status: 'present',
                sha256: sha256OfUtf8(storedDefaultViewContent),
                content: storedDefaultViewContent,
              },
            },
            {
              dataFolderId: 'dfd_no_row',
              folderPath: '/Airtable/Deals',
              storedRowUpdatedAt: null,
              tableSpec: { status: 'absent' },
              defaultView: { status: 'absent' },
            },
          ],
        },
      ]);
    });

    it('hashes the UTF-8 bytes of multibyte text and of lone-surrogate escape text, which it serves unchanged', async () => {
      // A lone surrogate is stored as the six-character escape text `\ud83d` (formatRecordJson escapes it).
      const storedContentWithMultibyteAndEscape = formatRecordJson({ name: 'Café 🎉', broken: '\ud83d' });
      expect(storedContentWithMultibyteAndEscape).toContain('\\ud83d');
      connectorAccountDelegate.findMany.mockResolvedValue([
        {
          id: CONNECTOR_ACCOUNT_ID,
          dataFolders: [
            linkedFolder(DATA_FOLDER_ID, FOLDER_PATH, {
              tableSpecContent: storedContentWithMultibyteAndEscape,
              defaultViewContent: null,
            }),
          ],
        },
      ]);

      const [connection] = await store.readTableSpecsAndDefaultViewsForCliCacheRefresh(WORKBOOK_ID, {
        includeContent: true,
      });

      expect(connection.dataFolders[0].tableSpec).toEqual({
        status: 'present',
        sha256: sha256OfUtf8(storedContentWithMultibyteAndEscape),
        content: storedContentWithMultibyteAndEscape,
      });
      // Not the hash of the UTF-16 code units: multibyte characters must hash as UTF-8, like the file on disk.
      expect(sha256OfUtf8(storedContentWithMultibyteAndEscape)).not.toBe(
        createHash('sha256').update(Buffer.from(storedContentWithMultibyteAndEscape, 'utf16le')).digest('hex'),
      );
    });

    it('gives the same statuses and hashes without content in metadata-only mode', async () => {
      const dataFolders = [
        linkedFolder(DATA_FOLDER_ID, FOLDER_PATH, {
          tableSpecContent: storedTableSpecContent,
          defaultViewContent: storedDefaultViewContent,
        }),
        linkedFolder('dfd_no_row', '/Airtable/Deals', null),
      ];
      connectorAccountDelegate.findMany.mockResolvedValue([{ id: CONNECTOR_ACCOUNT_ID, dataFolders }]);

      const withContent = await store.readTableSpecsAndDefaultViewsForCliCacheRefresh(WORKBOOK_ID, {
        includeContent: true,
      });
      const metadataOnly = await store.readTableSpecsAndDefaultViewsForCliCacheRefresh(WORKBOOK_ID, {
        includeContent: false,
      });

      expect(metadataOnly[0].dataFolders[0].tableSpec).toEqual({
        status: 'present',
        sha256: sha256OfUtf8(storedTableSpecContent),
      });
      expect(metadataOnly[0].dataFolders[0].defaultView).toEqual({
        status: 'present',
        sha256: sha256OfUtf8(storedDefaultViewContent),
      });
      const withoutContent = (connections: typeof withContent): unknown =>
        JSON.parse(JSON.stringify(connections, (key, value: unknown) => (key === 'content' ? undefined : value)));
      expect(withoutContent(metadataOnly)).toEqual(withoutContent(withContent));
    });

    it('reads Postgres even while Postgres reads are off, and never touches git', async () => {
      postgresReadsEnabled = false;
      connectorAccountDelegate.findMany.mockResolvedValue([
        { id: CONNECTOR_ACCOUNT_ID, dataFolders: [linkedFolder('dfd_no_row', FOLDER_PATH, null)] },
      ]);

      const [connection] = await store.readTableSpecsAndDefaultViewsForCliCacheRefresh(WORKBOOK_ID, {
        includeContent: true,
      });

      // No row is `absent` (the client deletes its copy), never a fallback to the git copy.
      expect(connection.dataFolders[0].tableSpec).toEqual({ status: 'absent' });
      expect(connectorAccountDelegate.findMany).toHaveBeenCalledTimes(1);
      for (const gitMethod of Object.values(scratchGitService)) expect(gitMethod).not.toHaveBeenCalled();
      expect(metricsService.logValue).not.toHaveBeenCalled();
    });

    it('lists a connection with no linked folders, sorts connections by id, and selects only folders with a path', async () => {
      connectorAccountDelegate.findMany.mockResolvedValue([
        { id: 'coa_zeta', dataFolders: [] },
        { id: 'coa_Alpha', dataFolders: [linkedFolder('dfd_1', '/', null)] },
        { id: 'coa_alpha', dataFolders: [] },
      ]);

      const connections = await store.readTableSpecsAndDefaultViewsForCliCacheRefresh(WORKBOOK_ID, {
        includeContent: false,
      });

      // Code-unit order: uppercase sorts before lowercase, whatever the database collation.
      expect(connections.map((connection) => connection.connectorAccountId)).toEqual([
        'coa_Alpha',
        'coa_alpha',
        'coa_zeta',
      ]);
      expect(connections[2].dataFolders).toEqual([]);
      const [connectorAccountQuery] = connectorAccountDelegate.findMany.mock.calls[0] as [
        { select: { dataFolders: { where: unknown } } },
      ];
      expect(connectorAccountQuery.select.dataFolders.where).toEqual({ path: { not: null } });
    });

    it('scopes to one connection of the workbook, and 404s a connection that is not in it', async () => {
      connectorAccountDelegate.findMany.mockResolvedValueOnce([{ id: CONNECTOR_ACCOUNT_ID, dataFolders: [] }]);
      await expect(
        store.readTableSpecsAndDefaultViewsForCliCacheRefresh(WORKBOOK_ID, {
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          includeContent: false,
        }),
      ).resolves.toEqual([{ connectorAccountId: CONNECTOR_ACCOUNT_ID, dataFolders: [] }]);
      expect(connectorAccountDelegate.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { workbookId: WORKBOOK_ID, id: CONNECTOR_ACCOUNT_ID } }),
      );

      connectorAccountDelegate.findMany.mockResolvedValueOnce([]);
      await expect(
        store.readTableSpecsAndDefaultViewsForCliCacheRefresh(WORKBOOK_ID, {
          connectorAccountId: 'coa_other_tenant',
          includeContent: false,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('rebuildConnectionRepoIndexWithStoredTableSpecs', () => {
    const contactsTableSpec = buildTableSpec({ idPath: dotPath('id.record_id') });
    const postsTableSpec = buildTableSpec({ name: 'Posts' });

    function linkedFolder(
      dataFolderId: string,
      path: string,
      storedTableSpec: BaseJsonTableSpec | string | null,
      updatedAt = new Date('2026-11-20T00:00:00Z'),
    ) {
      return {
        id: dataFolderId,
        path,
        storedTableSpecRow:
          storedTableSpec === null
            ? null
            : {
                tableSpecContent:
                  typeof storedTableSpec === 'string' ? storedTableSpec : formatRecordJson(storedTableSpec),
                updatedAt,
              },
      };
    }

    it('sends no table specs while Postgres reads are off, so scratch-git reads git as before', async () => {
      await expect(
        store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID),
      ).resolves.toEqual({ count: 0 });
      expect(scratchGitService.buildIndex).toHaveBeenCalledWith(REPO_ID);
      expect(dataFolderDelegate.findMany).not.toHaveBeenCalled();
      expect(metricsService.logValue).not.toHaveBeenCalled();
    });

    it('sends each stored spec keyed by the folder path without its leading slash, leaving out folders with no row', async () => {
      postgresReadsEnabled = true;
      dataFolderDelegate.findMany.mockResolvedValue([
        linkedFolder('dfd_contacts', '/Attio/Contacts', contactsTableSpec),
        linkedFolder('dfd_posts', '/Webflow/Blog Posts', postsTableSpec),
        linkedFolder('dfd_never_pulled', '/Attio/Deals', null),
      ]);
      scratchGitService.buildIndex.mockResolvedValue({
        count: 12,
        tableSpecFolderCountFromRequestBody: 2,
        tableSpecFolderCountReadFromGit: 0,
      });

      await expect(
        store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID),
      ).resolves.toEqual({ count: 12 });
      expect(dataFolderDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { connectorAccountId: CONNECTOR_ACCOUNT_ID, path: { not: null } } }),
      );
      expect(scratchGitService.buildIndex).toHaveBeenCalledWith(REPO_ID, {
        'Attio/Contacts': contactsTableSpec,
        'Webflow/Blog Posts': postsTableSpec,
      });
      expect(metricsService.logValue).not.toHaveBeenCalled();
    });

    it('leaves out a row that is not a JSON object and a path that cannot be a key', async () => {
      postgresReadsEnabled = true;
      dataFolderDelegate.findMany.mockResolvedValue([
        linkedFolder('dfd_broken', '/Base/Broken', '[1, 2]'),
        linkedFolder('dfd_trailing_slash', '/Base/Trailing/', postsTableSpec),
        linkedFolder('dfd_contacts', '/Base/Contacts', contactsTableSpec),
      ]);

      await store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID);

      expect(scratchGitService.buildIndex).toHaveBeenCalledWith(REPO_ID, { 'Base/Contacts': contactsTableSpec });
    });

    it('leaves out a stored spec holding a lone UTF-16 surrogate, which scratch-git cannot parse', async () => {
      postgresReadsEnabled = true;
      // As stored by formatRecordJson: the lone high surrogate is written as the ASCII escape \\ud83d.
      const specWithLoneSurrogate = formatRecordJson(buildTableSpec({ name: 'Broken \ud83d emoji' }));
      const validEmojiPairTableSpec = buildTableSpec({ name: 'Fine \ud83d\ude00 emoji' });
      expect(specWithLoneSurrogate).toContain('\\ud83d');
      dataFolderDelegate.findMany.mockResolvedValue([
        linkedFolder('dfd_broken', '/Base/Broken', specWithLoneSurrogate),
        linkedFolder('dfd_emoji_ok', '/Base/Emoji', validEmojiPairTableSpec),
        linkedFolder('dfd_contacts', '/Base/Contacts', contactsTableSpec),
      ]);

      await store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID);

      // Exactly these two keys: the folder holding the lone surrogate is left out; a valid emoji pair is kept.
      expect(scratchGitService.buildIndex).toHaveBeenCalledWith(REPO_ID, {
        'Base/Contacts': contactsTableSpec,
        'Base/Emoji': validEmojiPairTableSpec,
      });
    });

    it('uses the most recently updated row when two folders share a path', async () => {
      postgresReadsEnabled = true;
      dataFolderDelegate.findMany.mockResolvedValue([
        linkedFolder('dfd_newer', '/Base/Contacts', contactsTableSpec, new Date('2026-11-22T00:00:00Z')),
        linkedFolder('dfd_older', '/Base/Contacts', postsTableSpec, new Date('2026-11-01T00:00:00Z')),
      ]);

      await store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID);

      expect(scratchGitService.buildIndex).toHaveBeenCalledWith(REPO_ID, { 'Base/Contacts': contactsTableSpec });
    });

    it.each([
      ['the body is over the client limit', new ScratchGitIndexBuildRequestBodyTooLargeError(50_000_000)],
      ['scratch-git answers 413', new ScratchGitRequestEntityTooLargeError('/api/repo/index/x/build')],
    ])('retries without table specs and counts it when %s', async (_description, tooLargeError) => {
      postgresReadsEnabled = true;
      dataFolderDelegate.findMany.mockResolvedValue([
        linkedFolder('dfd_contacts', '/Base/Contacts', contactsTableSpec),
      ]);
      scratchGitService.buildIndex.mockRejectedValueOnce(tooLargeError).mockResolvedValueOnce({ count: 4 });

      await expect(
        store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID),
      ).resolves.toEqual({ count: 4 });
      expect(scratchGitService.buildIndex).toHaveBeenLastCalledWith(REPO_ID);
      expect(metricsService.logValue).toHaveBeenCalledWith(
        CustomMetric.SCRATCH_GIT_INDEX_BUILD_TABLE_SPECS_NOT_SENT,
        1,
      );
    });

    it('retries without table specs, counts it, and logs an error when scratch-git rejects the body (400)', async () => {
      postgresReadsEnabled = true;
      dataFolderDelegate.findMany.mockResolvedValue([
        linkedFolder('dfd_contacts', '/Base/Contacts', contactsTableSpec),
      ]);
      scratchGitService.buildIndex
        .mockRejectedValueOnce(new ScratchGitBadRequestError('/api/repo/index/x/build', 'invalid table spec'))
        .mockResolvedValueOnce({ count: 5 });
      const errorLogSpy = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);

      await expect(
        store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID),
      ).resolves.toEqual({ count: 5 });
      expect(scratchGitService.buildIndex).toHaveBeenLastCalledWith(REPO_ID);
      expect(metricsService.logValue).toHaveBeenCalledWith(
        CustomMetric.SCRATCH_GIT_INDEX_BUILD_TABLE_SPECS_NOT_SENT,
        1,
      );
      expect(errorLogSpy).toHaveBeenCalledTimes(1);
    });

    it('builds without table specs and counts it when the stored specs cannot be read', async () => {
      postgresReadsEnabled = true;
      dataFolderDelegate.findMany.mockRejectedValue(new Error('connection lost'));

      await store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID);

      expect(scratchGitService.buildIndex).toHaveBeenCalledWith(REPO_ID);
      expect(metricsService.logValue).toHaveBeenCalledWith(
        CustomMetric.SCRATCH_GIT_INDEX_BUILD_TABLE_SPECS_NOT_SENT,
        1,
      );
    });

    it('propagates any other scratch-git failure without retrying', async () => {
      postgresReadsEnabled = true;
      dataFolderDelegate.findMany.mockResolvedValue([
        linkedFolder('dfd_contacts', '/Base/Contacts', contactsTableSpec),
      ]);
      scratchGitService.buildIndex.mockRejectedValue(new Error('HTTP 500'));

      await expect(store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID)).rejects.toThrow(
        'HTTP 500',
      );
      expect(scratchGitService.buildIndex).toHaveBeenCalledTimes(1);
    });

    it('counts the folders scratch-git still read from git, and logs a count mismatch as contract drift', async () => {
      postgresReadsEnabled = true;
      dataFolderDelegate.findMany.mockResolvedValue([
        linkedFolder('dfd_contacts', '/Base/Contacts', contactsTableSpec),
      ]);
      scratchGitService.buildIndex.mockResolvedValue({
        count: 9,
        tableSpecFolderCountFromRequestBody: 0,
        tableSpecFolderCountReadFromGit: 3,
      });
      const errorLogSpy = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);

      await store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID);

      expect(metricsService.logValue).toHaveBeenCalledWith(
        CustomMetric.SCRATCH_GIT_INDEX_BUILD_READ_TABLE_SPEC_FROM_GIT,
        3,
      );
      expect(errorLogSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sentTableSpecFolderCount: 1, tableSpecFolderCountFromRequestBody: 0 }),
      );
    });

    it('counts nothing when an older scratch-git ignores the body (no table-spec counts in its answer)', async () => {
      postgresReadsEnabled = true;
      dataFolderDelegate.findMany.mockResolvedValue([
        linkedFolder('dfd_contacts', '/Base/Contacts', contactsTableSpec),
      ]);
      scratchGitService.buildIndex.mockResolvedValue({ count: 9 });

      await expect(
        store.rebuildConnectionRepoIndexWithStoredTableSpecs(CONNECTOR_ACCOUNT_ID, REPO_ID),
      ).resolves.toEqual({ count: 9 });
      expect(metricsService.logValue).not.toHaveBeenCalled();
    });
  });
});
