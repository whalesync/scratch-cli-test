import { ScratchConfigService } from '../../config/scratch-config.service';
import { WSLogger } from '../../logger';
import { ScratchGitClient, ScratchGitConflictError, ScratchGitNotFoundError } from '../scratch-git.client';

const REPO_ID = 'org/wkb/coa';

describe('ScratchGitClient.callGitApi — HTTP error mapping', () => {
  let client: ScratchGitClient;
  let errorLogSpy: jest.SpyInstance;

  beforeEach(() => {
    const mockConfigService = {
      getScratchGitApiUrl: () => 'http://scratch-git.test',
    } as unknown as ScratchConfigService;
    client = new ScratchGitClient(mockConfigService);
    errorLogSpy = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockFetchResponse(status: number, body: string): void {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    }) as unknown as typeof fetch;
  }

  it('throws a typed ScratchGitConflictError on 409 without logging at error level', async () => {
    mockFetchResponse(409, 'GC already in progress');

    await expect(client.gc(REPO_ID)).rejects.toBeInstanceOf(ScratchGitConflictError);
    expect(errorLogSpy).not.toHaveBeenCalled();
  });

  it('throws a typed ScratchGitNotFoundError on 404 without logging at error level', async () => {
    mockFetchResponse(404, 'repo not found');

    await expect(client.gc(REPO_ID)).rejects.toBeInstanceOf(ScratchGitNotFoundError);
    expect(errorLogSpy).not.toHaveBeenCalled();
  });

  it('throws a generic Error and logs at error level on 500', async () => {
    mockFetchResponse(500, 'internal error');

    await expect(client.gc(REPO_ID)).rejects.toThrow(/HTTP 500/);
    expect(errorLogSpy).toHaveBeenCalledTimes(1);
  });
});
