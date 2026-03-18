import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Service, WorkbookId } from '@spinner/shared-types';
import * as crypto from 'crypto';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';

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
   * Handle shop/redact webhook: fully delete all Shopify connections for the given shop domain,
   * including schedules, publish plans, DataFolders, and git data.
   */
  async handleShopRedact(shopDomain: string): Promise<void> {
    const accounts = await this.dbService.client.connectorAccount.findMany({
      where: {
        service: Service.SHOPIFY,
        extras: { path: ['shopDomain'], equals: shopDomain },
      },
    });

    if (accounts.length === 0) {
      WSLogger.info({
        source: ShopifyWebhooksService.name,
        message: `No ConnectorAccount records found for shop domain: ${shopDomain}`,
      });
      return;
    }

    for (const account of accounts) {
      await this.connectorAccountService.removeBySystem(account.workbookId as WorkbookId, account.id);
    }

    WSLogger.info({
      source: ShopifyWebhooksService.name,
      message: `Deleted ${accounts.length} ConnectorAccount(s) and associated data for shop domain: ${shopDomain}`,
    });
  }
}
