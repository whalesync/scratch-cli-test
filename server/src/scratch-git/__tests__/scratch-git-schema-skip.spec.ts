import { BaseJsonTableSpec, dotPath } from '../../remote-service/connectors/types';
import { ScratchGitClient } from '../scratch-git.client';
import { ScratchGitService } from '../scratch-git.service';

const REPO_ID = 'org/wkb/coa';
const FOLDER_PATH = '/public/posts';
const SCHEMA_GIT_PATH = '.scratch/public/posts/schema.json';

function baseSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'public', remoteId: ['public', 'posts'] },
    slug: 'posts',
    name: 'posts',
    schema: { type: 'object', properties: { id: { type: 'string' } } },
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
    basePath: ['public'],
    generatedAt: '2026-05-27T20:08:44.699Z',
  } as unknown as BaseJsonTableSpec;
}

describe('ScratchGitService.writeSchemaToGit — skip when unchanged', () => {
  let service: ScratchGitService;
  let mockCommitFiles: jest.Mock;
  let mockGetFile: jest.Mock;
  let mockDeleteFiles: jest.Mock;

  beforeEach(() => {
    mockCommitFiles = jest
      .fn()
      .mockImplementation((_repo: string, _branch: string, files: { path: string }[]) =>
        Promise.resolve({ created: files.map((f) => f.path), updated: [], unchanged: [] }),
      );
    mockGetFile = jest.fn().mockResolvedValue(null);
    mockDeleteFiles = jest.fn().mockResolvedValue(undefined);

    const mockClient = {
      commitFiles: mockCommitFiles,
      getFile: mockGetFile,
      deleteFiles: mockDeleteFiles,
    } as unknown as ScratchGitClient;
    service = new ScratchGitService(mockClient, {} as never);
  });

  it('writes on first ever write (no existing file)', async () => {
    mockGetFile.mockResolvedValue(null);

    await service.writeSchemaToGit(REPO_ID, FOLDER_PATH, baseSpec());

    // Once for main, once for dirty
    expect(mockCommitFiles).toHaveBeenCalledTimes(2);
    const calls = mockCommitFiles.mock.calls as [string, string, unknown[], string][];
    expect(calls[0][1]).toBe('main');
    expect(calls[1][1]).toBe('dirty');
  });

  it('skips both commits when schema differs only by generatedAt', async () => {
    const existing = { ...baseSpec(), generatedAt: '2020-01-01T00:00:00.000Z' };
    mockGetFile.mockImplementation((_repo: string, _branch: string, path: string) => {
      if (path === SCHEMA_GIT_PATH) {
        return Promise.resolve({ content: JSON.stringify(existing) });
      }
      return Promise.resolve(null);
    });

    const newSpec = { ...baseSpec(), generatedAt: '2026-05-28T00:00:00.000Z' };
    await service.writeSchemaToGit(REPO_ID, FOLDER_PATH, newSpec);

    expect(mockCommitFiles).not.toHaveBeenCalled();
  });

  it('skips when existing has no generatedAt and new schema content matches', async () => {
    const existing = baseSpec();
    delete (existing as { generatedAt?: string }).generatedAt;
    mockGetFile.mockImplementation((_repo: string, _branch: string, path: string) => {
      if (path === SCHEMA_GIT_PATH) {
        return Promise.resolve({ content: JSON.stringify(existing) });
      }
      return Promise.resolve(null);
    });

    await service.writeSchemaToGit(REPO_ID, FOLDER_PATH, baseSpec());

    expect(mockCommitFiles).not.toHaveBeenCalled();
  });

  it('does not falsely diff on undefined-valued optional keys (slugPath regression)', async () => {
    // Existing file on disk doesn't have slugPath (because JSON.stringify dropped it).
    const existing = baseSpec();
    mockGetFile.mockImplementation((_repo: string, _branch: string, path: string) => {
      if (path === SCHEMA_GIT_PATH) {
        return Promise.resolve({ content: JSON.stringify(existing) });
      }
      return Promise.resolve(null);
    });

    // New in-memory spec has slugPath explicitly set to undefined.
    const newSpec = { ...baseSpec(), slugPath: undefined } as BaseJsonTableSpec;
    await service.writeSchemaToGit(REPO_ID, FOLDER_PATH, newSpec);

    expect(mockCommitFiles).not.toHaveBeenCalled();
  });

  it('writes when schema content actually changes', async () => {
    const existing = { ...baseSpec(), name: 'old-name' };
    mockGetFile.mockImplementation((_repo: string, _branch: string, path: string) => {
      if (path === SCHEMA_GIT_PATH) {
        return Promise.resolve({ content: JSON.stringify(existing) });
      }
      return Promise.resolve(null);
    });

    await service.writeSchemaToGit(REPO_ID, FOLDER_PATH, baseSpec()); // name: 'posts'

    expect(mockCommitFiles).toHaveBeenCalledTimes(2);
  });

  it('writes when existing file is malformed JSON', async () => {
    mockGetFile.mockImplementation((_repo: string, _branch: string, path: string) => {
      if (path === SCHEMA_GIT_PATH) {
        return Promise.resolve({ content: '{not valid json' });
      }
      return Promise.resolve(null);
    });

    await service.writeSchemaToGit(REPO_ID, FOLDER_PATH, baseSpec());

    expect(mockCommitFiles).toHaveBeenCalledTimes(2);
  });
});
