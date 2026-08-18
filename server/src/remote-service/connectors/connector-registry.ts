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
import { ConnectorAuthTokenProvider } from './connector-auth-token';
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
  /**
   * Build a provider that hands back a **currently valid** OAuth access token for
   * this connection every time it is called, refreshing it through the host's
   * OAuth service whenever the stored one is close to expiring.
   *
   * Connectors must hold the provider and call it per outbound request (via
   * `createApiClient`'s `authorizationHeaderValueProvider`) rather than resolving
   * a token once at instantiation: a job that outlives the provider's token
   * lifetime — an hour on Google, for many others too — otherwise 401s on every
   * call from that moment on and can never recover (DEV-11270).
   *
   * Calling it eagerly once inside `createConnector` is still the right way to
   * fail fast when a connection can no longer produce a token at all.
   */
  createOAuthAccessTokenProvider: (connectorAccountId: string) => ConnectorAuthTokenProvider;
  createRateLimiter: (connectorAccountId: string) => RateLimiter | undefined;
  /**
   * Look up `DataFolder.options` for a given (connectorAccountId, tableId)
   * pair. Used by connectors whose `fetchJsonTableSpec` needs persisted
   * per-folder state instead of fetching schema from a remote API.
   *
   * GENERIC_API stores per-endpoint probe results in
   * `DataFolder.options.genericApi` and reads them back at pull time. NOTION
   * reads the folder's page-content settings (`excludePageContent`,
   * `childContentMaxDepth`) on the per-page paths that get no pull options —
   * targeted pulls and the post-update refetch. Native connectors with no
   * per-folder behavior outside the pull (Airtable, etc.) ignore the callback.
   *
   * Returns null when no folder exists with that tableId for that account.
   */
  getFolderOptionsByTableId: (connectorAccountId: string, tableId: string[]) => Promise<DataFolderOptions | null>;
  /**
   * List the `DataFolder.tableId` of every folder on a connector account. For
   * connectors that can't enumerate their remote resources (Google Sheets has no
   * Drive scope, so it can't list the user's spreadsheets), the folders a user
   * already created are the connection's memory of which resources it knows —
   * `listTables` / `listCreateDestinations` derive their listing from them.
   * Connectors with real list APIs ignore it (like `getFolderOptionsByTableId`).
   */
  listFolderTableIds: (connectorAccountId: string) => Promise<string[][]>;
  /**
   * Evaluate a host feature flag for the user this connector instance is acting
   * on behalf of (`ctx.userId`). Lets a connector gate its own behavior behind a
   * flag without taking a dependency on the experiments / PostHog stack — the
   * host binds the user and the flag backend; the connector just passes a flag
   * key string. Fail-closed: returns `false` when no user is bound, the user
   * can't be found, or the lookup errors. Connectors that gate nothing ignore it
   * (like `getFolderOptionsByTableId`).
   *
   * Today's only consumer is AFFINITY, which gates create/update/delete behind
   * `ENABLE_AFFINITY_WRITE` while publishing is productionized (DEV-10298).
   */
  isFeatureEnabled: (flagKey: string) => Promise<boolean>;
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
  /**
   * Pure (no credentials, no network) hook that, given a **matched** destination
   * record's on-disk fields, returns the field overlay that would repair an
   * archived / soft-deleted destination record back to live — or `null` when the
   * record isn't archived (the common case) or the connector has no such notion.
   *
   * Used by Live Export reconciliation (sync Pass 2). When a destination page is
   * archived in the service but its source row still exists, the sync plans no
   * edit if no field drifted, so the mirror silently stays archived (DEV-11013).
   * Overlaying these fields onto the matched record forces a write (bypassing the
   * no-op skip) whose publish restores the page — for Notion, clearing whichever
   * of `archived` / `in_trash` / `is_archived` the pulled record carries.
   *
   * Kept connector-scoped so the generic sync executor never learns a service's
   * archive-flag spelling; connectors with no archive-repair notion omit it and
   * the registry helper returns `null` (like `resolveIncrementalPullSupport`).
   */
  resolveMatchedRecordArchiveRepairFields?: (recordFields: Record<string, unknown>) => Record<string, unknown> | null;
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

/**
 * Resolve the archive-repair field overlay for a **matched** destination record
 * from its connector service — without instantiating the connector or hitting
 * any remote API. Returns `null` for unknown services, connectors that register
 * no {@link ConnectorRegistration.resolveMatchedRecordArchiveRepairFields}, and
 * records that aren't archived. See that field's doc for the DEV-11013 use case.
 */
export function resolveMatchedRecordArchiveRepairFieldsForService(
  service: string,
  recordFields: Record<string, unknown>,
): Record<string, unknown> | null {
  const registration = connectorRegistry.get(service);
  return registration?.resolveMatchedRecordArchiveRepairFields?.(recordFields) ?? null;
}
