import { Controller, Get } from '@nestjs/common';
import { ConnectorMetadata, Service } from '@spinner/shared-types';
import { ScratchConfigService } from '../../config/scratch-config.service';
import { getAllConnectorMetadata } from './display-names';

@Controller('connectors')
export class ConnectorsMetadataController {
  constructor(private readonly config: ScratchConfigService) {}

  @Get('metadata')
  getMetadata(): Record<string, ConnectorMetadata> {
    const metadata = getAllConnectorMetadata();

    // Enable Webflow OAuth on non-production environments for testing
    if (!this.config.isProductionEnvironment() && metadata[Service.WEBFLOW]) {
      metadata[Service.WEBFLOW] = { ...metadata[Service.WEBFLOW], oauth: { label: 'OAuth' } };
    }

    return metadata;
  }
}
