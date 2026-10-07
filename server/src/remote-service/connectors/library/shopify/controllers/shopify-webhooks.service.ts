import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthType } from '@prisma/client';
import { WorkbookId } from '@spinner/shared-types';
import * as crypto from 'crypto';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { Service } from '../../../service-constants';

@Injectable()
export class ShopifyWebhooksService {
  private readonly shopifyClientSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly dbService: DbService,
    private readonly connectorAccountService: ConnectorAccountService,
  ) {
    this.shopifyClientSecret = this.configService.get<string>('SHOPIFY_CLIENT_SECRET') || '';
  }

  /**
   * Verify the HMAC signature from a Shopify webhook request.
   * Shopify signs webhooks with HMAC-SHA256 using the app's client secret.
   */
  verifyHmac(rawBody: Buffer, hmacHeader: string): boolean {
    if (!this.shopifyClientSecret) {
      WSLogger.error({
        source: ShopifyWebhooksService.name,
        message: 'SHOPIFY_CLIENT_SECRET is not configured',
      });
      return false;
    }

    const computedHmac = crypto.createHmac('sha256', this.shopifyClientSecret).update(rawBody).digest('base64');

    return crypto.timingSafeEqual(Buffer.from(computedHmac), Buffer.from(hmacHeader));
  }

  /**
   * Handle shop/redact webhook, which Shopify sends 48h after our public app is uninstalled from a shop.
   *
   * Only connections created through the public app's OAuth flow are deleted (schedules, publish plans,
   * DataFolders, and git data). Connections using a merchant's own custom-app token never received data
   * through our public app, so they are kept — deleting them would wipe live connections (e.g. Live
   * Export sources) because of an unrelated uninstall. Public-app OAuth was removed, so today this
   * deletes nothing and only logs the kept connections.
   */
  async handleShopRedact(shopDomain: string): Promise<void> {
    const connectorAccountsForShopDomain = await this.dbService.client.connectorAccount.findMany({
      where: {
        service: Service.SHOPIFY,
        extras: { path: ['shopDomain'], equals: shopDomain },
      },
      select: { id: true, workbookId: true, authType: true },
    });

    if (connectorAccountsForShopDomain.length === 0) {
      WSLogger.info({
        source: ShopifyWebhooksService.name,
        message: `No ConnectorAccount records found for shop domain: ${shopDomain}`,
      });
      return;
    }

    const connectorAccountsCreatedThroughPublicAppOAuth = connectorAccountsForShopDomain.filter(
      (account) => account.authType === AuthType.OAUTH,
    );
    const connectorAccountsKeptBecauseNotCreatedThroughPublicApp = connectorAccountsForShopDomain.filter(
      (account) => account.authType !== AuthType.OAUTH,
    );

    if (connectorAccountsKeptBecauseNotCreatedThroughPublicApp.length > 0) {
      WSLogger.warn({
        source: ShopifyWebhooksService.name,
        message: `Kept ${connectorAccountsKeptBecauseNotCreatedThroughPublicApp.length} non-OAuth ConnectorAccount(s) for shop/redact on shop domain: ${shopDomain}`,
        shopDomain,
        keptConnectorAccountIds: connectorAccountsKeptBecauseNotCreatedThroughPublicApp.map((account) => account.id),
      });
    }

    for (const account of connectorAccountsCreatedThroughPublicAppOAuth) {
      await this.connectorAccountService.removeBySystem(account.workbookId as WorkbookId, account.id);
    }

    WSLogger.info({
      source: ShopifyWebhooksService.name,
      message: `Deleted ${connectorAccountsCreatedThroughPublicAppOAuth.length} OAuth ConnectorAccount(s) and associated data for shop domain: ${shopDomain}`,
    });
  }
}
