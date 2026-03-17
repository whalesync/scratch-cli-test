import { Injectable } from '@nestjs/common';
import { Service } from 'src/types/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { RateLimiterFactory } from '../../rate-limiter/rate-limiter-factory.service';
import { Connector } from './connector';
import { ConnectorInstantiationError } from './error';
import { AirtableConnector } from './library/airtable/airtable-connector';
import { WebflowConnector } from './library/webflow/webflow-connector';

export interface ConnectorAccountRef {
  id: string;
}

@Injectable()
export class ConnectorsService {
  constructor(private readonly rateLimiterFactory: RateLimiterFactory) {}

  async getConnector(params: {
    service: Service;
    connectorAccount: ConnectorAccountRef;
    apiKey: string;
  }): Promise<Connector<Service, JsonSafeObject>> {
    const { service, connectorAccount, apiKey } = params;

    switch (service) {
      case Service.AIRTABLE: {
        const rateLimiter = this.rateLimiterFactory.createLimiter({ service, connectorAccountId: connectorAccount.id });
        return new AirtableConnector(apiKey, { rateLimiter });
      }
      case Service.WEBFLOW: {
        const rateLimiter = this.rateLimiterFactory.createLimiter({ service, connectorAccountId: connectorAccount.id });
        return new WebflowConnector(apiKey, { rateLimiter });
      }
      default:
        throw new ConnectorInstantiationError(`Unsupported service: ${String(service)}`, service);
    }
  }
}
