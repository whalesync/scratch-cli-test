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
});
