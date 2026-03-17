import { Controller, Get } from '@nestjs/common';
import { ConnectorMetadata, Service } from '@spinner/shared-types';
import { getAllConnectorMetadata } from './display-names';

@Controller('connectors')
export class ConnectorsMetadataController {
  @Get('metadata')
  getMetadata(): Record<Service, ConnectorMetadata> {
    return getAllConnectorMetadata();
  }
}
