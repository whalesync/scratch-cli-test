import { ConnectorMetadata, ConnectorSettingDefinition } from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { RateLimiter } from '../../rate-limiter/rate-limiter';
import { RateLimiterSpec } from '../../rate-limiter/rate-limiter.types';
import { DecryptedCredentials } from '../connector-account/types/encrypted-credentials.interface';
import { AuthParser, Connector } from './connector';

/**
 * Context passed to connector factory functions during instantiation.
 * Wraps NestJS-injected services as plain functions so connectors don't depend on DI.
 */
export interface ConnectorFactoryContext {
  connectorAccount: { id: string; authType: string; extras: Record<string, unknown> | null } | null;
  decryptedCredentials: DecryptedCredentials | null;
  userId?: string;
  getOAuthAccessToken: (connectorAccountId: string) => Promise<string>;
  createRateLimiter: (connectorAccountId: string) => RateLimiter | undefined;
}

/**
 * Registration record for a connector. Each connector self-registers at import time.
 */
export interface ConnectorRegistration {
  /** The service slug, e.g. 'AIRTABLE' */
  service: string;
  /** Display metadata (name, logo, terminology) */
  metadata: ConnectorMetadata;
  /** Per-folder advanced settings exposed by this connector */
  advancedSettings: ConnectorSettingDefinition[];
  /** Rate limiter spec, if this connector needs one */
  rateLimiterSpec?: RateLimiterSpec;
  /** Factory that creates a live connector instance */
  createConnector: (ctx: ConnectorFactoryContext) => Promise<Connector<string, JsonSafeObject>>;
  /** Factory that creates an auth parser (for user-provided-params connectors) */
  createAuthParser?: () => AuthParser<string>;
}

class ConnectorRegistry {
  private readonly registrations = new Map<string, ConnectorRegistration>();

  register(registration: ConnectorRegistration): void {
    if (this.registrations.has(registration.service)) {
      throw new Error(`Connector already registered for service: ${registration.service}`);
    }
    this.registrations.set(registration.service, registration);
  }

  get(service: string): ConnectorRegistration | undefined {
    return this.registrations.get(service);
  }

  getAll(): Map<string, ConnectorRegistration> {
    return this.registrations;
  }
}

/** Singleton connector registry — connectors register themselves at import time. */
export const connectorRegistry = new ConnectorRegistry();
