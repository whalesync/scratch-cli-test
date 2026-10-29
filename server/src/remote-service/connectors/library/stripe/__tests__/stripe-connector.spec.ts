import { TSchema } from '@sinclair/typebox';
import { AxiosError } from 'axios';
import {
  connectorRegistry,
  type ConnectorFactoryContext,
  type ConnectorRegistration,
} from '../../../connector-registry';
import { ConnectorInstantiationError } from '../../../error';
import { Service } from '../../../service-constants';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';
import { StripeApiClient } from '../stripe-api-client';
import { StripeConnector } from '../stripe-connector';
import { StripeEntityType } from '../stripe-types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Stripe'),
}));

// Mock the API client
const mockValidateCredentials = jest.fn();
const mockListEntities = jest.fn();
const mockGetEntity = jest.fn();

jest.mock('../stripe-api-client', () => {
  return {
    StripeApiClient: jest.fn().mockImplementation(() => ({
      validateCredentials: mockValidateCredentials,
      listEntities: mockListEntities,
      getEntity: mockGetEntity,
    })),
    StripeError: class StripeError extends Error {
      statusCode?: number;
      code?: string;
      type?: string;
      responseData?: unknown;
      constructor(message: string, statusCode?: number, code?: string, type?: string, responseData?: unknown) {
        super(message);
        this.name = 'StripeError';
        this.statusCode = statusCode;
        this.code = code;
        this.type = type;
        this.responseData = responseData;
      }
    },
  };
});

function buildTableSpec(tableType: string): BaseJsonTableSpec {
  return {
    id: { wsId: tableType, remoteId: [tableType] },
    slug: tableType,
    name: tableType,
    schema: {} as unknown as TSchema,
    idPath: dotPath('id'),
  };
}

/** Helper to create an async generator from an array of pages. */
// eslint-disable-next-line @typescript-eslint/require-await
async function* asyncGen<T>(pages: T[][]): AsyncGenerator<T[], void> {
  for (const page of pages) {
    yield page;
  }
}

function getStripeRegistration(): ConnectorRegistration {
  const stripeRegistration = connectorRegistry.get(Service.STRIPE);
  if (!stripeRegistration) throw new Error('Stripe connector did not register itself');
  return stripeRegistration;
}

function buildConnectorFactoryContext(overrides: Partial<ConnectorFactoryContext>): ConnectorFactoryContext {
  return {
    connectorAccount: { id: 'coa_stripe_unit', authType: 'user_provided_params', extras: null, version: 1 },
    decryptedCredentials: { apiKey: 'sk_test_pasted' },
    createOAuthAccessTokenProvider: jest.fn(),
    createRateLimiter: jest.fn(),
    getFolderOptionsByTableId: jest.fn(),
    listFolderTableIds: jest.fn(),
    isFeatureEnabled: jest.fn(),
    ...overrides,
  };
}

describe('Stripe connector registration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('offers the sign-in first and the pasted secret key as the alternative', () => {
    expect(getStripeRegistration().supportedAuthMethods).toEqual(['oauth', 'user_provided_params']);
    expect(StripeConnector.metadata.oauth).toEqual({ label: 'Connect with Stripe' });
  });

  it("sends an OAuth connection's current access token, re-resolved per request, after checking it resolves", async () => {
    const oauthAccessTokenProvider = jest.fn().mockResolvedValue('stripe-oauth-access');
    const createOAuthAccessTokenProvider = jest.fn().mockReturnValue(oauthAccessTokenProvider);

    const connector = await getStripeRegistration().createConnector(
      buildConnectorFactoryContext({
        connectorAccount: { id: 'coa_stripe_oauth', authType: 'OAUTH', extras: null, version: 1 },
        decryptedCredentials: { oauthAccessToken: 'stripe-oauth-access' },
        createOAuthAccessTokenProvider,
      }),
    );

    expect(connector).toBeInstanceOf(StripeConnector);
    expect(createOAuthAccessTokenProvider).toHaveBeenCalledWith('coa_stripe_oauth');
    expect(oauthAccessTokenProvider).toHaveBeenCalledTimes(1);
    expect(jest.mocked(StripeApiClient).mock.calls[0][0]).toEqual({
      secretKeyOrOAuthAccessToken: oauthAccessTokenProvider,
    });
  });

  it('sends the pasted secret key for a key connection', async () => {
    await getStripeRegistration().createConnector(buildConnectorFactoryContext({}));

    expect(jest.mocked(StripeApiClient).mock.calls[0][0]).toEqual({ secretKeyOrOAuthAccessToken: 'sk_test_pasted' });
  });

  it('refuses a key connection with no stored key', async () => {
    const creation = getStripeRegistration().createConnector(
      buildConnectorFactoryContext({ decryptedCredentials: {} }),
    );

    await expect(creation).rejects.toBeInstanceOf(ConnectorInstantiationError);
  });
});

describe('StripeConnector', () => {
  let connector: StripeConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new StripeConnector({ secretKeyOrOAuthAccessToken: 'sk_test_123' });
  });

  // ---------------------------------------------------------------------------
  // Basic properties
  // ---------------------------------------------------------------------------

  describe('service', () => {
    it('returns STRIPE service', () => {
      expect(connector.service).toBe(Service.STRIPE);
    });
  });

  describe('getBatchSize', () => {
    it('returns 100', () => {
      expect(connector.getBatchSize()).toBe(100);
      expect(connector.getBatchSize()).toBe(100);
      expect(connector.getBatchSize()).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------

  describe('testConnection', () => {
    it('delegates to API client validateCredentials', async () => {
      mockValidateCredentials.mockResolvedValue(undefined);
      await connector.testConnection();
      expect(mockValidateCredentials).toHaveBeenCalledTimes(1);
    });

    it('throws when credentials are invalid', async () => {
      mockValidateCredentials.mockRejectedValue(new Error('Invalid API key'));
      await expect(connector.testConnection()).rejects.toThrow('Invalid API key');
    });
  });

  // ---------------------------------------------------------------------------
  // listTables
  // ---------------------------------------------------------------------------

  describe('listTables', () => {
    it('returns all 7 entity types', async () => {
      const tables = await connector.listTables();
      expect(tables).toHaveLength(7);

      const ids = tables.map((t) => t.id.wsId);
      expect(ids).toContain('customers');
      expect(ids).toContain('products');
      expect(ids).toContain('prices');
      expect(ids).toContain('subscriptions');
      expect(ids).toContain('invoices');
      expect(ids).toContain('payment_intents');
      expect(ids).toContain('charges');
    });

    it('includes display names', async () => {
      const tables = await connector.listTables();
      const customers = tables.find((t) => t.id.wsId === 'customers');
      const paymentIntents = tables.find((t) => t.id.wsId === 'payment_intents');
      expect(customers?.displayName).toBe('Customers');
      expect(paymentIntents?.displayName).toBe('Payment Intents');
    });

    it('marks all tables as creates-disabled (read-only)', async () => {
      const tables = await connector.listTables();
      for (const table of tables) {
        expect(table.disabledCreates).toBe(true);
        expect(table.disabledReason).toBe('Stripe connector is read-only');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // fetchJsonTableSpec
  // ---------------------------------------------------------------------------

  describe('fetchJsonTableSpec', () => {
    const entityTypes: StripeEntityType[] = [
      'customers',
      'products',
      'prices',
      'subscriptions',
      'invoices',
      'payment_intents',
      'charges',
    ];

    it.each(entityTypes)('builds schema for %s', async (entityType) => {
      const spec = await connector.fetchJsonTableSpec({ wsId: entityType, remoteId: [entityType] });

      expect(spec.idPath).toBe('id');
      expect(spec.slug).toBe(entityType);
      expect(spec.schema).toBeDefined();
    });

    it('throws for unknown table', async () => {
      await expect(connector.fetchJsonTableSpec({ wsId: 'unknown', remoteId: ['unknown'] })).rejects.toThrow(
        "Entity type 'unknown' not found",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // pullRecordFiles
  // ---------------------------------------------------------------------------

  describe('pullRecordFiles', () => {
    it('pulls all records via pagination', async () => {
      const page1 = [
        { id: 'cus_1', object: 'customer', name: 'Alice' },
        { id: 'cus_2', object: 'customer', name: 'Bob' },
      ];
      const page2 = [{ id: 'cus_3', object: 'customer', name: 'Charlie' }];
      mockListEntities.mockReturnValue(asyncGen([page1, page2]));

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFiles(buildTableSpec('customers'), callback, {}, { forceFull: false });

      expect(callback).toHaveBeenCalledTimes(2);
      expect(collected[0]).toHaveLength(2);
      expect(collected[1]).toHaveLength(1);
    });

    it('handles empty results', async () => {
      mockListEntities.mockReturnValue(asyncGen([]));

      const callback = jest.fn();
      await connector.pullRecordFiles(buildTableSpec('customers'), callback, {}, { forceFull: false });

      expect(callback).not.toHaveBeenCalled();
    });

    it('passes correct entity type to API client', async () => {
      mockListEntities.mockReturnValue(asyncGen([]));

      const callback = jest.fn();
      await connector.pullRecordFiles(buildTableSpec('payment_intents'), callback, {}, { forceFull: false });

      expect(mockListEntities).toHaveBeenCalledWith('payment_intents', 100, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // pullRecordFilesByIds
  // ---------------------------------------------------------------------------

  describe('pullRecordFilesByIds', () => {
    it('fetches entities by ID and buffers results', async () => {
      const cus1 = { id: 'cus_1', object: 'customer', name: 'Alice' };
      const cus2 = { id: 'cus_2', object: 'customer', name: 'Bob' };
      mockGetEntity.mockResolvedValueOnce(cus1).mockResolvedValueOnce(cus2);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('customers'), ['cus_1', 'cus_2'], callback);

      expect(mockGetEntity).toHaveBeenCalledTimes(2);
      expect(mockGetEntity).toHaveBeenCalledWith('customers', 'cus_1');
      expect(mockGetEntity).toHaveBeenCalledWith('customers', 'cus_2');
      expect(callback).toHaveBeenCalledTimes(1);
      expect(collected[0]).toHaveLength(2);
    });

    it('skips records that return null (404)', async () => {
      mockGetEntity
        .mockResolvedValueOnce({ id: 'cus_1', object: 'customer' })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'cus_3', object: 'customer' });

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('customers'), ['cus_1', 'cus_gone', 'cus_3'], callback);

      expect(collected[0]).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Read-only operations (create, update, delete)
  // ---------------------------------------------------------------------------

  describe('read-only enforcement', () => {
    it('throws on createRecords', () => {
      expect(() => connector.createRecords(buildTableSpec('customers'), [{ name: 'Test' }])).toThrow(
        'Stripe connector is read-only',
      );
    });

    it('throws on updateRecords', () => {
      expect(() => connector.updateRecords(buildTableSpec('customers'), [{ id: 'cus_1', name: 'Updated' }])).toThrow(
        'Stripe connector is read-only',
      );
    });

    it('throws on deleteRecords', () => {
      expect(() => connector.deleteRecords(buildTableSpec('customers'), [{ id: 'cus_1' }])).toThrow(
        'Stripe connector is read-only',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // extractConnectorErrorDetails
  // ---------------------------------------------------------------------------

  describe('extractConnectorErrorDetails', () => {
    it('handles StripeError', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const { StripeError } = require('../stripe-api-client');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const error = new StripeError('Rate limit exceeded', 429, 'rate_limit', 'invalid_request_error');

      const details = connector.extractConnectorErrorDetails(error);

      expect(details.userFriendlyMessage).toBe('Rate limit exceeded');
      expect(details.additionalContext?.status).toBe(429);
      expect(details.additionalContext?.code).toBe('rate_limit');
      expect(details.additionalContext?.type).toBe('invalid_request_error');
    });

    it('handles Axios 401 errors', () => {
      const error = new AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        statusText: 'Unauthorized',
        data: { error: { message: 'Invalid API Key' } },
        headers: {},
        config: {} as never,
      });

      const details = connector.extractConnectorErrorDetails(error);

      expect(details.userFriendlyMessage).toBeDefined();
      // Should be handled by extractCommonDetailsFromAxiosError for 401
      expect(details.userFriendlyMessage).toContain('credentials');
    });

    it('handles Axios 500 errors', () => {
      const error = new AxiosError('Server error', '500', undefined, undefined, {
        status: 500,
        statusText: 'Internal Server Error',
        data: { error: { message: 'Internal error' } },
        headers: {},
        config: {} as never,
      });

      const details = connector.extractConnectorErrorDetails(error);

      expect(details.userFriendlyMessage).toBeDefined();
      expect(details.additionalContext?.status).toBe(500);
    });

    it('handles unknown errors with fallback', () => {
      const error = new Error('Something unexpected');
      const details = connector.extractConnectorErrorDetails(error);
      expect(details.userFriendlyMessage).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getSuggestedRecordFileNames
  // ---------------------------------------------------------------------------

  describe('getSuggestedRecordFileNames', () => {
    it('uses name for customers via slugPath', () => {
      const records: ConnectorFile[] = [
        { id: 'cus_1', name: 'Alice Corp' },
        { id: 'cus_2', name: 'Bob LLC' },
      ];
      const tableSpec = buildTableSpec('customers');
      tableSpec.slugPath = dotPath('name');

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['Alice Corp', 'Bob LLC']);
    });

    it('uses name for products via slugPath', () => {
      const records: ConnectorFile[] = [
        { id: 'prod_1', name: 'Pro Plan' },
        { id: 'prod_2', name: 'Enterprise Plan' },
      ];
      const tableSpec = buildTableSpec('products');
      tableSpec.slugPath = dotPath('name');

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['Pro Plan', 'Enterprise Plan']);
    });

    it('falls back to id when slug field is null', () => {
      const records: ConnectorFile[] = [
        { id: 'cus_1', name: null },
        { id: 'cus_2', name: 'Bob LLC' },
      ];
      const tableSpec = buildTableSpec('customers');
      tableSpec.slugPath = dotPath('name');

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['cus_1', 'Bob LLC']);
    });

    it('uses id for charges via slugPath', () => {
      const records: ConnectorFile[] = [{ id: 'ch_1', amount: 1000 }];
      const tableSpec = buildTableSpec('charges');
      tableSpec.slugPath = dotPath('id');

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['ch_1']);
    });
  });
});
