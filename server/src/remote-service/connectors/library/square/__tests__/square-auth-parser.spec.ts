import { ConnectorAuthError } from '../../../error';
import { SquareAuthParser } from '../square-auth-parser';

const mockDetectEnvironment = jest.fn<Promise<string | null>, [string]>();

jest.mock('../square-api-client', () => ({
  SquareApiClient: {
    detectEnvironmentForAccessToken: (accessToken: string) => mockDetectEnvironment(accessToken),
  },
}));

describe('SquareAuthParser', () => {
  const parser = new SquareAuthParser();

  beforeEach(() => jest.clearAllMocks());

  it('stores the token with the environment that accepted it', async () => {
    mockDetectEnvironment.mockResolvedValue('sandbox');

    const parsed = await parser.parseUserProvidedParams({ userProvidedParams: { apiKey: '  EAAA-token  ' } });

    expect(parsed).toEqual({ credentials: { apiKey: 'EAAA-token', squareEnvironment: 'sandbox' }, extras: {} });
    expect(mockDetectEnvironment).toHaveBeenCalledWith('EAAA-token');
  });

  it('rejects a token neither environment accepts, at connect time', async () => {
    mockDetectEnvironment.mockResolvedValue(null);

    await expect(parser.parseUserProvidedParams({ userProvidedParams: { apiKey: 'bad' } })).rejects.toThrow(
      ConnectorAuthError,
    );
  });

  it('requires a token on create', async () => {
    await expect(parser.parseUserProvidedParams({ userProvidedParams: {} })).rejects.toThrow(ConnectorAuthError);
    expect(mockDetectEnvironment).not.toHaveBeenCalled();
  });

  it('keeps the stored token and environment when an edit pastes no new token', async () => {
    const parsed = await parser.parseUserProvidedParams({
      userProvidedParams: {},
      existingCredentials: { apiKey: 'stored-token', squareEnvironment: 'production' },
    });

    expect(parsed.credentials).toEqual({ apiKey: 'stored-token', squareEnvironment: 'production' });
    expect(mockDetectEnvironment).not.toHaveBeenCalled();
  });

  it('re-detects the environment when an edit pastes a new token', async () => {
    mockDetectEnvironment.mockResolvedValue('production');

    const parsed = await parser.parseUserProvidedParams({
      userProvidedParams: { apiKey: 'new-production-token' },
      existingCredentials: { apiKey: 'old-sandbox-token', squareEnvironment: 'sandbox' },
    });

    expect(parsed.credentials).toEqual({ apiKey: 'new-production-token', squareEnvironment: 'production' });
  });
});
