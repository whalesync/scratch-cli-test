import {
  ClassSerializerInterceptor,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { WSLogger } from 'src/logger';
import { ShopifyWebhooksService } from './shopify-webhooks.service';

@Controller('shopify/webhooks')
@UseInterceptors(ClassSerializerInterceptor)
export class ShopifyWebhooksController {
  constructor(private readonly shopifyWebhooksService: ShopifyWebhooksService) {}

  private verifyRequest(req: Request): void {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string;
    if (!hmacHeader || !req.body) {
      throw new UnauthorizedException('Missing HMAC signature or body');
    }

    const isValid = this.shopifyWebhooksService.verifyHmac(req.body as Buffer, hmacHeader);
    if (!isValid) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }
  }

  /**
   * Shopify GDPR: customers/data_request
   * Shopify asks if we have any customer data. We don't store customer PII directly,
   * so we log the request and return 200.
   */
  @Post('customers-data-request')
  @HttpCode(200)
  handleCustomersDataRequest(@Req() req: Request): { result: string } {
    this.verifyRequest(req);

    const body = JSON.parse((req.body as Buffer).toString()) as Record<string, unknown>;
    WSLogger.info({
      source: ShopifyWebhooksController.name,
      message: `Received customers/data_request webhook for shop: ${body.shop_domain as string}`,
    });

    return { result: 'ok' };
  }

  /**
   * Shopify GDPR: customers/redact
   * Shopify asks us to delete customer data. We don't store customer PII directly,
   * so we log the request and return 200.
   */
  @Post('customers-redact')
  @HttpCode(200)
  handleCustomersRedact(@Req() req: Request): { result: string } {
    this.verifyRequest(req);

    const body = JSON.parse((req.body as Buffer).toString()) as Record<string, unknown>;
    WSLogger.info({
      source: ShopifyWebhooksController.name,
      message: `Received customers/redact webhook for shop: ${body.shop_domain as string}`,
    });

    return { result: 'ok' };
  }

  /**
   * Shopify GDPR: shop/redact
   * Shopify asks us to delete all shop data (48h after uninstall).
   * We delete all ConnectorAccount records for the given shop domain.
   */
  @Post('shop-redact')
  @HttpCode(200)
  async handleShopRedact(@Req() req: Request): Promise<{ result: string }> {
    this.verifyRequest(req);

    const body = JSON.parse((req.body as Buffer).toString()) as { shop_domain?: string };
    const shopDomain = body.shop_domain;

    WSLogger.info({
      source: ShopifyWebhooksController.name,
      message: `Received shop/redact webhook for shop: ${shopDomain}`,
    });

    if (shopDomain) {
      await this.shopifyWebhooksService.handleShopRedact(shopDomain);
    }

    return { result: 'ok' };
  }
}
