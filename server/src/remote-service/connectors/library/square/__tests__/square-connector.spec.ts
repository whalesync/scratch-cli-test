import { TSchema } from '@sinclair/typebox';
import {
  connectorRegistry,
  type ConnectorFactoryContext,
  type ConnectorRegistration,
} from '../../../connector-registry';
import { ConnectorInstantiationError } from '../../../error';
import { Service } from '../../../service-constants';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';
import { SquareApiClient } from '../square-api-client';
import { SquareConnector } from '../square-connector';
import { SQUARE_ENTITY_TYPES, SQUARE_OAUTH_READ_SCOPES, SquarePullProgress } from '../square-types';

jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Square'),
}));

const mockValidateCredentials = jest.fn();
const mockListEntityPages = jest.fn();
const mockRetrieveEntity = jest.fn();
const mockRetrieveGrantedScopes = jest.fn();

jest.mock('../square-api-client', () => {
  const actual = jest.requireActual<typeof import('../square-api-client')>('../square-api-client');
  return {
    ...actual,
    SquareApiClient: jest.fn().mockImplementation(() => ({
      environment: 'production',
      validateCredentials: mockValidateCredentials,
      listEntityPages: mockListEntityPages,
      retrieveEntity: mockRetrieveEntity,
      retrieveGrantedScopes: mockRetrieveGrantedScopes,
    })),
  };
});

function tableSpecFor(entityType: string): BaseJsonTableSpec {
  return {
    id: { wsId: entityType, remoteId: [entityType] },
    slug: entityType,
    name: entityType,
    schema: {} as unknown as TSchema,
    idPath: dotPath('id'),
    slugPath: dotPath('name'),
  };
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* pagesOf(pages: { records: Record<string, unknown>[]; progressAfterPage: SquarePullProgress }[]) {
  for (const page of pages) yield page;
}

function getSquareRegistration(): ConnectorRegistration {
  const squareRegistration = connectorRegistry.get(Service.SQUARE);
  if (!squareRegistration) throw new Error('Square connector did not register itself');
  return squareRegistration;
}

function buildConnectorFactoryContext(overrides: Partial<ConnectorFactoryContext>): ConnectorFactoryContext {
  return {
    connectorAccount: { id: 'coa_square_unit', authType: 'user_provided_params', extras: null, version: 1 },
    decryptedCredentials: { apiKey: 'EAAA-pasted', squareEnvironment: 'sandbox' },
    createOAuthAccessTokenProvider: jest.fn(),
    createRateLimiter: jest.fn(),
    getFolderOptionsByTableId: jest.fn(),
    listFolderTableIds: jest.fn(),
    isFeatureEnabled: jest.fn(),
    ...overrides,
  };
}

describe('Square connector registration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('offers the sign-in first and the pasted access token as the alternative', () => {
    expect(getSquareRegistration().supportedAuthMethods).toEqual(['oauth', 'user_provided_params']);
    expect(SquareConnector.metadata.defaultAuthMethod).toBe('oauth');
    expect(SquareConnector.metadata.oauth).toEqual({ label: 'Connect with Square' });
  });

  it.each(['sandbox', 'production'] as const)(
    "sends an OAuth connection's current access token, re-resolved per request, to its %s host",
    async (environmentRecordedAtSignIn) => {
      const oauthAccessTokenProvider = jest.fn().mockResolvedValue('square-oauth-access');
      const createOAuthAccessTokenProvider = jest.fn().mockReturnValue(oauthAccessTokenProvider);

      const connector = await getSquareRegistration().createConnector(
        buildConnectorFactoryContext({
          connectorAccount: { id: 'coa_square_oauth', authType: 'OAUTH', extras: null, version: 1 },
          decryptedCredentials: {
            oauthAccessToken: 'square-oauth-access',
            oauthWorkspaceId: environmentRecordedAtSignIn,
          },
          createOAuthAccessTokenProvider,
        }),
      );

      expect(connector).toBeInstanceOf(SquareConnector);
      expect(createOAuthAccessTokenProvider).toHaveBeenCalledWith('coa_square_oauth');
      expect(oauthAccessTokenProvider).toHaveBeenCalledTimes(1);
      expect(jest.mocked(SquareApiClient).mock.calls[0][0]).toEqual({
        accessToken: oauthAccessTokenProvider,
        environment: environmentRecordedAtSignIn,
      });
    },
  );

  it('sends the pasted access token to the environment detected when it was pasted', async () => {
    await getSquareRegistration().createConnector(buildConnectorFactoryContext({}));

    expect(jest.mocked(SquareApiClient).mock.calls[0][0]).toEqual({
      accessToken: 'EAAA-pasted',
      environment: 'sandbox',
    });
  });

  it('refuses a pasted-token connection with no stored token', async () => {
    const creation = getSquareRegistration().createConnector(
      buildConnectorFactoryContext({ decryptedCredentials: {} }),
    );

    await expect(creation).rejects.toBeInstanceOf(ConnectorInstantiationError);
  });
});

describe('SquareConnector', () => {
  let connector: SquareConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRetrieveGrantedScopes.mockResolvedValue(new Set(SQUARE_OAUTH_READ_SCOPES));
    connector = new SquareConnector({ accessToken: 't', environment: 'production' });
  });

  it('lists every table as read-only', async () => {
    const tables = await connector.listTables();

    expect(tables.map((table) => table.id.wsId)).toEqual(SQUARE_ENTITY_TYPES);
    for (const table of tables) {
      expect(table).toMatchObject({ disabledCreates: true, disabledUpdates: true, disabledDeletes: true });
      expect(table.disabled).toBeUndefined();
    }
  });

  it('lists a table the connection lacks the permission for as unpickable, saying how to fix it', async () => {
    // A connection signed in before the gift card tables existed.
    mockRetrieveGrantedScopes.mockResolvedValue(
      new Set(SQUARE_OAUTH_READ_SCOPES.filter((scope) => scope !== 'GIFTCARDS_READ')),
    );

    const tables = await connector.listTables();

    const unpickableTableIds = tables.filter((table) => table.disabled).map((table) => table.id.wsId);
    expect(unpickableTableIds).toEqual(['gift_cards', 'gift_card_activities']);
    expect(tables.find((table) => table.id.wsId === 'gift_cards')?.disabledReason).toBe(
      "This connection doesn't have Square's GIFTCARDS_READ permission. Reconnect Square to add Gift Cards.",
    );
  });

  it("leaves every table pickable when Square won't report the token's permissions", async () => {
    mockRetrieveGrantedScopes.mockRejectedValue(new Error('Square API error (500)'));

    const tables = await connector.listTables();

    expect(tables).toHaveLength(SQUARE_ENTITY_TYPES.length);
    expect(tables.some((table) => table.disabled)).toBe(false);
  });

  it('rejects an unknown table', async () => {
    await expect(
      connector.fetchJsonTableSpec({ wsId: 'inventory_counts', remoteId: ['inventory_counts'] }),
    ).rejects.toThrow("Square has no table 'inventory_counts'");
  });

  it('hands each page to the job exactly as Square returned it, with its resume progress', async () => {
    const squarePayment = {
      id: 'P1',
      amount_money: { amount: 1250, currency: 'AUD' },
      created_at: '2026-10-01T00:00:00Z',
    };
    mockListEntityPages.mockReturnValue(
      pagesOf([
        { records: [squarePayment], progressAfterPage: { locationIndex: 0, cursor: 'c-1' } },
        { records: [{ id: 'P2' }], progressAfterPage: { locationIndex: 1 } },
      ]),
    );
    const callback = jest.fn().mockResolvedValue(undefined);

    const result = await connector.pullRecordFiles(tableSpecFor('payments'), callback, { locationIndex: 0 }, {});

    expect(result).toEqual({});
    expect(mockListEntityPages).toHaveBeenCalledWith('payments', { locationIndex: 0 });
    expect(callback).toHaveBeenNthCalledWith(1, {
      files: [squarePayment],
      connectorProgress: { locationIndex: 0, cursor: 'c-1' },
    });
    expect(callback).toHaveBeenNthCalledWith(2, { files: [{ id: 'P2' }], connectorProgress: { locationIndex: 1 } });
  });

  it('pulls specific records by id, skipping ones Square no longer has', async () => {
    mockRetrieveEntity.mockImplementation((_entityType: string, recordId: string) =>
      Promise.resolve(recordId === 'gone' ? null : { id: recordId }),
    );
    const callback = jest.fn().mockResolvedValue(undefined);

    await connector.pullRecordFilesByIds(tableSpecFor('orders'), ['O1', 'gone', 'O2'], callback);

    expect(callback).toHaveBeenCalledWith({ files: [{ id: 'O1' }, { id: 'O2' }] });
  });

  it('refuses every write', () => {
    const spec = tableSpecFor('customers');
    const files = [{ id: 'C1' }] as ConnectorFile[];

    expect(() => connector.createRecords(spec, files)).toThrow('read-only');
    expect(() => connector.updateRecords(spec, files)).toThrow('read-only');
    expect(() => connector.deleteRecords(spec, files)).toThrow('read-only');
  });

  it('names record files by the slug, falling back to the id', () => {
    const names = connector.getSuggestedRecordFileNames(
      [{ id: 'L1', name: 'Sydney Opera House' }, { id: 'L2' }] as ConnectorFile[],
      tableSpecFor('locations'),
    );

    expect(names).toEqual(['Sydney Opera House', 'L2']);
  });
});
