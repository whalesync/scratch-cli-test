import { readFileSync } from 'fs';
import { join } from 'path';
import { ScratchConfigService } from '../../config/scratch-config.service';
import { WSLogger } from '../../logger';
import {
  MAXIMUM_SCRATCH_GIT_INDEX_BUILD_REQUEST_BODY_BYTES,
  ScratchGitBadRequestError,
  ScratchGitClient,
  ScratchGitIndexBuildRequestBodyTooLargeError,
  ScratchGitRequestEntityTooLargeError,
} from '../scratch-git.client';

const REPO_ID = 'org/wkb/coa';

/**
 * The build-index request-body contract fixture that scratch-git's Rust tests parse (DEV-12616 MR2a). Asserting the
 * client serializes exactly this shape pins both sides of the contract: a renamed field fails one suite or the other.
 */
const BUILD_INDEX_REQUEST_BODY_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '../../../../scratch-git-2/tests/fixtures/build-index-request-body.json'), 'utf8'),
) as { tableSpecsByRepoRelativeFolderKey: Record<string, Record<string, unknown>> };

describe('ScratchGitClient.buildIndex — table specs in the request body (DEV-12616)', () => {
  let client: ScratchGitClient;
  let capturedRequest: { url: string; options: RequestInit } | undefined;

  function mockFetchResponding(status: number, responseBody: string): jest.Mock {
    capturedRequest = undefined;
    const fetchMock = jest.fn().mockImplementation((url: string, options: RequestInit) => {
      capturedRequest = { url, options };
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(responseBody),
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  beforeEach(() => {
    client = new ScratchGitClient({
      getScratchGitApiUrl: () => 'http://scratch-git.test',
      getScratchGitAuthToken: () => undefined,
    } as unknown as ScratchConfigService);
    jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends no body when no table specs are given (what every server sent before DEV-12616)', async () => {
    mockFetchResponding(200, JSON.stringify({ data: { count: 3 } }));

    await expect(client.buildIndex(REPO_ID)).resolves.toEqual({ count: 3 });
    expect(capturedRequest?.url).toBe('http://scratch-git.test/api/repo/index/org%2Fwkb%2Fcoa/build');
    expect(capturedRequest?.options.method).toBe('POST');
    expect(capturedRequest?.options.body).toBeUndefined();
  });

  it('serializes the table specs exactly as the shared contract fixture', async () => {
    mockFetchResponding(
      200,
      JSON.stringify({
        data: { count: 7, tableSpecFolderCountFromRequestBody: 2, tableSpecFolderCountReadFromGit: 0 },
      }),
    );

    const indexBuildResult = await client.buildIndex(
      REPO_ID,
      BUILD_INDEX_REQUEST_BODY_FIXTURE.tableSpecsByRepoRelativeFolderKey,
    );

    expect(JSON.parse(capturedRequest?.options.body as string)).toEqual(BUILD_INDEX_REQUEST_BODY_FIXTURE);
    expect(indexBuildResult).toEqual({
      count: 7,
      tableSpecFolderCountFromRequestBody: 2,
      tableSpecFolderCountReadFromGit: 0,
    });
  });

  it('sends nothing and throws a typed error when the body would exceed the limit', async () => {
    const fetchMock = mockFetchResponding(200, JSON.stringify({ data: { count: 0 } }));
    const oversizedTableSpec = {
      schema: { description: 'x'.repeat(MAXIMUM_SCRATCH_GIT_INDEX_BUILD_REQUEST_BODY_BYTES) },
    };

    await expect(client.buildIndex(REPO_ID, { contacts: oversizedTableSpec })).rejects.toBeInstanceOf(
      ScratchGitIndexBuildRequestBodyTooLargeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a typed error when scratch-git answers 413', async () => {
    mockFetchResponding(413, '<html>413 Request Entity Too Large</html>');
    await expect(client.buildIndex(REPO_ID, { contacts: { schema: {} } })).rejects.toBeInstanceOf(
      ScratchGitRequestEntityTooLargeError,
    );
  });

  it('throws a typed error when scratch-git answers 400', async () => {
    mockFetchResponding(400, '{"error":"invalid table spec for folder key contacts"}');
    await expect(client.buildIndex(REPO_ID, { contacts: { schema: {} } })).rejects.toBeInstanceOf(
      ScratchGitBadRequestError,
    );
  });
});
