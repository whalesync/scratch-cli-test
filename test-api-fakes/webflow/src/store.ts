/**
 * In-memory state for the fake Webflow Data API v2.
 *
 * Shapes mirror the real API's response bodies exactly (see
 * `server/src/remote-service/connectors/library/webflow/webflow-types.ts`) —
 * the connector stores what Webflow returns verbatim, so a fake that reshapes
 * anything would let a Prime Directive violation pass the smoke suite.
 */

export interface Locale {
  id: string;
  cmsLocaleId: string;
  enabled: boolean;
  displayName: string;
  displayImageId?: string | null;
  redirect?: boolean;
  subdirectory: string;
  tag: string;
}

export interface Locales {
  primary?: Locale;
  secondary?: Locale[];
}

export interface Site {
  id: string;
  workspaceId: string;
  createdOn: string;
  displayName: string;
  shortName: string;
  lastPublished: string;
  lastUpdated: string;
  previewUrl: string;
  timeZone: string;
  locales?: Locales;
}

export interface Field {
  id: string;
  isRequired: boolean;
  isEditable: boolean;
  type: string;
  slug: string;
  displayName: string;
  helpText?: string | null;
}

export interface Collection {
  id: string;
  displayName: string;
  singularName: string;
  slug: string;
  createdOn: string;
  lastUpdated: string;
  fields: Field[];
}

export interface CollectionItem {
  id: string;
  cmsLocaleId: string | null;
  lastPublished: string | null;
  lastUpdated: string;
  createdOn: string;
  isArchived: boolean;
  isDraft: boolean;
  fieldData: Record<string, unknown>;
}

/**
 * The scopes a Webflow site token can carry. The fake enforces these because a
 * missing scope is the exact failure DEV-11321 shipped to a customer: a token
 * with `sites:read` but not `cms:read` listed sites happily and then 403'd on
 * every collections call, and nothing in the stack caught it.
 */
export type WebflowScope = "sites:read" | "cms:read" | "cms:write";

export const ALL_WEBFLOW_SCOPES: WebflowScope[] = [
  "sites:read",
  "cms:read",
  "cms:write",
];

interface QueuedError {
  statusCode: number;
  body: unknown;
}

const DEFAULT_TOKEN = "wf_fake_smoke_test_token";

class WebflowStore {
  /** Access token → the scopes that token was generated with. */
  tokenScopes = new Map<string, WebflowScope[]>();
  sites = new Map<string, Site>();
  /** Collection id → collection (including its field definitions). */
  collections = new Map<string, Collection>();
  /** Collection id → the site that owns it. */
  collectionSiteId = new Map<string, string>();
  /** Collection id → its items, in insertion order. */
  items = new Map<string, CollectionItem[]>();

  private rateLimitRemaining = 0;
  private rateLimitRetryAfterSeconds = 1;
  private errorQueue: QueuedError[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    this.tokenScopes.clear();
    this.tokenScopes.set(DEFAULT_TOKEN, [...ALL_WEBFLOW_SCOPES]);
    this.sites.clear();
    this.collections.clear();
    this.collectionSiteId.clear();
    this.items.clear();
    this.rateLimitRemaining = 0;
    this.rateLimitRetryAfterSeconds = 1;
    this.errorQueue = [];
  }

  scopesForToken(token: string): WebflowScope[] | undefined {
    return this.tokenScopes.get(token);
  }

  /*
   * The three builders below assemble their objects key-by-key, in the order the
   * real API emits them (`id` first), rather than spreading the caller's partial
   * over a defaults object. Webflow items land on disk verbatim under the
   * Connector Prime Directive, so key order is part of what the connector is
   * supposed to preserve — a fake that reordered keys could hide a real fidelity
   * regression behind a passing smoke test.
   */

  addSite(site: Partial<Site> & { id: string }): Site {
    const now = new Date().toISOString();
    const full: Site = {
      id: site.id,
      workspaceId: site.workspaceId ?? "wks_fake",
      createdOn: site.createdOn ?? now,
      displayName: site.displayName ?? site.id,
      shortName: site.shortName ?? site.id,
      lastPublished: site.lastPublished ?? now,
      lastUpdated: site.lastUpdated ?? now,
      previewUrl: site.previewUrl ?? `https://fake.webflow.com/${site.id}.png`,
      timeZone: site.timeZone ?? "America/Los_Angeles",
      ...(site.locales ? { locales: site.locales } : {}),
    };
    this.sites.set(full.id, full);
    return full;
  }

  addCollection(
    siteId: string,
    collection: Partial<Collection> & { id: string },
  ): Collection {
    const now = new Date().toISOString();
    const full: Collection = {
      id: collection.id,
      displayName: collection.displayName ?? collection.id,
      singularName: collection.singularName ?? collection.id,
      slug: collection.slug ?? collection.id,
      createdOn: collection.createdOn ?? now,
      lastUpdated: collection.lastUpdated ?? now,
      fields: collection.fields ?? [],
    };
    this.collections.set(full.id, full);
    this.collectionSiteId.set(full.id, siteId);
    if (!this.items.has(full.id)) {
      this.items.set(full.id, []);
    }
    return full;
  }

  addItem(
    collectionId: string,
    item: Partial<CollectionItem> & { id: string },
  ): CollectionItem {
    const now = new Date().toISOString();
    const full: CollectionItem = {
      id: item.id,
      cmsLocaleId: item.cmsLocaleId ?? null,
      lastPublished: item.lastPublished ?? now,
      lastUpdated: item.lastUpdated ?? now,
      createdOn: item.createdOn ?? now,
      isArchived: item.isArchived ?? false,
      isDraft: item.isDraft ?? false,
      fieldData: item.fieldData ?? {},
    };
    const existing = this.items.get(collectionId) ?? [];
    existing.push(full);
    this.items.set(collectionId, existing);
    return full;
  }

  collectionsForSite(siteId: string): Collection[] {
    return Array.from(this.collections.values()).filter(
      (collection) => this.collectionSiteId.get(collection.id) === siteId,
    );
  }

  queueRateLimit(count: number, retryAfterSeconds = 1): void {
    this.rateLimitRemaining = count;
    this.rateLimitRetryAfterSeconds = retryAfterSeconds;
  }

  /** Returns the `Retry-After` value when this request should be rate limited. */
  checkRateLimit(): number | null {
    if (this.rateLimitRemaining <= 0) {
      return null;
    }
    this.rateLimitRemaining -= 1;
    return this.rateLimitRetryAfterSeconds;
  }

  queueError(statusCode: number, body: unknown): void {
    this.errorQueue.push({ statusCode, body });
  }

  checkErrorQueue(): QueuedError | null {
    return this.errorQueue.shift() ?? null;
  }
}

export const store = new WebflowStore();
