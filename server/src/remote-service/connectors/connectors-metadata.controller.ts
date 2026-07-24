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

    // Some connectors point their setup guide at an internal Scratch web-client page
    // (e.g. Shopify's `/shopify-custom-app`) rather than an external URL. Those are
    // stored as root-relative paths so they stay environment-agnostic; resolve them
    // to an absolute URL against the web client base so the link works wherever the
    // metadata is rendered (e.g. the desktop app, which is not served from that origin).
    const webClientBaseUrl = this.config.getScratchApplicationUrl();
    for (const service of Object.keys(metadata)) {
      const setupGuide = metadata[service].setupGuide;
      if (setupGuide && setupGuide.url.startsWith('/')) {
        metadata[service] = {
          ...metadata[service],
          setupGuide: { ...setupGuide, url: `${webClientBaseUrl}${setupGuide.url}` },
        };
      }
    }

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

    // Pipedrive OAuth is not offered in ANY environment yet (the public marketplace app isn't
    // approved), so it is disabled at the source — the connector declares no `oauth` metadata and
    // omits 'oauth' from its supportedAuthMethods (see pipedrive-connector.ts). No per-environment
    // override is needed here. (DEV-11051)

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
