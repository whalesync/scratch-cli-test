import { Injectable } from '@nestjs/common';
import { ConnectorAccount } from '@prisma/client';
import { Service } from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { OAuthService } from '../../oauth/oauth.service';
import { RateLimiterFactory } from '../../rate-limiter/rate-limiter-factory.service';
import { DecryptedCredentials } from '../connector-account/types/encrypted-credentials.interface';
import { AuthParser, Connector } from './connector';
import { connectorRegistry } from './connector-registry';
import { ConnectorInstantiationError } from './error';

// Side-effect import: triggers connector self-registration
import './library';

@Injectable()
export class ConnectorsService {
  constructor(
    private readonly oauthService: OAuthService,
    private readonly rateLimiterFactory: RateLimiterFactory,
  ) {}

  getAuthParser(params: { service: Service }): AuthParser | undefined {
    const reg = connectorRegistry.get(params.service);
    return reg?.createAuthParser?.();
  }

  async getConnector(params: {
    service: Service;
    connectorAccount: ConnectorAccount | null;
    decryptedCredentials: DecryptedCredentials | null;
    userId?: string;
  }): Promise<Connector<string, JsonSafeObject>> {
    const { service, connectorAccount, decryptedCredentials, userId } = params;

    const reg = connectorRegistry.get(service);
    if (!reg) {
      throw new ConnectorInstantiationError(`Unsupported service: ${String(service)}`, service);
    }

    return reg.createConnector({
      connectorAccount: connectorAccount
        ? {
            id: connectorAccount.id,
            authType: connectorAccount.authType,
            extras: connectorAccount.extras as Record<string, unknown> | null,
          }
        : null,
      decryptedCredentials,
      userId,
      getOAuthAccessToken: (id) => this.oauthService.getValidAccessToken(id),
      createRateLimiter: (id) => this.rateLimiterFactory.createLimiter({ service, connectorAccountId: id }),
    });
  }
}
