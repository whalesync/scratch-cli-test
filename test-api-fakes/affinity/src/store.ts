/**
 * In-memory store for the fake Affinity v2 API.
 *
 * The data model mirrors Affinity's REST contract:
 *
 *   Lists           → top-level container, one entity type per list
 *   Field metadata  → per-list (List endpoints) — describes columns
 *   List entries    → per-list rows, each holding an `entity` (Company/Person/Opportunity)
 *                     and an array of populated Field values
 *
 * The connector reads via four endpoints (`/v2/lists`, `/v2/lists/{id}`,
 * `/v2/lists/{id}/fields`, `/v2/lists/{id}/list-entries`) plus the v1
 * `/rate-limit` endpoint, so this store only needs to back those.
 *
 * Quota counters live here too — every authenticated v2 request decrements
 * `userMinuteUsed` and `orgMonthlyUsed` so `/rate-limit` can return live values.
 */

export type AffinityEntityType = "company" | "person" | "opportunity";

export type AffinityFieldType =
  | "enriched"
  | "global"
  | "list"
  | "relationship-intelligence";

export type AffinityValueType =
  | "person"
  | "person-multi"
  | "company"
  | "company-multi"
  | "filterable-text"
  | "filterable-text-multi"
  | "number"
  | "number-multi"
  | "datetime"
  | "location"
  | "location-multi"
  | "text"
  | "ranked-dropdown"
  | "dropdown"
  | "dropdown-multi"
  | "formula-number"
  | "interaction";

export interface AffinityList {
  id: number;
  name: string;
  type: AffinityEntityType;
  isPublic: boolean;
  ownerId: number;
  creatorId: number;
}

export interface AffinityFieldMetadata {
  id: string;
  name: string;
  type: AffinityFieldType;
  enrichmentSource: string | null;
  valueType: AffinityValueType;
}

export interface AffinityField {
  id: string;
  name: string;
  type: AffinityFieldType;
  enrichmentSource: string | null;
  value: { type: string; data: unknown } | null;
}

export interface AffinityCompany {
  id: number;
  name: string;
  domain: string | null;
  domains: string[];
  isGlobal: boolean;
  fields: AffinityField[];
}

export interface AffinityPerson {
  id: number;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: string | null;
  emailAddresses: string[];
  type: string;
  fields: AffinityField[];
}

export interface AffinityOpportunity {
  id: number;
  name: string;
  listId: number;
  fields: AffinityField[];
}

export type AffinityEntity =
  | AffinityCompany
  | AffinityPerson
  | AffinityOpportunity;

export interface AffinityListEntry {
  id: number;
  type: AffinityEntityType;
  listId: number;
  createdAt: string;
  creatorId: number | null;
  entity: AffinityEntity;
}

interface QueuedError {
  statusCode: number;
  body: unknown;
}

class Store {
  // Lists, keyed by list id
  lists: Map<number, AffinityList> = new Map();

  // Field metadata per list, keyed by list id → ordered array
  fieldsByList: Map<number, AffinityFieldMetadata[]> = new Map();

  // List entries per list, keyed by list id → ordered array
  entriesByList: Map<number, AffinityListEntry[]> = new Map();

  // Tenant-wide records (independent of any list).
  // The connector reads these via GET /v2/persons, /v2/companies, and
  // /v2/opportunities. Each map is keyed by record id so the per-record
  // GET /v2/{kind}/{id} endpoints can do O(1) lookups.
  tenantPersons: Map<number, AffinityPerson> = new Map();
  tenantCompanies: Map<number, AffinityCompany> = new Map();
  tenantOpportunities: Map<number, AffinityOpportunity> = new Map();

  // Tenant-wide field metadata. Persons + companies have a /v2/{kind}/fields
  // endpoint; opportunities does not (Affinity v2 has no per-tenant
  // opportunity field metadata at all).
  tenantPersonFields: AffinityFieldMetadata[] = [];
  tenantCompanyFields: AffinityFieldMetadata[] = [];

  // Error simulation
  errorQueue: QueuedError[] = [];
  rateLimitCount: number = 0;
  rateLimitRetryAfterSeconds: number = 30;

  // Live quota counters — exposed via the v1 /rate-limit endpoint and
  // decremented on every authenticated v2 request. Mirrors Affinity's real caps:
  // 900 req/min per API key, 100k req/month per org (Scale tier).
  static readonly USER_MINUTE_LIMIT = 900;
  static readonly ORG_MONTHLY_LIMIT = 100_000;
  userMinuteUsed: number = 0;
  orgMonthlyUsed: number = 0;

  reset(): void {
    this.lists.clear();
    this.fieldsByList.clear();
    this.entriesByList.clear();
    this.tenantPersons.clear();
    this.tenantCompanies.clear();
    this.tenantOpportunities.clear();
    this.tenantPersonFields = [];
    this.tenantCompanyFields = [];
    this.errorQueue = [];
    this.rateLimitCount = 0;
    this.rateLimitRetryAfterSeconds = 30;
    this.userMinuteUsed = 0;
    this.orgMonthlyUsed = 0;
  }

  // ---- Lists ----

  addList(list: AffinityList): void {
    this.lists.set(list.id, list);
    if (!this.fieldsByList.has(list.id)) this.fieldsByList.set(list.id, []);
    if (!this.entriesByList.has(list.id)) this.entriesByList.set(list.id, []);
  }

  getList(listId: number): AffinityList | undefined {
    return this.lists.get(listId);
  }

  listLists(): AffinityList[] {
    return Array.from(this.lists.values());
  }

  // ---- Fields ----

  setFieldsForList(listId: number, fields: AffinityFieldMetadata[]): void {
    this.fieldsByList.set(listId, fields);
  }

  getFieldsForList(listId: number): AffinityFieldMetadata[] {
    return this.fieldsByList.get(listId) ?? [];
  }

  // ---- List entries ----

  setEntriesForList(listId: number, entries: AffinityListEntry[]): void {
    this.entriesByList.set(listId, entries);
  }

  addEntry(listId: number, entry: AffinityListEntry): void {
    const existing = this.entriesByList.get(listId) ?? [];
    existing.push(entry);
    this.entriesByList.set(listId, existing);
  }

  getEntries(listId: number): AffinityListEntry[] {
    return this.entriesByList.get(listId) ?? [];
  }

  getEntry(listId: number, entryId: number): AffinityListEntry | undefined {
    return this.getEntries(listId).find((e) => e.id === entryId);
  }

  // ---- Tenant-wide records ----

  setTenantPersons(persons: AffinityPerson[]): void {
    this.tenantPersons.clear();
    for (const p of persons) this.tenantPersons.set(p.id, p);
  }

  setTenantCompanies(companies: AffinityCompany[]): void {
    this.tenantCompanies.clear();
    for (const c of companies) this.tenantCompanies.set(c.id, c);
  }

  setTenantOpportunities(opps: AffinityOpportunity[]): void {
    this.tenantOpportunities.clear();
    for (const o of opps) this.tenantOpportunities.set(o.id, o);
  }

  listTenantPersons(): AffinityPerson[] {
    return Array.from(this.tenantPersons.values());
  }

  listTenantCompanies(): AffinityCompany[] {
    return Array.from(this.tenantCompanies.values());
  }

  listTenantOpportunities(): AffinityOpportunity[] {
    return Array.from(this.tenantOpportunities.values());
  }

  getTenantPerson(id: number): AffinityPerson | undefined {
    return this.tenantPersons.get(id);
  }

  getTenantCompany(id: number): AffinityCompany | undefined {
    return this.tenantCompanies.get(id);
  }

  getTenantOpportunity(id: number): AffinityOpportunity | undefined {
    return this.tenantOpportunities.get(id);
  }

  setTenantPersonFields(fields: AffinityFieldMetadata[]): void {
    this.tenantPersonFields = fields;
  }

  setTenantCompanyFields(fields: AffinityFieldMetadata[]): void {
    this.tenantCompanyFields = fields;
  }

  getTenantPersonFields(): AffinityFieldMetadata[] {
    return this.tenantPersonFields;
  }

  getTenantCompanyFields(): AffinityFieldMetadata[] {
    return this.tenantCompanyFields;
  }

  // ---- Error simulation ----

  queueError(statusCode: number, body: unknown): void {
    this.errorQueue.push({ statusCode, body });
  }

  queueRateLimit(count: number, retryAfterSeconds: number = 30): void {
    this.rateLimitCount = count;
    this.rateLimitRetryAfterSeconds = retryAfterSeconds;
  }

  checkErrorQueue(): QueuedError | null {
    if (this.errorQueue.length === 0) return null;
    return this.errorQueue.shift()!;
  }

  checkRateLimit(): number | null {
    if (this.rateLimitCount <= 0) return null;
    this.rateLimitCount--;
    return this.rateLimitRetryAfterSeconds;
  }

  // ---- Quota tracking ----

  /** Decrement live quota counters. Called by middleware on every authenticated v2 request. */
  consumeQuota(): void {
    this.userMinuteUsed++;
    this.orgMonthlyUsed++;
  }
}

export const store = new Store();
