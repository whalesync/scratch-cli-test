export interface QuickBooksEntity {
  Id: string;
  [key: string]: unknown;
}

interface QueuedError {
  statusCode: number;
  body: unknown;
}

class Store {
  /** Map<PascalCaseEntityType, Map<id, entity>> */
  entities: Map<string, Map<string, QuickBooksEntity>> = new Map();
  companyInfo: Record<string, unknown> = { CompanyName: "Test Company" };
  errorQueue: QueuedError[] = [];
  rateLimitCount: number = 0;
  rateLimitRetryAfterSeconds: number = 30;
  private nextId: number = 1;

  reset(): void {
    this.entities.clear();
    this.companyInfo = { CompanyName: "Test Company" };
    this.errorQueue = [];
    this.rateLimitCount = 0;
    this.rateLimitRetryAfterSeconds = 30;
    this.nextId = 1;
  }

  generateId(): string {
    return String(this.nextId++);
  }

  addEntity(entityType: string, entity: QuickBooksEntity): QuickBooksEntity {
    if (!this.entities.has(entityType)) {
      this.entities.set(entityType, new Map());
    }
    if (!entity.Id) {
      entity.Id = this.generateId();
    }
    this.entities.get(entityType)!.set(entity.Id, entity);
    return entity;
  }

  getEntity(entityType: string, id: string): QuickBooksEntity | undefined {
    return this.entities.get(entityType)?.get(id);
  }

  listEntities(entityType: string): QuickBooksEntity[] {
    const entityMap = this.entities.get(entityType);
    return entityMap ? Array.from(entityMap.values()) : [];
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
