import { CredentialEncryptionService } from '../../credential-encryption/credential-encryption.service';
import { DbService } from '../../db/db.service';
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
      listRepoFilesPaginated: jest.fn(),
      getRepoFilesPaginated: jest.fn(),
    } as unknown as jest.Mocked<Pick<ScratchGitService, 'listRepoFilesPaginated' | 'getRepoFilesPaginated'>>;

    const service = new PublishFromGitService(
      {} as DbService,
      scratchGitService as unknown as ScratchGitService,
      {} as ConnectorsService,
      {} as CredentialEncryptionService,
      {} as FileReferenceService,
      {} as RefResolverService,
      {} as SchemaHelperService,
    );

    return { service, scratchGitService };
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
});
