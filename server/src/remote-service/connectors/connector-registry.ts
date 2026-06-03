import {
  AuthMethod,
  ConnectorMetadata,
  ConnectorSettingDefinition,
  DataFolderOptions,
  IncrementalPullSupport,
} from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { RateLimiter } from '../../rate-limiter/rate-limiter';
import { RateLimiterSpec } from '../../rate-limiter/rate-limiter.types';
import { DecryptedCredentials } from '../connector-account/types/encrypted-credentials.interface';
import { AuthParser, Connector } from './connector';
import type { BaseJsonTableSpec } from './types';

export interface ConnectorAccountRef {
  id: string;
  authType: string;
  extras: Record<string, unknown> | null;
  version: number; // Stored snapshot from ConnectorAccount.version (DEV-10302)
}

/**
 * Context passed to connector factory functions during instantiation.
 * Wraps NestJS-injected services as plain functions so connectors don't depend on DI.
 */
export interface ConnectorFactoryContext {
  connectorAccount: ConnectorAccountRef | null;
  decryptedCredentials: DecryptedCredentials | null;
  userId?: string;
  getOAuthAccessToken: (connectorAccountId: string) => Promise<string>;
  createRateLimiter: (connectorAccountId: string) => RateLimiter | undefined;
  /**
   * Look up `DataFolder.options` for a given (connectorAccountId, tableId)
   * pair. Used by connectors whose `fetchJsonTableSpec` needs persisted
   * per-folder state instead of fetching schema from a remote API.
   *
   * The only consumer today is GENERIC_API, which stores per-endpoint probe
   * results in `DataFolder.options.genericApi` and reads them back at pull
   * time. Native connectors that derive schema from a remote schema endpoint
   * (Airtable, Notion, etc.) ignore the callback entirely.
   *
   * Returns null when no folder exists with that tableId for that account.
   */
  getFolderOptionsByTableId: (connectorAccountId: string, tableId: string[]) => Promise<DataFolderOptions | null>;
}

/**
 * Registration record for a connector. Each connector self-registers at import time.
 */
export interface ConnectorRegistration {
  /** The service slug, e.g. 'AIRTABLE' */
  service: string;
  /**
   * Monotonic integer version of this connector's *code*, hand-bumped when a
   * breaking change is introduced. Snapshotted onto ConnectorAccount.version at
   * account-creation time so existing accounts stay pinned to old behavior.
   * Omit to default to 1; bump (e.g. `version: 2`) the first time this connector
   * makes a breaking change. (DEV-10302)
   */
  version?: number;
  /** Display metadata (name, logo, terminology) */
  metadata: ConnectorMetadata;
  /** Per-folder advanced settings exposed by this connector */
  advancedSettings: ConnectorSettingDefinition[];
  /** Auth methods this connector supports */
  supportedAuthMethods: AuthMethod[];
  /** Rate limiter spec, if this connector needs one */
  rateLimiterSpec?: RateLimiterSpec;
  /** Factory that creates a live connector instance */
  createConnector: (ctx: ConnectorFactoryContext) => Promise<Connector<string, JsonSafeObject>>;
  /** Factory that creates an auth parser (for user-provided-params connectors) */
  createAuthParser?: () => AuthParser<string>;
  /**
   * Pure (no credentials, no network) resolver for this folder's
   * incremental-pull capability, used by the REST layer to populate
   * `DataFolder.incrementalPullSupport`. Mirrors the connector instance's
   * `incrementalPullSupport`, but callable without instantiating the connector.
   *
   * Omit it for connectors that are unconditionally supported once
   * `metadata.incrementalPull` is true (e.g. Notion, Linear) — the registry
   * helper defaults those to `SUPPORTED`.
   */
  resolveIncrementalPullSupport?: (params: {
    options: DataFolderOptions;
    tableSpec: BaseJsonTableSpec | null;
    tableId: string[];
  }) => IncrementalPullSupport;
  /**
   * True when this connector can auto-detect its last-modified field from the
   * table schema (Airtable, WordPress). The REST layer uses this to decide
   * whether reading the folder's schema from git could upgrade a
   * `NEEDS_CONFIGURATION` answer to `SUPPORTED` — so it only pays for the schema
   * read when it might change the result.
   */
  incrementalPullAutoDetectsFromSchema?: boolean;
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

/**
 * Resolve a folder's {@link IncrementalPullSupport} from its connector service,
 * persisted options, table id, and (optionally) its table schema — without
 * instantiating the connector or hitting any remote API.
 *
 * Returns `NOT_SUPPORTED` for unknown services and for connectors whose static
 * `metadata.incrementalPull` flag is false. Otherwise it delegates to the
 * connector's registered `resolveIncrementalPullSupport`, defaulting to
 * `SUPPORTED` when the connector registered no resolver (i.e. it is
 * unconditionally supported).
 */
export function resolveIncrementalPullSupportForService(params: {
  service: string;
  options: DataFolderOptions;
  tableSpec: BaseJsonTableSpec | null;
  tableId: string[];
}): IncrementalPullSupport {
  const registration = connectorRegistry.get(params.service);
  if (!registration || !registration.metadata.incrementalPull) {
    return IncrementalPullSupport.NOT_SUPPORTED;
  }
  if (registration.resolveIncrementalPullSupport) {
    return registration.resolveIncrementalPullSupport({
      options: params.options,
      tableSpec: params.tableSpec,
      tableId: params.tableId,
    });
  }
  return IncrementalPullSupport.SUPPORTED;
}
