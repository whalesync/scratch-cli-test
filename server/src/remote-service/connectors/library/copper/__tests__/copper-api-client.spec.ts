import axios from 'axios';
import { createApiClient } from '../../../create-api-client';
import { CopperApiClient, CopperError } from '../copper-api-client';

const mockGet = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({ get: mockGet })),
}));

function axiosErrorWithStatus(status: number): Error {
  return new axios.AxiosError(`Request failed with status code ${status}`, String(status), undefined, undefined, {
    status,
    data: {},
    statusText: '',
    headers: {},
    config: {} as never,
  });
}

describe('CopperApiClient authentication', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends a pasted API key as the three X-PW headers and no bearer token', () => {
    new CopperApiClient({ kind: 'api_key', apiKey: 'copper-key', email: 'user@example.com' });

    const [config, options] = jest.mocked(createApiClient).mock.calls[0];
    expect(config?.headers).toMatchObject({
      'X-PW-AccessToken': 'copper-key',
      'X-PW-Application': 'developer_api',
      'X-PW-UserEmail': 'user@example.com',
    });
    expect(options?.authorizationHeaderValueProvider).toBeUndefined();
  });

  it("sends a signed-in connection's OAuth token as a bearer token, re-read on every request, and none of the X-PW headers", async () => {
    const oauthAccessTokenProvider = jest.fn().mockResolvedValueOnce('oauth-1').mockResolvedValueOnce('oauth-2');
    new CopperApiClient({ kind: 'oauth', accessToken: oauthAccessTokenProvider });

    const [config, options] = jest.mocked(createApiClient).mock.calls[0];
    expect(config?.headers).not.toHaveProperty('X-PW-AccessToken');
    expect(config?.headers).not.toHaveProperty('X-PW-Application');
    expect(config?.headers).not.toHaveProperty('X-PW-UserEmail');
    await expect(options?.authorizationHeaderValueProvider?.()).resolves.toBe('Bearer oauth-1');
    await expect(options?.authorizationHeaderValueProvider?.()).resolves.toBe('Bearer oauth-2');
  });

  it('tells a signed-in connection to reconnect when Copper rejects its token', async () => {
    mockGet.mockRejectedValue(axiosErrorWithStatus(401));
    const client = new CopperApiClient({ kind: 'oauth', accessToken: 'revoked-token' });

    const connectionTest = client.testConnection();

    await expect(connectionTest).rejects.toBeInstanceOf(CopperError);
    await expect(connectionTest).rejects.toThrow('Copper rejected the sign-in; reconnect Copper');
  });
});
