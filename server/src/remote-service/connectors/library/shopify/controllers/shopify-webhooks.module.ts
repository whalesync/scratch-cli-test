import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { ConnectorAccountModule } from 'src/remote-service/connector-account/connector-account.module';
import { ShopifyWebhooksController } from './shopify-webhooks.controller';
import { ShopifyWebhooksService } from './shopify-webhooks.service';

@Module({
  imports: [ScratchConfigModule, DbModule, ConnectorAccountModule],
  controllers: [ShopifyWebhooksController],
  providers: [ShopifyWebhooksService],
})
export class ShopifyWebhooksModule {}
