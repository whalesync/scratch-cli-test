import { createApiClient } from '../../../create-api-client';
import { SANITY_PROJECT_ID_NOT_A_PLAIN_LABEL_MESSAGE, SanityApiClient, SanityError } from '../sanity-api-client';
import { SanityConnector } from '../sanity-connector';

// Stand-in HTTP clients, so a test can tell whether any request was attempted.
jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: jest.fn().mockResolvedValue({ data: [] }),
    post: jest.fn().mockResolvedValue({ data: { result: [] } }),
  })),
}));

const createApiClientMock = createApiClient as jest.Mock;

interface StandInHttpClient {
  get: jest.Mock;
  post: jest.Mock;
}

function standInHttpClientsCreatedSoFar(): StandInHttpClient[] {
  return createApiClientMock.mock.results.map((result) => result.value as StandInHttpClient);
}

function expectNoRequestSent(): void {
  for (const standInHttpClient of standInHttpClientsCreatedSoFar()) {
    expect(standInHttpClient.get).not.toHaveBeenCalled();
    expect(standInHttpClient.post).not.toHaveBeenCalled();
  }
}

// Each of these would move the data API host off api.sanity.io, taking the token with it (DEV-12723).
const PROJECT_IDS_THAT_ARE_NOT_A_PLAIN_LABEL = [
  'evil.example#',
  'evil.example/../abc123',
  'abc123.evil.example',
  'abc123@evil.example',
  '',
];

describe('Sanity project IDs (DEV-12723)', () => {
  beforeEach(() => {
    createApiClientMock.mockClear();
  });

  it.each(PROJECT_IDS_THAT_ARE_NOT_A_PLAIN_LABEL)(
    'refuses %p for a query before sending anything',
    async (projectId) => {
      const sanityApiClient = new SanityApiClient('api-token');

      await expect(sanityApiClient.query(projectId, 'production', '*[0]')).rejects.toThrow(
        new SanityError(SANITY_PROJECT_ID_NOT_A_PLAIN_LABEL_MESSAGE),
      );
      expectNoRequestSent();
    },
  );

  it.each(PROJECT_IDS_THAT_ARE_NOT_A_PLAIN_LABEL)(
    'refuses %p for a dataset listing before sending anything',
    async (projectId) => {
      const sanityApiClient = new SanityApiClient('api-token');

      await expect(sanityApiClient.listDatasets(projectId)).rejects.toThrow(SanityError);
      expectNoRequestSent();
    },
  );

  it("refuses a folder's table id that carries a host, before sending anything", async () => {
    const sanityConnector = new SanityConnector('api-token');

    await expect(
      sanityConnector.fetchJsonTableSpec({ wsId: 'post', remoteId: ['evil.example#', 'production', 'post'] }),
    ).rejects.toThrow(SANITY_PROJECT_ID_NOT_A_PLAIN_LABEL_MESSAGE);
    expectNoRequestSent();
  });

  it('sends a valid project ID to its own data API host', async () => {
    const sanityApiClient = new SanityApiClient('api-token');

    await sanityApiClient.query('abc123de', 'production', '*[0]');

    expect(createApiClientMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseURL: expect.stringMatching(/^https:\/\/abc123de\.api\.sanity\.io\//) as unknown }),
    );
  });
});
