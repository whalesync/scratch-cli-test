import { ConfigService } from '@nestjs/config';
import { AuthType } from '@prisma/client';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { Service } from 'src/remote-service/connectors/service-constants';
import { ShopifyWebhooksService } from '../shopify-webhooks.service';

const SHOP_DOMAIN = 'royal-whale.myshopify.com';

function makeShopifyWebhooksService(connectorAccountsReturnedForShopDomain: unknown[]) {
  const findManyConnectorAccounts = jest.fn().mockResolvedValue(connectorAccountsReturnedForShopDomain);
  const removeConnectorAccountBySystem = jest.fn().mockResolvedValue(undefined);
  const service = new ShopifyWebhooksService(
    { get: () => 'test-client-secret' } as unknown as ConfigService,
    { client: { connectorAccount: { findMany: findManyConnectorAccounts } } } as unknown as DbService,
    { removeBySystem: removeConnectorAccountBySystem } as unknown as ConnectorAccountService,
  );
  return { service, findManyConnectorAccounts, removeConnectorAccountBySystem };
}

describe('ShopifyWebhooksService.handleShopRedact', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('looks up Shopify connector accounts by exact shopDomain match', async () => {
    const { service, findManyConnectorAccounts } = makeShopifyWebhooksService([]);

    await service.handleShopRedact(SHOP_DOMAIN);

    expect(findManyConnectorAccounts).toHaveBeenCalledWith({
      where: { service: Service.SHOPIFY, extras: { path: ['shopDomain'], equals: SHOP_DOMAIN } },
      select: { id: true, workbookId: true, authType: true },
    });
  });

  it('keeps custom-app (USER_PROVIDED_PARAMS) connections and logs their ids', async () => {
    const { service, removeConnectorAccountBySystem } = makeShopifyWebhooksService([
      { id: 'coa_custom_1', workbookId: 'wkb_1', authType: AuthType.USER_PROVIDED_PARAMS },
      { id: 'coa_custom_2', workbookId: 'wkb_2', authType: AuthType.USER_PROVIDED_PARAMS },
    ]);

    await service.handleShopRedact(SHOP_DOMAIN);

    expect(removeConnectorAccountBySystem).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ shopDomain: SHOP_DOMAIN, keptConnectorAccountIds: ['coa_custom_1', 'coa_custom_2'] }),
    );
  });

  it('deletes only the OAuth connection when the shop has mixed auth types', async () => {
    const { service, removeConnectorAccountBySystem } = makeShopifyWebhooksService([
      { id: 'coa_oauth', workbookId: 'wkb_oauth', authType: AuthType.OAUTH },
      { id: 'coa_custom', workbookId: 'wkb_custom', authType: AuthType.USER_PROVIDED_PARAMS },
      { id: 'coa_api_key', workbookId: 'wkb_api_key', authType: AuthType.API_KEY },
    ]);

    await service.handleShopRedact(SHOP_DOMAIN);

    expect(removeConnectorAccountBySystem).toHaveBeenCalledTimes(1);
    expect(removeConnectorAccountBySystem).toHaveBeenCalledWith('wkb_oauth', 'coa_oauth');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ keptConnectorAccountIds: ['coa_custom', 'coa_api_key'] }),
    );
  });

  it('deletes nothing when no connector account matches the shop domain', async () => {
    const { service, removeConnectorAccountBySystem } = makeShopifyWebhooksService([]);

    await service.handleShopRedact(SHOP_DOMAIN);

    expect(removeConnectorAccountBySystem).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
