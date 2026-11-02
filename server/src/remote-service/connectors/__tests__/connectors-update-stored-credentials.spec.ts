import type { ConnectorAccount } from '@prisma/client';
import { OAuthService } from '../../../oauth/oauth.service';
import { DecryptedCredentials } from '../../connector-account/types/encrypted-credentials.interface';
import { Connector } from '../connector';
import { ConnectorFactoryContext, connectorRegistry } from '../connector-registry';
import { ConnectorsService } from '../connectors.service';
import { Service } from '../service-constants';

const CONNECTOR_BUILT_FOR_CONNECTOR_ACCOUNT_ID = 'coa_connector_was_built_for';
const SOME_OTHER_CONNECTOR_ACCOUNT_ID = 'coa_belonging_to_someone_else';

function buildConnectorsService(): {
  connectorsService: ConnectorsService;
  updateStoredCredentialsUnderConnectionLock: jest.Mock;
} {
  const updateStoredCredentialsUnderConnectionLock = jest
    .fn<Promise<DecryptedCredentials>, [string, unknown]>()
    .mockResolvedValue({ apiKey: 'stored' });
  const oauthService = { updateStoredCredentialsUnderConnectionLock } as unknown as OAuthService;
  const connectorsService = new ConnectorsService(
    oauthService,
    // Building the factory context never touches the other collaborators.
    {} as never,
    {} as never,
    {} as never,
  );
  return { connectorsService, updateStoredCredentialsUnderConnectionLock };
}

/**
 * Build a connector through `ConnectorsService.getConnector` and hand back the
 * factory context it was given — the only way a connector ever receives
 * `updateStoredCredentials`.
 */
async function captureFactoryContext(
  connectorsService: ConnectorsService,
  connectorAccount: ConnectorAccount | null,
): Promise<ConnectorFactoryContext> {
  const supabaseRegistration = connectorRegistry.get(Service.SUPABASE);
  if (!supabaseRegistration) {
    throw new Error('Supabase connector is not registered');
  }
  let capturedFactoryContext: ConnectorFactoryContext | undefined;
  jest.spyOn(connectorRegistry, 'get').mockReturnValue({
    ...supabaseRegistration,
    createConnector: (factoryContext) => {
      capturedFactoryContext = factoryContext;
      return Promise.resolve({} as Connector);
    },
  });

  await connectorsService.getConnector({ service: Service.SUPABASE, connectorAccount, decryptedCredentials: null });
  if (!capturedFactoryContext?.updateStoredCredentials) {
    throw new Error('getConnector did not hand the connector an updateStoredCredentials callback');
  }
  return capturedFactoryContext;
}

function connectorAccountWithId(connectorAccountId: string): ConnectorAccount {
  return { id: connectorAccountId, authType: 'OAUTH', extras: null, version: 1 } as ConnectorAccount;
}

describe('ConnectorsService — updateStoredCredentials is pinned to the connector account (DEV-12337)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes the connection the connector was built for', async () => {
    const { connectorsService, updateStoredCredentialsUnderConnectionLock } = buildConnectorsService();
    const factoryContext = await captureFactoryContext(
      connectorsService,
      connectorAccountWithId(CONNECTOR_BUILT_FOR_CONNECTOR_ACCOUNT_ID),
    );
    const mutate = (currentCredentials: DecryptedCredentials) => ({ ...currentCredentials, apiKey: 'new' });

    await expect(
      factoryContext.updateStoredCredentials?.(CONNECTOR_BUILT_FOR_CONNECTOR_ACCOUNT_ID, mutate),
    ).resolves.toEqual({ apiKey: 'stored' });

    expect(updateStoredCredentialsUnderConnectionLock).toHaveBeenCalledTimes(1);
    expect(updateStoredCredentialsUnderConnectionLock).toHaveBeenCalledWith(
      CONNECTOR_BUILT_FOR_CONNECTOR_ACCOUNT_ID,
      mutate,
    );
  });

  it("rejects a write to another connection's credentials without touching storage", async () => {
    const { connectorsService, updateStoredCredentialsUnderConnectionLock } = buildConnectorsService();
    const factoryContext = await captureFactoryContext(
      connectorsService,
      connectorAccountWithId(CONNECTOR_BUILT_FOR_CONNECTOR_ACCOUNT_ID),
    );

    await expect(
      factoryContext.updateStoredCredentials?.(SOME_OTHER_CONNECTOR_ACCOUNT_ID, () => ({ apiKey: 'hijacked' })),
    ).rejects.toThrow(SOME_OTHER_CONNECTOR_ACCOUNT_ID);

    expect(updateStoredCredentialsUnderConnectionLock).not.toHaveBeenCalled();
  });

  it('rejects a write from a connector built without a connection', async () => {
    const { connectorsService, updateStoredCredentialsUnderConnectionLock } = buildConnectorsService();
    const factoryContext = await captureFactoryContext(connectorsService, null);

    await expect(
      factoryContext.updateStoredCredentials?.(SOME_OTHER_CONNECTOR_ACCOUNT_ID, () => ({ apiKey: 'hijacked' })),
    ).rejects.toThrow(SOME_OTHER_CONNECTOR_ACCOUNT_ID);

    expect(updateStoredCredentialsUnderConnectionLock).not.toHaveBeenCalled();
  });
});
