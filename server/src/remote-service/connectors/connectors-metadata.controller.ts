import { BadRequestException, Controller, Get, Header, Query } from '@nestjs/common';
import { ConnectorMetadata } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { ScratchConfigService } from '../../config/scratch-config.service';
import { getAllConnectorMetadata } from './display-names';
import { getAiPrompt } from './library/generic-api/ai-prompts';

@Controller('connectors')
export class ConnectorsMetadataController {
  constructor(private readonly config: ScratchConfigService) {}

  @Get('metadata')
  getMetadata(): Record<string, ConnectorMetadata> {
    const metadata = getAllConnectorMetadata();

    // Enable Webflow OAuth on non-production environments for testing
    if (!this.config.isProductionEnvironment() && metadata[Service.WEBFLOW]) {
      const webflow = metadata[Service.WEBFLOW];
      metadata[Service.WEBFLOW] = {
        ...webflow,
        oauth: { label: 'OAuth' },
        supportedAuthMethods: ['oauth', ...webflow.supportedAuthMethods.filter((m) => m !== 'oauth')],
        defaultAuthMethod: 'oauth',
      };
    }

    return metadata;
  }

  /**
   * Return the AI-assist prompt the GENERIC_API connection modal copies to
   * the user's clipboard when they click "Get AI prompt". Server-side so we
   * can evolve the prompt as apiget grows new capabilities without a client
   * redeploy. Cached for 5 minutes — prompts change rarely.
   */
  @Get('generic-api/ai-prompt')
  @Header('Cache-Control', 'public, max-age=300')
  getGenericApiAiPrompt(@Query('apiType') apiType?: string): { version: string; text: string } {
    if (apiType !== 'rest' && apiType !== 'graphql') {
      throw new BadRequestException('apiType query parameter must be "rest" or "graphql"');
    }
    return getAiPrompt(apiType);
  }
}
