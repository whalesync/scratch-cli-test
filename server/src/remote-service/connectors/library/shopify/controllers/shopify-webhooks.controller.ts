import {
  BadRequestException,
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

@Controller('connectors/shopify/webhooks')
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

  @Post()
  @HttpCode(200)
  async handleWebhook(@Req() req: Request): Promise<{ result: string }> {
    this.verifyRequest(req);

    const topic = req.headers['x-shopify-topic'] as string;
    const body = JSON.parse((req.body as Buffer).toString()) as { shop_domain?: string };
    const shopDomain = body.shop_domain;

    WSLogger.info({
      source: ShopifyWebhooksController.name,
      message: `Received ${topic} webhook for shop: ${shopDomain}`,
    });

    switch (topic) {
      case 'customers/data_request':
      case 'customers/redact':
        break;
      case 'shop/redact':
        if (shopDomain) {
          await this.shopifyWebhooksService.handleShopRedact(shopDomain);
        }
        break;
      default:
        throw new BadRequestException(`Unknown webhook topic: ${topic}`);
    }

    return { result: 'ok' };
  }
}
