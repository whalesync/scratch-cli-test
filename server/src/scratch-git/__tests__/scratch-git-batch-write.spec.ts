import { CommitFilesResult, ScratchGitClient } from '../scratch-git.client';
import { ScratchGitService } from '../scratch-git.service';

/** Create a file entry with a specific content size in bytes. */
function makeFile(index: number, contentBytes: number): { path: string; content: string } {
  return {
    path: `folder/file-${index}.json`,
    content: 'x'.repeat(contentBytes),
  };
}

describe('ScratchGitService.commitFilesToBranch', () => {
  let service: ScratchGitService;
  let mockCommitFiles: jest.Mock;

  beforeEach(() => {
    mockCommitFiles = jest
      .fn()
      .mockImplementation((_repo: string, _branch: string, files: { path: string; content: string }[]) =>
        Promise.resolve({
          created: files.map((f) => f.path),
          updated: [],
          unchanged: [],
        } satisfies CommitFilesResult),
      );

    const mockClient = { commitFiles: mockCommitFiles } as unknown as ScratchGitClient;
    service = new ScratchGitService(mockClient, {} as never);
  });

  it('sends all files in a single request when under the size limit', async () => {
    const files = Array.from({ length: 10 }, (_, i) => makeFile(i, 100));

    const result = await service.commitFilesToBranch('repo', 'dirty', files, 'msg');

    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    expect(result.created).toHaveLength(10);
  });

  it('chunks files into multiple requests when total size exceeds the limit', async () => {
    // Each file is ~1MB of content + 40 bytes overhead ≈ 1MB per entry.
    // Default chunk limit is 40MB, so 60 files should produce 2 chunks.
    const files = Array.from({ length: 60 }, (_, i) => makeFile(i, 1_000_000));

    const result = await service.commitFilesToBranch('repo', 'dirty', files, 'Sync');

    expect(mockCommitFiles).toHaveBeenCalledTimes(2);
    expect(result.created).toHaveLength(60);

    // Verify chunk messages include numbering
    const calls = mockCommitFiles.mock.calls as [string, string, unknown[], string][];
    expect(calls[0][3]).toBe('Sync (1/2)');
    expect(calls[1][3]).toBe('Sync (2/2)');
  });

  it('does not add chunk numbering when only one chunk is needed', async () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile(i, 100));

    await service.commitFilesToBranch('repo', 'dirty', files, 'Sync');

    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    const calls = mockCommitFiles.mock.calls as [string, string, unknown[], string][];
    expect(calls[0][3]).toBe('Sync');
  });

  it('handles empty file list without calling the client', async () => {
    const result = await service.commitFilesToBranch('repo', 'dirty', [], 'msg');

    expect(mockCommitFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ created: [], updated: [], unchanged: [] });
  });

  it('chunks staging uploads by payload size so a spill never exceeds the request body limit', async () => {
    const mockStageFiles = jest.fn().mockResolvedValue({ count: 0 });
    const mockClient = { stageFiles: mockStageFiles } as unknown as ScratchGitClient;
    const stagingService = new ScratchGitService(mockClient, {} as never);

    // ~1MB per file → 60MB total: must split into 2 requests under the 40MB
    // target (a single unchunked spill would 413 at scratch-git's 50MB limit).
    const files = Array.from({ length: 60 }, (_, i) => makeFile(i, 1_000_000));
    await stagingService.stageFiles('job-1', 'Charges', files);

    expect(mockStageFiles).toHaveBeenCalledTimes(2);
    const stagedCalls = mockStageFiles.mock.calls as [string, string, { path: string; content: string }[]][];
    expect(stagedCalls[0][0]).toBe('job-1');
    expect(stagedCalls[0][1]).toBe('Charges');
    // Every file arrives exactly once, in order.
    const allStagedPaths = stagedCalls.flatMap(([, , chunk]) => chunk.map((f) => f.path));
    expect(allStagedPaths).toEqual(files.map((f) => f.path));
  });

  it('aggregates created/updated/unchanged across chunks', async () => {
    let callIndex = 0;
    mockCommitFiles.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({ created: ['a', 'b'], updated: ['c'], unchanged: [] });
      }
      return Promise.resolve({ created: [], updated: ['d'], unchanged: ['e'] });
    });

    const files = Array.from({ length: 60 }, (_, i) => makeFile(i, 1_000_000));
    const result = await service.commitFilesToBranch('repo', 'dirty', files, 'msg');

    expect(result.created).toEqual(['a', 'b']);
    expect(result.updated).toEqual(['c', 'd']);
    expect(result.unchanged).toEqual(['e']);
  });

  it('handles a single file larger than the chunk limit', async () => {
    // One file at 50MB should still go through as a single chunk
    const files = [makeFile(0, 50_000_000)];

    const result = await service.commitFilesToBranch('repo', 'dirty', files, 'msg');

    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    expect(result.created).toHaveLength(1);
  });
});
