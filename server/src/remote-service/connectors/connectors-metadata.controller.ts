import { Controller, Get } from '@nestjs/common';
import { ConnectorMetadata } from '@spinner/shared-types';
import { getAllConnectorMetadata } from './display-names';

@Controller('connectors')
export class ConnectorsMetadataController {
  @Get('metadata')
  getMetadata(): Record<string, ConnectorMetadata> {
    return getAllConnectorMetadata();
  }
}
