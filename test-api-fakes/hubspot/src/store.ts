export interface HubspotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  description: string;
  hidden: boolean;
  modificationMetadata?: {
    archivable: boolean;
    readOnlyDefinition: boolean;
    readOnlyValue: boolean;
  };
  options?: Array<{ label: string; value: string }>;
}

export interface HubspotRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: Record<
    string,
    { results: Array<{ id: string; type: string }> }
  >;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface CustomObjectSchema {
  fullyQualifiedName: string;
  labels: { plural: string; singular: string };
  properties: HubspotProperty[];
}

interface QueuedError {
  statusCode: number;
  body: unknown;
}

/**
 * `hs_status` values in which HubSpot treats a quote as published and locks it
 * against property edits (DEV-10886). A locked quote must be recalled
 * (`hs_status` → an editable status like DRAFT) before it can be edited.
 */
export const PUBLISHED_LOCKED_QUOTE_STATUSES = new Set([
  "APPROVAL_NOT_NEEDED",
  "APPROVED",
]);

export function isPublishedQuoteStatus(
  status: string | null | undefined,
): boolean {
  return (
    typeof status === "string" && PUBLISHED_LOCKED_QUOTE_STATUSES.has(status)
  );
}

let idCounter = 1;

function generateRecordId(): string {
  return String(idCounter++);
}

class Store {
  /** objectType → Map<recordId, HubspotRecord> */
  records: Map<string, Map<string, HubspotRecord>> = new Map();

  /** objectType → HubspotProperty[] */
  properties: Map<string, HubspotProperty[]> = new Map();

  /** Custom object schemas */
  customObjectSchemas: CustomObjectSchema[] = [];

  /** Error simulation */
  errorQueue: QueuedError[] = [];
  rateLimitCount: number = 0;
  rateLimitRetryAfterSeconds: number = 1;

  reset(): void {
    this.records.clear();
    this.properties.clear();
    this.customObjectSchemas = [];
    this.errorQueue = [];
    this.rateLimitCount = 0;
    this.rateLimitRetryAfterSeconds = 1;
    idCounter = 1;
  }

  setProperties(objectType: string, properties: HubspotProperty[]): void {
    this.properties.set(objectType, properties);
  }

  getProperties(objectType: string): HubspotProperty[] {
    return (
      this.properties.get(objectType) ?? this.getDefaultProperties(objectType)
    );
  }

  addRecord(
    objectType: string,
    properties: Record<string, string | null>,
  ): HubspotRecord {
    if (!this.records.has(objectType)) {
      this.records.set(objectType, new Map());
    }
    const now = new Date().toISOString();
    const record: HubspotRecord = {
      id: generateRecordId(),
      properties: { ...properties, hs_object_id: "" }, // will be set below
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    record.properties.hs_object_id = record.id;
    record.properties.createdate = now;
    record.properties.lastmodifieddate = now;
    this.syncQuoteLockFlag(objectType, record);
    this.records.get(objectType)!.set(record.id, record);
    return record;
  }

  getRecord(objectType: string, recordId: string): HubspotRecord | undefined {
    return this.records.get(objectType)?.get(recordId);
  }

  updateRecord(
    objectType: string,
    recordId: string,
    properties: Record<string, string | null>,
  ): HubspotRecord | undefined {
    const record = this.records.get(objectType)?.get(recordId);
    if (!record || record.archived) return undefined;
    record.properties = { ...record.properties, ...properties };
    record.updatedAt = new Date().toISOString();
    record.properties.lastmodifieddate = record.updatedAt;
    this.syncQuoteLockFlag(objectType, record);
    return record;
  }

  /**
   * Keep a quote's read-only `hs_locked` flag consistent with its `hs_status`,
   * mirroring HubSpot: publishing a quote locks it; recalling it to a draft
   * status unlocks it (DEV-10886). No-op for non-quote object types.
   */
  private syncQuoteLockFlag(objectType: string, record: HubspotRecord): void {
    if (objectType !== "quotes") return;
    record.properties.hs_locked = isPublishedQuoteStatus(
      record.properties.hs_status,
    )
      ? "true"
      : "false";
  }

  /**
   * Override a record's last-modified timestamp (both `updatedAt` and the
   * `lastmodifieddate` property) to a fixed ISO string. Lets incremental-pull
   * tests place records deterministically before/after a chosen watermark
   * instead of depending on wall-clock timing.
   */
  setModifiedAt(
    objectType: string,
    recordId: string,
    isoTimestamp: string,
  ): boolean {
    const record = this.records.get(objectType)?.get(recordId);
    if (!record) return false;
    record.updatedAt = isoTimestamp;
    record.properties.lastmodifieddate = isoTimestamp;
    return true;
  }

  deleteRecord(objectType: string, recordId: string): boolean {
    const record = this.records.get(objectType)?.get(recordId);
    if (!record) return false;
    record.archived = true;
    return true;
  }

  listRecords(objectType: string): HubspotRecord[] {
    const recordMap = this.records.get(objectType);
    if (!recordMap) return [];
    return Array.from(recordMap.values()).filter((r) => !r.archived);
  }

  /** Add an association between two records */
  addAssociation(
    fromObjectType: string,
    fromId: string,
    toObjectType: string,
    toId: string,
  ): boolean {
    const record = this.getRecord(fromObjectType, fromId);
    if (!record) return false;
    if (!record.associations) record.associations = {};
    if (!record.associations[toObjectType]) {
      record.associations[toObjectType] = { results: [] };
    }
    // Don't add duplicates
    const existing = record.associations[toObjectType].results;
    if (!existing.some((a) => a.id === toId)) {
      existing.push({ id: toId, type: `${fromObjectType}_to_${toObjectType}` });
    }
    return true;
  }

  /** Remove an association between two records */
  removeAssociation(
    fromObjectType: string,
    fromId: string,
    toObjectType: string,
    toId: string,
  ): boolean {
    const record = this.getRecord(fromObjectType, fromId);
    if (!record?.associations?.[toObjectType]) return false;
    const results = record.associations[toObjectType].results;
    const idx = results.findIndex((a) => a.id === toId);
    if (idx === -1) return false;
    results.splice(idx, 1);
    if (results.length === 0) {
      delete record.associations[toObjectType];
    }
    return true;
  }

  queueError(statusCode: number, body: unknown): void {
    this.errorQueue.push({ statusCode, body });
  }

  queueRateLimit(count: number, retryAfterSeconds: number = 1): void {
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

  private getDefaultProperties(objectType: string): HubspotProperty[] {
    // Return sensible defaults based on object type
    const common: HubspotProperty[] = [
      {
        name: "hs_object_id",
        label: "Object ID",
        type: "string",
        fieldType: "text",
        description: "Object ID",
        hidden: false,
        modificationMetadata: {
          archivable: false,
          readOnlyDefinition: true,
          readOnlyValue: true,
        },
      },
      {
        name: "createdate",
        label: "Create date",
        type: "datetime",
        fieldType: "date",
        description: "Create date",
        hidden: false,
        modificationMetadata: {
          archivable: false,
          readOnlyDefinition: true,
          readOnlyValue: true,
        },
      },
      {
        name: "lastmodifieddate",
        label: "Last modified date",
        type: "datetime",
        fieldType: "date",
        description: "Last modified date",
        hidden: false,
        modificationMetadata: {
          archivable: false,
          readOnlyDefinition: true,
          readOnlyValue: true,
        },
      },
    ];

    const objectSpecific: Record<string, HubspotProperty[]> = {
      contacts: [
        {
          name: "email",
          label: "Email",
          type: "string",
          fieldType: "text",
          description: "Email",
          hidden: false,
        },
        {
          name: "firstname",
          label: "First Name",
          type: "string",
          fieldType: "text",
          description: "First name",
          hidden: false,
        },
        {
          name: "lastname",
          label: "Last Name",
          type: "string",
          fieldType: "text",
          description: "Last name",
          hidden: false,
        },
        {
          name: "company",
          label: "Company",
          type: "string",
          fieldType: "text",
          description: "Company name",
          hidden: false,
        },
      ],
      companies: [
        {
          name: "name",
          label: "Name",
          type: "string",
          fieldType: "text",
          description: "Company name",
          hidden: false,
        },
        {
          name: "domain",
          label: "Domain",
          type: "string",
          fieldType: "text",
          description: "Company domain",
          hidden: false,
        },
      ],
      quotes: [
        {
          name: "hs_title",
          label: "Quote Title",
          type: "string",
          fieldType: "text",
          description: "Quote title",
          hidden: false,
        },
        {
          name: "hs_terms",
          label: "Terms",
          type: "string",
          fieldType: "textarea",
          description: "Quote terms",
          hidden: false,
        },
        {
          name: "hs_status",
          label: "Status",
          type: "enumeration",
          fieldType: "select",
          description: "Quote status",
          hidden: false,
          options: [
            { label: "Draft", value: "DRAFT" },
            { label: "Pending Approval", value: "PENDING_APPROVAL" },
            { label: "Approved", value: "APPROVED" },
            { label: "Approval Not Needed", value: "APPROVAL_NOT_NEEDED" },
          ],
        },
        {
          // Read-only lock flag HubSpot flips to true once a quote is published.
          name: "hs_locked",
          label: "Locked",
          type: "bool",
          fieldType: "booleancheckbox",
          description: "Whether the quote is locked",
          hidden: false,
          modificationMetadata: {
            archivable: false,
            readOnlyDefinition: true,
            readOnlyValue: true,
          },
        },
      ],
      deals: [
        {
          name: "dealname",
          label: "Deal Name",
          type: "string",
          fieldType: "text",
          description: "Deal name",
          hidden: false,
        },
        {
          name: "amount",
          label: "Amount",
          type: "number",
          fieldType: "number",
          description: "Deal amount",
          hidden: false,
        },
        {
          name: "dealstage",
          label: "Deal Stage",
          type: "enumeration",
          fieldType: "select",
          description: "Deal stage",
          hidden: false,
          options: [
            { label: "Appointment Scheduled", value: "appointmentscheduled" },
            { label: "Qualified to Buy", value: "qualifiedtobuy" },
            { label: "Closed Won", value: "closedwon" },
            { label: "Closed Lost", value: "closedlost" },
          ],
        },
      ],
    };

    return [...common, ...(objectSpecific[objectType] ?? [])];
  }
}

export const store = new Store();
