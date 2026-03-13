import { Injectable } from '@nestjs/common';
import { AuthType, ConnectorAccount } from '@prisma/client';
import { isQuickBooksConnectorExtras, isShopifyConnectorExtras, Service } from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { OAuthService } from '../../oauth/oauth.service';
import { RateLimiter } from '../../rate-limiter/rate-limiter';
import { RateLimiterFactory } from '../../rate-limiter/rate-limiter-factory.service';
import { DecryptedCredentials } from '../connector-account/types/encrypted-credentials.interface';
import { AuthParser, Connector } from './connector';
import { ConnectorInstantiationError } from './error';
import { AirtableConnector } from './library/airtable/airtable-connector';
import { AudiencefulConnector } from './library/audienceful/audienceful-connector';
import { MocoConnector } from './library/moco/moco-connector';
import { NotionConnector } from './library/notion/notion-connector';
import { PipedriveConnector } from './library/pipedrive/pipedrive-connector';
import { PostgresConnector } from './library/postgres/postgres-connector';
import { QuickBooksConnector } from './library/quickbooks/quickbooks-connector';
import { ShopifyConnector } from './library/shopify/shopify-connector';
import { SupabaseAuthParser } from './library/supabase/supabase-auth-parser';
import { SupabaseConnector } from './library/supabase/supabase-connector';
import { WebflowConnector } from './library/webflow/webflow-connector';
import { WixBlogConnector } from './library/wix/wix-blog/wix-blog-connector';
import { WordPressAuthParser } from './library/wordpress/wordpress-auth-parser';
import { WordPressConnector } from './library/wordpress/wordpress-connector';
import { YouTubeConnector } from './library/youtube/youtube-connector';

@Injectable()
export class ConnectorsService {
  constructor(
    private readonly oauthService: OAuthService,
    private readonly rateLimiterFactory: RateLimiterFactory,
  ) {}

  private createRateLimiter(service: Service, connectorAccount: ConnectorAccount | null): RateLimiter | undefined {
    if (!connectorAccount) return undefined;
    return this.rateLimiterFactory.createLimiter({ service, connectorAccountId: connectorAccount.id });
  }

  getAuthParser(params: { service: Service }): AuthParser<Service> | undefined {
    const { service } = params;

    switch (service) {
      case Service.WORDPRESS:
        return new WordPressAuthParser();
      case Service.SUPABASE:
        return new SupabaseAuthParser();
      default:
        return undefined;
    }
  }

  async getConnector(params: {
    service: Service;
    connectorAccount: ConnectorAccount | null;
    decryptedCredentials: DecryptedCredentials | null;
    userId?: string;
  }): Promise<Connector<Service, JsonSafeObject>> {
    const { service, connectorAccount, decryptedCredentials } = params;

    switch (service) {
      case Service.AIRTABLE: {
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for Airtable', service);
        }
        const airtableRateLimiter = this.createRateLimiter(service, connectorAccount);
        if (connectorAccount.authType === AuthType.OAUTH) {
          const accessToken = await this.oauthService.getValidAccessToken(connectorAccount.id);
          return new AirtableConnector(accessToken, { rateLimiter: airtableRateLimiter });
        } else {
          if (!decryptedCredentials?.apiKey) {
            throw new ConnectorInstantiationError('API key is required for Airtable', service);
          }
          return new AirtableConnector(decryptedCredentials.apiKey, { rateLimiter: airtableRateLimiter });
        }
      }
      case Service.WORDPRESS:
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for WordPress', service);
        }
        if (!decryptedCredentials?.username) {
          throw new ConnectorInstantiationError('Username is required for WordPress', service);
        }
        if (!decryptedCredentials?.password) {
          throw new ConnectorInstantiationError('Password is required for WordPress', service);
        }
        if (!decryptedCredentials?.endpoint) {
          throw new ConnectorInstantiationError('Endpoint is required for WordPress', service);
        }
        return new WordPressConnector(
          decryptedCredentials.username,
          decryptedCredentials.password,
          decryptedCredentials.endpoint,
        );
      case Service.NOTION:
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for Notion', service);
        }
        if (connectorAccount?.authType === AuthType.OAUTH) {
          // For OAuth accounts, get the valid access token
          const accessToken = await this.oauthService.getValidAccessToken(connectorAccount.id);
          return new NotionConnector(accessToken);
        } else {
          // For API key accounts, use the apiKey field
          if (!decryptedCredentials?.apiKey) {
            throw new ConnectorInstantiationError('API key is required for Notion', service);
          }
          return new NotionConnector(decryptedCredentials.apiKey);
        }
      case Service.YOUTUBE:
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for YouTube', service);
        }
        if (connectorAccount.authType === AuthType.OAUTH) {
          // For OAuth accounts, get the valid access token and OAuth credentials
          const accessToken = await this.oauthService.getValidAccessToken(connectorAccount.id);
          return new YouTubeConnector(accessToken, connectorAccount);
        } else {
          // YouTube doesn't support API key authentication, only OAuth
          throw new Error('YouTube only supports OAuth authentication');
        }
      case Service.WEBFLOW: {
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for Webflow', service);
        }
        const webflowRateLimiter = this.createRateLimiter(service, connectorAccount);
        if (connectorAccount.authType === AuthType.OAUTH) {
          // For OAuth accounts, get the valid access token
          const accessToken = await this.oauthService.getValidAccessToken(connectorAccount.id);
          return new WebflowConnector(accessToken, { rateLimiter: webflowRateLimiter });
        } else {
          // For API key accounts, use the apiKey field
          if (!decryptedCredentials?.apiKey) {
            throw new ConnectorInstantiationError('API key is required for Webflow', service);
          }
          return new WebflowConnector(decryptedCredentials.apiKey, { rateLimiter: webflowRateLimiter });
        }
      }
      case Service.WIX_BLOG:
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for Wix', service);
        }
        if (connectorAccount.authType === AuthType.OAUTH) {
          // For OAuth accounts, get the valid access token
          // Site ID is automatically discovered via App Instance API
          const accessToken = await this.oauthService.getValidAccessToken(connectorAccount.id);
          return new WixBlogConnector(accessToken);
        } else {
          throw new Error('Wix requires either OAuth or API key authentication');
        }
      case Service.AUDIENCEFUL:
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for Audienceful', service);
        }
        if (!decryptedCredentials?.apiKey) {
          throw new ConnectorInstantiationError('API key is required for Audienceful', service);
        }
        return new AudiencefulConnector(decryptedCredentials.apiKey);
      case Service.MOCO:
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for Moco', service);
        }
        if (!decryptedCredentials?.domain) {
          throw new ConnectorInstantiationError('Domain is required for Moco', service);
        }
        if (!decryptedCredentials?.apiKey) {
          throw new ConnectorInstantiationError('API key is required for Moco', service);
        }
        return new MocoConnector({ domain: decryptedCredentials.domain, apiKey: decryptedCredentials.apiKey });
      case Service.POSTGRES:
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for PostgreSQL', service);
        }
        if (!decryptedCredentials?.connectionString) {
          throw new ConnectorInstantiationError('Connection string is required for PostgreSQL', service);
        }
        return new PostgresConnector({ connectionString: decryptedCredentials.connectionString });
      case Service.SHOPIFY: {
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for Shopify', service);
        }
        const shopifyRateLimiter = this.createRateLimiter(service, connectorAccount);
        if (!isShopifyConnectorExtras(connectorAccount.extras)) {
          throw new ConnectorInstantiationError('Shop domain is required for Shopify', service);
        }
        const { shopDomain } = connectorAccount.extras;
        if (connectorAccount.authType === AuthType.OAUTH) {
          const accessToken = await this.oauthService.getValidAccessToken(connectorAccount.id);
          return new ShopifyConnector({ shopDomain, accessToken }, { rateLimiter: shopifyRateLimiter });
        } else {
          if (!decryptedCredentials?.apiKey) {
            throw new ConnectorInstantiationError('Access token (API key) is required for Shopify', service);
          }
          return new ShopifyConnector(
            { shopDomain, accessToken: decryptedCredentials.apiKey },
            { rateLimiter: shopifyRateLimiter },
          );
        }
      }
      case Service.SUPABASE: {
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for Supabase', service);
        }
        if (connectorAccount.authType === AuthType.OAUTH) {
          const supabaseProjects = decryptedCredentials?.supabaseProjects;
          if (!supabaseProjects || supabaseProjects.length === 0) {
            throw new ConnectorInstantiationError(
              'Supabase projects not configured. Please reconnect your Supabase account.',
              service,
            );
          }
          const supabaseAccessToken = await this.oauthService.getValidAccessToken(connectorAccount.id);
          return new SupabaseConnector({
            projects: supabaseProjects.map((p) => ({
              projectRef: p.projectRef,
              projectName: p.projectName,
              connectionString: p.connectionString,
            })),
            oauthAccessToken: supabaseAccessToken,
          });
        } else {
          if (!decryptedCredentials?.connectionString) {
            throw new ConnectorInstantiationError('Connection string is required for Supabase.', service);
          }
          return new SupabaseConnector({
            connectionString: decryptedCredentials.connectionString,
          });
        }
      }
      case Service.QUICKBOOKS: {
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for QuickBooks', service);
        }
        const quickbooksRateLimiter = this.createRateLimiter(service, connectorAccount);
        if (!isQuickBooksConnectorExtras(connectorAccount.extras)) {
          throw new ConnectorInstantiationError('Realm ID is required for QuickBooks', service);
        }
        const { realmId, sandbox } = connectorAccount.extras;
        if (connectorAccount.authType === AuthType.OAUTH) {
          const accessToken = await this.oauthService.getValidAccessToken(connectorAccount.id);
          return new QuickBooksConnector(
            { accessToken, realmId },
            { rateLimiter: quickbooksRateLimiter, sandbox: sandbox ?? false },
          );
        } else {
          throw new ConnectorInstantiationError('QuickBooks only supports OAuth authentication', service);
        }
      }
      case Service.PIPEDRIVE: {
        if (!connectorAccount) {
          throw new ConnectorInstantiationError('Connector account is required for Pipedrive', service);
        }
        const pipedriveRateLimiter = this.createRateLimiter(service, connectorAccount);
        if (connectorAccount.authType === AuthType.OAUTH) {
          const accessToken = await this.oauthService.getValidAccessToken(connectorAccount.id);
          return new PipedriveConnector(accessToken, { rateLimiter: pipedriveRateLimiter, authType: 'oauth' });
        } else {
          if (!decryptedCredentials?.apiKey) {
            throw new ConnectorInstantiationError('API key is required for Pipedrive', service);
          }
          return new PipedriveConnector(decryptedCredentials.apiKey, { rateLimiter: pipedriveRateLimiter });
        }
      }
      default:
        throw new ConnectorInstantiationError(`Unsupported service: ${String(service)}`, service);
    }
  }
}
