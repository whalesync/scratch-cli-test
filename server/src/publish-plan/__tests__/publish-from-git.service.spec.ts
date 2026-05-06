import { CredentialEncryptionService } from '../../credential-encryption/credential-encryption.service';
import { DbService } from '../../db/db.service';
import { Connector } from '../../remote-service/connectors/connector';
import { ConnectorsService } from '../../remote-service/connectors/connectors.service';
import { ScratchGitNotFoundError } from '../../scratch-git/scratch-git.client';
import { ScratchGitService } from '../../scratch-git/scratch-git.service';
import { FileReferenceService } from '../file-reference.service';
import { PublishFromGitService } from '../publish-from-git.service';
import { RefResolverService } from '../ref-resolver.service';
import { SchemaHelperService } from '../schema-helper.service';

describe('PublishFromGitService', () => {
  function makeService() {
    const scratchGitService = {
      resolveConnectionRepoPath: jest.fn(),
      getRepoFile: jest.fn(),
      listRepoFiles: jest.fn(),
      listRepoFilesPaginated: jest.fn(),
      getRepoFilesPaginated: jest.fn(),
      rebaseDirty: jest.fn(),
      commitFilesToBranch: jest.fn(),
      lookupFilenamesByFolder: jest.fn().mockResolvedValue(new Map()),
      deleteFilesFromBranch: jest.fn(),
      deleteIndexEntries: jest.fn(),
      upsertIndexEntries: jest.fn(),
      renameFiles: jest.fn(),
    } as unknown as jest.Mocked<
      Pick<
        ScratchGitService,
        | 'resolveConnectionRepoPath'
        | 'getRepoFile'
        | 'listRepoFiles'
        | 'listRepoFilesPaginated'
        | 'getRepoFilesPaginated'
        | 'rebaseDirty'
        | 'commitFilesToBranch'
        | 'lookupFilenamesByFolder'
        | 'deleteFilesFromBranch'
        | 'deleteIndexEntries'
        | 'upsertIndexEntries'
        | 'renameFiles'
      >
    >;

    const connector = {
      getBatchSize: jest.fn().mockReturnValue(2),
      pullRecordFilesByIds: jest
        .fn()
        .mockImplementation(
          async (_tableSpec: unknown, _ids: unknown, callback: (params: { files: unknown[] }) => Promise<void>) => {
            await callback({ files: [] });
          },
        ),
      updateRecords: jest.fn(),
      createRecords: jest.fn(),
      deleteRecords: jest.fn(),
      resolveAssetReference: jest.fn(),
      extractConnectorErrorDetails: jest.fn().mockReturnValue({
        userFriendlyMessage: 'Invalid date for published_at',
        description: 'invalid input syntax for type date',
      }),
    } as unknown as jest.Mocked<Connector>;

    const db = {
      client: {
        connectorAccount: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'coa_1',
            service: 'postgres',
            encryptedCredentials: {},
          }),
        },
        fileReference: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      },
    } as unknown as DbService;

    const connectorsService = {
      getConnector: jest.fn().mockResolvedValue(connector),
    } as unknown as jest.Mocked<Pick<ConnectorsService, 'getConnector'>>;

    const credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({ connectionString: 'postgres://test' }),
    } as unknown as jest.Mocked<Pick<CredentialEncryptionService, 'decryptCredentials'>>;

    const fileReferenceService = {
      updateRefsForFiles: jest.fn(),
    } as unknown as jest.Mocked<Pick<FileReferenceService, 'updateRefsForFiles'>>;

    const refResolverService = {
      resolveBatchPseudoRefs: jest.fn().mockImplementation((_workbookId: unknown, contents: unknown[]) => contents),
    } as unknown as jest.Mocked<Pick<RefResolverService, 'resolveBatchPseudoRefs'>>;

    const schemaService = {
      getTableSpec: jest.fn().mockResolvedValue({
        id: { wsId: 'posts', remoteId: ['public', 'posts'] },
        slug: 'posts',
        name: 'posts',
        schema: {},
        idColumnRemoteId: 'id',
      }),
    } as unknown as jest.Mocked<Pick<SchemaHelperService, 'getTableSpec'>>;

    const service = new PublishFromGitService(
      db,
      scratchGitService as unknown as ScratchGitService,
      connectorsService as unknown as ConnectorsService,
      credentialEncryptionService as unknown as CredentialEncryptionService,
      fileReferenceService as unknown as FileReferenceService,
      refResolverService as unknown as RefResolverService,
      schemaService as unknown as SchemaHelperService,
    );

    return {
      service,
      scratchGitService,
      connector,
      connectorsService,
      credentialEncryptionService,
      schemaService,
      fileReferenceService,
    };
  }

  it('treats a missing phase folder as an empty metadata page', async () => {
    const { service, scratchGitService } = makeService();
    scratchGitService.listRepoFilesPaginated.mockRejectedValue(
      new ScratchGitNotFoundError('/api/repo/read/test/files-paginated', 'not found'),
    );

    const access = service as unknown as {
      listPhaseFilesPage: (
        repoId: string,
        phaseDir: string,
        limit: number,
        cursor?: string,
      ) => Promise<{ files: Array<{ name: string; path: string }>; nextCursor?: string }>;
    };

    await expect(access.listPhaseFilesPage('repo_1', '.scratch/public/posts/delete', 500)).resolves.toEqual({
      files: [],
    });
  });

  it('treats a missing phase folder as an empty content page', async () => {
    const { service, scratchGitService } = makeService();
    scratchGitService.getRepoFilesPaginated.mockRejectedValue(
      new ScratchGitNotFoundError('/api/repo/read/test/files-paginated', 'not found'),
    );

    const access = service as unknown as {
      readPhaseFilesPage: (
        repoId: string,
        phaseDir: string,
        limit: number,
        cursor?: string,
      ) => Promise<{ files: Array<{ name: string; content: string }>; nextCursor?: string }>;
    };

    await expect(access.readPhaseFilesPage('repo_1', '.scratch/public/posts/backfill', 100)).resolves.toEqual({
      files: [],
    });
  });

  it('fails fast on the first failed batch and still rebases dirty', async () => {
    const { service, scratchGitService, connector } = makeService();
    const progressUpdates: Array<Record<string, unknown>> = [];

    scratchGitService.resolveConnectionRepoPath.mockResolvedValue('repo_1');
    scratchGitService.getRepoFile.mockResolvedValue({
      content: JSON.stringify({
        planId: 'plan_1',
        createdAt: '2026-04-15T00:00:00.000Z',
        connectionName: 'Postgres',
        connectionId: 'coa_1',
        summary: { edit: 2, create: 0, delete: 0, backfill: 0, rename: 0 },
        tablePaths: ['public/posts'],
      }),
    });
    scratchGitService.listRepoFiles.mockResolvedValue([{ type: 'directory', name: 'publish-plan-20260415' }]);
    scratchGitService.listRepoFilesPaginated.mockResolvedValue({ files: [] });
    scratchGitService.getRepoFilesPaginated.mockImplementation(
      (_repoId: unknown, _branch: unknown, phaseDir: unknown) => {
        if (String(phaseDir).endsWith('/edit')) {
          return {
            files: [
              {
                name: 'record-2.json',
                content: JSON.stringify({
                  content: { id: 2, published_at: '2026-04-15' },
                  changedFields: { published_at: '2026-04-15' },
                }),
              },
              {
                name: 'record-1.json',
                content: JSON.stringify({
                  content: { id: 1, published_at: 'not-a-date' },
                  changedFields: { published_at: 'not-a-date' },
                }),
              },
            ],
          };
        }
        return { files: [] };
      },
    );
    connector.updateRecords.mockRejectedValue(new Error('raw postgres error'));

    await expect(
      service.runFromGit('wkb_1', 'coa_1', '.scratch/publish-plans/plan_1', (progress) => {
        progressUpdates.push(progress as unknown as Record<string, unknown>);
        return Promise.resolve();
      }),
    ).rejects.toThrow('Invalid date for published_at');

    expect(connector.updateRecords.mock.calls).toHaveLength(1);
    expect(connector.updateRecords.mock.calls[0]?.[1]).toEqual([
      { id: 1, published_at: 'not-a-date' },
      { id: 2, published_at: '2026-04-15' },
    ]);
    expect(scratchGitService.rebaseDirty).toHaveBeenCalledTimes(1);

    const lastProgress = progressUpdates.at(-1);
    expect(lastProgress).toMatchObject({
      currentPhase: 'edit',
      currentTableName: 'posts',
      processedCount: 0,
      successCount: 0,
      failedCount: 2,
    });
  });

  it('commits refreshed connector rows to main and dirty after edit publish', async () => {
    const { service, scratchGitService, connector, fileReferenceService } = makeService();

    scratchGitService.resolveConnectionRepoPath.mockResolvedValue('repo_1');
    scratchGitService.getRepoFile.mockResolvedValue({
      content: JSON.stringify({
        planId: 'plan_1',
        createdAt: '2026-04-17T00:00:00.000Z',
        connectionName: 'Postgres',
        connectionId: 'coa_1',
        summary: { edit: 1, create: 0, delete: 0, backfill: 0, rename: 0 },
        tablePaths: ['public/posts'],
      }),
    });
    scratchGitService.listRepoFiles.mockResolvedValue([{ type: 'directory', name: 'publish-plan-20260417' }]);
    scratchGitService.listRepoFilesPaginated.mockResolvedValue({ files: [] });
    scratchGitService.getRepoFilesPaginated.mockImplementation(
      (_repoId: unknown, _branch: unknown, phaseDir: unknown) => {
        if (String(phaseDir).endsWith('/edit')) {
          return {
            files: [
              {
                name: 'record-1.json',
                content: JSON.stringify({
                  content: { id: 1, title: 'Updated', lastUpdated: '2026-04-17T16:00:00.000Z' },
                  changedFields: { title: 'Updated' },
                }),
              },
            ],
          };
        }
        return { files: [] };
      },
    );
    connector.updateRecords.mockResolvedValue(undefined);
    connector.pullRecordFilesByIds.mockImplementation(async (_tableSpec, ids, callback) => {
      expect(ids).toEqual(['1']);
      await callback({
        files: [{ id: 1, title: 'Updated', lastUpdated: '2026-04-17T16:30:00.000Z' }],
      });
    });

    await service.runFromGit('wkb_1', 'coa_1', '.scratch/publish-plans/plan_1');

    expect(fileReferenceService.updateRefsForFiles).toHaveBeenCalledWith('wkb_1', 'main', [
      {
        path: 'public/posts/record-1.json',
        content: { id: 1, title: 'Updated', lastUpdated: '2026-04-17T16:30:00.000Z' },
      },
    ]);

    const mainCommit = scratchGitService.commitFilesToBranch.mock.calls.find(([, branch]) => branch === 'main');
    expect(mainCommit).toBeDefined();
    expect(JSON.parse(mainCommit![2][0].content)).toMatchObject({
      id: 1,
      title: 'Updated',
      lastUpdated: '2026-04-17T16:30:00.000Z',
    });

    const dirtyCommit = scratchGitService.commitFilesToBranch.mock.calls.find(([, branch]) => branch === 'dirty');
    expect(dirtyCommit).toBeDefined();
    expect(JSON.parse(dirtyCommit![2][0].content)).toMatchObject({
      id: 1,
      title: 'Updated',
      lastUpdated: '2026-04-17T16:30:00.000Z',
    });
  });

  it('resolves missing remote ids via a single batched filename lookup per page', async () => {
    const { service, scratchGitService, connector } = makeService();

    scratchGitService.resolveConnectionRepoPath.mockResolvedValue('repo_1');
    scratchGitService.getRepoFile.mockResolvedValue({
      content: JSON.stringify({
        planId: 'plan_1',
        createdAt: '2026-05-01T00:00:00.000Z',
        connectionName: 'Postgres',
        connectionId: 'coa_1',
        summary: { edit: 3, create: 0, delete: 0, backfill: 0, rename: 0 },
        tablePaths: ['public/posts'],
      }),
    });
    scratchGitService.listRepoFiles.mockResolvedValue([{ type: 'directory', name: 'publish-plan-20260501' }]);
    scratchGitService.listRepoFilesPaginated.mockResolvedValue({ files: [] });
    // Batch size of 3 so all three edit files land in one page (one parse+resolve pass).
    connector.getBatchSize.mockReturnValue(3);
    scratchGitService.getRepoFilesPaginated.mockImplementation((_repo, _branch, phaseDir) => {
      if (String(phaseDir).endsWith('/edit')) {
        return {
          files: [
            // Has id in content — should NOT trigger a lookup for this filename.
            {
              name: 'record-1.json',
              content: JSON.stringify({
                content: { id: 1, title: 'has-id-1' },
                changedFields: { title: 'has-id-1' },
              }),
            },
            // Missing id — should be looked up.
            {
              name: 'record-2.json',
              content: JSON.stringify({
                content: { title: 'needs-lookup-2' },
                changedFields: { title: 'needs-lookup-2' },
              }),
            },
            // Missing id — should be looked up in the same batch as record-2.
            {
              name: 'record-3.json',
              content: JSON.stringify({
                content: { title: 'needs-lookup-3' },
                changedFields: { title: 'needs-lookup-3' },
              }),
            },
          ],
        };
      }
      return { files: [] };
    });
    scratchGitService.lookupFilenamesByFolder.mockResolvedValue(
      new Map<string, string>([
        ['record-2.json', '2'],
        ['record-3.json', '3'],
      ]),
    );
    connector.updateRecords.mockResolvedValue(undefined);

    await service.runFromGit('wkb_1', 'coa_1', '.scratch/publish-plans/plan_1');

    // One call total, with both missing filenames — not one per entry.
    expect(scratchGitService.lookupFilenamesByFolder).toHaveBeenCalledTimes(1);
    expect(scratchGitService.lookupFilenamesByFolder).toHaveBeenCalledWith('repo_1', 'public/posts', [
      'record-2.json',
      'record-3.json',
    ]);

    // Resolved string ids are injected into the contents handed to the connector, while the
    // already-present numeric id on record-1 is preserved as-is (not stringified).
    expect(connector.updateRecords.mock.calls).toHaveLength(1);
    const sentContents = connector.updateRecords.mock.calls[0][1];
    expect(sentContents).toEqual([
      { id: 1, title: 'has-id-1' },
      { id: '2', title: 'needs-lookup-2' },
      { id: '3', title: 'needs-lookup-3' },
    ]);
  });

  it('throws when an entry without an id in content has no entry in the file index', async () => {
    const { service, scratchGitService, connector } = makeService();

    scratchGitService.resolveConnectionRepoPath.mockResolvedValue('repo_1');
    scratchGitService.getRepoFile.mockResolvedValue({
      content: JSON.stringify({
        planId: 'plan_1',
        createdAt: '2026-05-02T00:00:00.000Z',
        connectionName: 'Postgres',
        connectionId: 'coa_1',
        summary: { edit: 1, create: 0, delete: 0, backfill: 0, rename: 0 },
        tablePaths: ['public/posts'],
      }),
    });
    scratchGitService.listRepoFiles.mockResolvedValue([{ type: 'directory', name: 'publish-plan-20260502' }]);
    scratchGitService.listRepoFilesPaginated.mockResolvedValue({ files: [] });
    scratchGitService.getRepoFilesPaginated.mockImplementation((_repo, _branch, phaseDir) => {
      if (String(phaseDir).endsWith('/edit')) {
        return {
          files: [
            {
              name: 'orphan.json',
              content: JSON.stringify({
                content: { title: 'no-id-here' },
                changedFields: { title: 'no-id-here' },
              }),
            },
          ],
        };
      }
      return { files: [] };
    });
    scratchGitService.lookupFilenamesByFolder.mockResolvedValue(new Map());
    // Surface the original error message via the connector wrapper so we can assert on it.
    (connector.extractConnectorErrorDetails as jest.Mock).mockImplementation((err: Error) => ({
      userFriendlyMessage: err.message,
      description: err.message,
    }));

    await expect(service.runFromGit('wkb_1', 'coa_1', '.scratch/publish-plans/plan_1')).rejects.toThrow(
      'Could not resolve remote ID for entry: public/posts/orphan.json',
    );
    expect(connector.updateRecords.mock.calls).toHaveLength(0);
    expect(scratchGitService.rebaseDirty.mock.calls).toHaveLength(1);
  });

  it('reads, injects, and dispatches dot-path idColumnRemoteId values correctly', async () => {
    const { service, scratchGitService, connector, schemaService } = makeService();
    schemaService.getTableSpec.mockResolvedValue({
      id: { wsId: 'companies', remoteId: ['attio', 'companies'] },
      slug: 'companies',
      name: 'companies',
      schema: {},
      idColumnRemoteId: 'id.record_id',
    } as unknown as Awaited<ReturnType<SchemaHelperService['getTableSpec']>>);

    scratchGitService.resolveConnectionRepoPath.mockResolvedValue('repo_1');
    scratchGitService.getRepoFile.mockResolvedValue({
      content: JSON.stringify({
        planId: 'plan_dotpath',
        createdAt: '2026-05-03T00:00:00.000Z',
        connectionName: 'Attio',
        connectionId: 'coa_1',
        summary: { edit: 1, create: 0, delete: 1, backfill: 0, rename: 0 },
        tablePaths: ['attio/companies'],
      }),
    });
    scratchGitService.listRepoFiles.mockResolvedValue([{ type: 'directory', name: 'publish-plan-20260503' }]);
    scratchGitService.listRepoFilesPaginated.mockResolvedValue({ files: [] });
    scratchGitService.getRepoFilesPaginated.mockImplementation((_repo, _branch, phaseDir) => {
      const dir = String(phaseDir);
      // Edit phase: content lacks the id → triggers a filename-index lookup that
      // returns a string id which then gets injected at the nested path.
      if (dir.endsWith('/edit')) {
        return {
          files: [
            {
              name: 'acme.json',
              content: JSON.stringify({
                content: { name: 'Acme' },
                changedFields: { name: 'Acme' },
              }),
            },
          ],
        };
      }
      // Delete phase: remoteId is in the file as a flat scalar — the dispatch must
      // build a nested filter from it.
      if (dir.endsWith('/delete')) {
        return {
          files: [
            {
              name: 'gone.json',
              content: JSON.stringify({ remoteId: 'rec_99' }),
            },
          ],
        };
      }
      return { files: [] };
    });
    scratchGitService.lookupFilenamesByFolder.mockResolvedValue(new Map([['acme.json', 'rec_42']]));
    connector.updateRecords.mockResolvedValue(undefined);
    connector.deleteRecords.mockResolvedValue(undefined);

    await service.runFromGit('wkb_1', 'coa_1', '.scratch/publish-plans/plan_dotpath');

    // Edit: looked-up id was set at the dot path, not as a flat key.
    const sentEditContents = connector.updateRecords.mock.calls[0][1];
    expect(sentEditContents).toEqual([{ id: { record_id: 'rec_42' }, name: 'Acme' }]);
    expect((sentEditContents[0] as Record<string, unknown>)['id.record_id']).toBeUndefined();

    // Delete: filter is shaped as a nested object the connector can use to address the row.
    expect(connector.deleteRecords.mock.calls).toHaveLength(1);
    const sentDeleteFilters = connector.deleteRecords.mock.calls[0][1];
    expect(sentDeleteFilters).toEqual([{ id: { record_id: 'rec_99' } }]);
  });

  it('skips delete-phase entries whose file is missing remoteId, without calling the connector', async () => {
    const { service, scratchGitService, connector } = makeService();

    scratchGitService.resolveConnectionRepoPath.mockResolvedValue('repo_1');
    scratchGitService.getRepoFile.mockResolvedValue({
      content: JSON.stringify({
        planId: 'plan_skip',
        createdAt: '2026-05-04T00:00:00.000Z',
        connectionName: 'Postgres',
        connectionId: 'coa_1',
        summary: { edit: 0, create: 0, delete: 1, backfill: 0, rename: 0 },
        tablePaths: ['public/posts'],
      }),
    });
    scratchGitService.listRepoFiles.mockResolvedValue([{ type: 'directory', name: 'publish-plan-20260504' }]);
    scratchGitService.listRepoFilesPaginated.mockResolvedValue({ files: [] });
    scratchGitService.getRepoFilesPaginated.mockImplementation((_repo, _branch, phaseDir) => {
      if (String(phaseDir).endsWith('/delete')) {
        return {
          files: [
            // No remoteId field — parser should warn and return null; entry is skipped.
            { name: 'malformed.json', content: JSON.stringify({}) },
          ],
        };
      }
      return { files: [] };
    });

    await service.runFromGit('wkb_1', 'coa_1', '.scratch/publish-plans/plan_skip');

    expect(connector.deleteRecords.mock.calls).toHaveLength(0);
    expect(scratchGitService.deleteFilesFromBranch.mock.calls).toHaveLength(0);
    expect(scratchGitService.rebaseDirty.mock.calls).toHaveLength(1);
  });
});
