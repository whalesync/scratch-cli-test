export interface SiteInfo {
  name: string;
  url: string;
}

export interface PostType {
  name: string;
  rest_base: string;
  rest_namespace: string;
  slug: string;
  description: string;
  hierarchical: boolean;
}

export interface Taxonomy {
  name: string;
  slug: string;
  rest_base: string;
  rest_namespace: string;
  description: string;
  hierarchical: boolean;
  types: string[];
}

export interface SchemaProperty {
  description?: string;
  type?: string | string[];
  context?: string[];
  readonly?: boolean;
  [key: string]: unknown;
}

export interface EndpointSchema {
  endpoints: Array<{
    methods: string[];
    args: Record<string, unknown>;
  }>;
  schema: {
    properties: Record<string, SchemaProperty>;
  };
}

export interface WordPressRecord {
  id: number;
  [key: string]: unknown;
}

export interface MediaRecord {
  id: number;
  source_url: string;
  mime_type: string;
  title: { rendered: string };
  media_details: {
    filesize: number;
    width: number;
    height: number;
  };
  [key: string]: unknown;
}

interface QueuedError {
  statusCode: number;
  body: unknown;
}

class Store {
  siteInfo: SiteInfo = {
    name: "Test WordPress Site",
    url: "http://localhost:4647",
  };
  postTypes: Map<string, PostType> = new Map();
  taxonomies: Map<string, Taxonomy> = new Map();
  schemas: Map<string, EndpointSchema> = new Map();
  records: Map<string, Map<string, WordPressRecord>> = new Map();
  media: Map<string, MediaRecord> = new Map();
  nextRecordId: Map<string, number> = new Map();
  nextMediaId: number = 1;
  errorQueue: QueuedError[] = [];
  rateLimitCount: number = 0;
  rateLimitRetryAfterSeconds: number = 30;

  reset(): void {
    this.siteInfo = {
      name: "Test WordPress Site",
      url: "http://localhost:4647",
    };
    this.postTypes.clear();
    this.taxonomies.clear();
    this.schemas.clear();
    this.records.clear();
    this.media.clear();
    this.nextRecordId.clear();
    this.nextMediaId = 1;
    this.errorQueue = [];
    this.rateLimitCount = 0;
    this.rateLimitRetryAfterSeconds = 30;
  }

  generateRecordId(tableId: string): number {
    const current = this.nextRecordId.get(tableId) ?? 1;
    this.nextRecordId.set(tableId, current + 1);
    return current;
  }

  generateMediaId(): number {
    return this.nextMediaId++;
  }

  addRecord(tableId: string, fields: Record<string, unknown>): WordPressRecord {
    if (!this.records.has(tableId)) {
      this.records.set(tableId, new Map());
    }
    const id = this.generateRecordId(tableId);
    const record: WordPressRecord = {
      id,
      ...fields,
    };
    this.records.get(tableId)!.set(String(id), record);
    return record;
  }

  getRecord(tableId: string, recordId: string): WordPressRecord | undefined {
    return this.records.get(tableId)?.get(recordId);
  }

  updateRecord(
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): WordPressRecord | undefined {
    const record = this.records.get(tableId)?.get(recordId);
    if (!record) return undefined;
    Object.assign(record, fields);
    return record;
  }

  deleteRecord(tableId: string, recordId: string): WordPressRecord | undefined {
    const recordMap = this.records.get(tableId);
    if (!recordMap) return undefined;
    const record = recordMap.get(recordId);
    if (!record) return undefined;
    recordMap.delete(recordId);
    return record;
  }

  listRecords(tableId: string): WordPressRecord[] {
    const recordMap = this.records.get(tableId);
    return recordMap ? Array.from(recordMap.values()) : [];
  }

  addMedia(media: Omit<MediaRecord, "id">): MediaRecord {
    const id = this.generateMediaId();
    const record: MediaRecord = Object.assign({ id } as MediaRecord, media);
    this.media.set(String(id), record);
    return record;
  }

  getMedia(mediaId: string): MediaRecord | undefined {
    return this.media.get(mediaId);
  }

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
}

export const store = new Store();
