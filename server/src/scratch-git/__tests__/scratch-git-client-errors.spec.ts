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
      getScratchGitAuthToken: () => undefined,
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

describe('ScratchGitClient.callGitApi — shared bearer token (DEV-10600)', () => {
  let capturedHeaders: Record<string, string> | undefined;

  /** Install a fetch mock that captures the request headers and returns an empty OK envelope. */
  function mockOkFetchCapturingHeaders(): void {
    capturedHeaders = undefined;
    global.fetch = jest.fn().mockImplementation((_url: string, options: RequestInit) => {
      capturedHeaders = options.headers as Record<string, string>;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ data: {}, status: {} })),
      });
    }) as unknown as typeof fetch;
  }

  function clientWithToken(token: string | undefined): ScratchGitClient {
    const mockConfigService = {
      getScratchGitApiUrl: () => 'http://scratch-git.test',
      getScratchGitAuthToken: () => token,
    } as unknown as ScratchConfigService;
    return new ScratchGitClient(mockConfigService);
  }

  afterEach(() => jest.restoreAllMocks());

  it('sends Authorization: Bearer <token> when a token is configured', async () => {
    mockOkFetchCapturingHeaders();

    await clientWithToken('the-shared-token').gc(REPO_ID);

    expect(capturedHeaders?.Authorization).toBe('Bearer the-shared-token');
  });

  it('sends no Authorization header when no token is configured (legacy)', async () => {
    mockOkFetchCapturingHeaders();

    await clientWithToken(undefined).gc(REPO_ID);

    expect(capturedHeaders?.Authorization).toBeUndefined();
  });
});
