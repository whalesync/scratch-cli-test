export interface Base {
  id: string;
  name: string;
  permissionLevel: string;
}

export interface Field {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
}

export interface View {
  id: string;
  name: string;
  type: string;
}

export interface Table {
  id: string;
  name: string;
  description?: string;
  primaryFieldId: string;
  fields: Field[];
  views: View[];
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime: string;
}

interface QueuedError {
  statusCode: number;
  body: unknown;
}

function generateRecordId(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "rec";
  for (let i = 0; i < 14; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

class Store {
  bases: Map<string, Base> = new Map();
  tables: Map<string, Map<string, Table>> = new Map();
  records: Map<string, Map<string, AirtableRecord>> = new Map();
  errorQueue: QueuedError[] = [];
  rateLimitCount: number = 0;
  rateLimitRetryAfterSeconds: number = 30;
  responseDelayMs: number = 0;

  reset(): void {
    this.bases.clear();
    this.tables.clear();
    this.records.clear();
    this.errorQueue = [];
    this.rateLimitCount = 0;
    this.rateLimitRetryAfterSeconds = 30;
    this.responseDelayMs = 0;
  }

  addBase(base: Base): void {
    this.bases.set(base.id, base);
  }

  addTable(baseId: string, table: Table): void {
    if (!this.tables.has(baseId)) {
      this.tables.set(baseId, new Map());
    }
    this.tables.get(baseId)!.set(table.id, table);
  }

  addRecord(
    baseId: string,
    tableId: string,
    fields: Record<string, unknown>,
  ): AirtableRecord {
    const key = `${baseId}:${tableId}`;
    if (!this.records.has(key)) {
      this.records.set(key, new Map());
    }
    const record: AirtableRecord = {
      id: generateRecordId(),
      fields,
      createdTime: new Date().toISOString(),
    };
    this.records.get(key)!.set(record.id, record);
    return record;
  }

  getRecord(
    baseId: string,
    tableId: string,
    recordId: string,
  ): AirtableRecord | undefined {
    const key = `${baseId}:${tableId}`;
    return this.records.get(key)?.get(recordId);
  }

  updateRecord(
    baseId: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): AirtableRecord | undefined {
    const key = `${baseId}:${tableId}`;
    const record = this.records.get(key)?.get(recordId);
    if (!record) return undefined;
    record.fields = { ...record.fields, ...fields };
    return record;
  }

  deleteRecord(baseId: string, tableId: string, recordId: string): boolean {
    const key = `${baseId}:${tableId}`;
    const recordMap = this.records.get(key);
    if (!recordMap) return false;
    return recordMap.delete(recordId);
  }

  listBases(): Base[] {
    return Array.from(this.bases.values());
  }

  listTables(baseId: string): Table[] | undefined {
    const tableMap = this.tables.get(baseId);
    if (!tableMap && !this.bases.has(baseId)) return undefined;
    return tableMap ? Array.from(tableMap.values()) : [];
  }

  listRecords(baseId: string, tableId: string): AirtableRecord[] {
    const key = `${baseId}:${tableId}`;
    const recordMap = this.records.get(key);
    return recordMap ? Array.from(recordMap.values()) : [];
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

  setResponseDelay(ms: number): void {
    this.responseDelayMs = ms;
  }
}

export const store = new Store();
