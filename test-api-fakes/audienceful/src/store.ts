export interface PersonTag {
  name: string;
}

export interface Person {
  uid: string;
  email: string;
  tags: PersonTag[];
  notes: string;
  extra_data: Record<string, unknown>;
  created: string;
  updated: string;
  [key: string]: unknown;
}

export interface CustomField {
  id: number;
  name: string;
  data_name: string;
  type: string;
  editable: boolean;
  required: boolean;
}

interface QueuedError {
  statusCode: number;
  body: unknown;
}

function generateUid(): string {
  const chars = 'abcdef0123456789';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

class Store {
  people: Map<string, Person> = new Map();
  emailIndex: Map<string, string> = new Map();
  fields: CustomField[] = [];
  errorQueue: QueuedError[] = [];
  rateLimitCount: number = 0;
  rateLimitRetryAfterSeconds: number = 30;

  reset(): void {
    this.people.clear();
    this.emailIndex.clear();
    this.fields = [];
    this.errorQueue = [];
    this.rateLimitCount = 0;
    this.rateLimitRetryAfterSeconds = 30;
  }

  addPerson(data: {
    email: string;
    tags?: PersonTag[] | string[];
    notes?: string;
    extra_data?: Record<string, unknown>;
    [key: string]: unknown;
  }): Person {
    const uid = generateUid();
    const now = new Date().toISOString();
    const { email, tags, notes, extra_data, ...customFields } = data;

    const normalizedTags: PersonTag[] = tags
      ? tags.map((t) => (typeof t === 'string' ? { name: t } : (t as PersonTag)))
      : [];

    const person: Person = {
      uid,
      email,
      tags: normalizedTags,
      notes: notes ?? '',
      extra_data: extra_data ?? {},
      created: now,
      updated: now,
      ...customFields,
    };

    this.people.set(uid, person);
    this.emailIndex.set(email, uid);
    return person;
  }

  addPersonWithUid(person: Person): void {
    this.people.set(person.uid, person);
    this.emailIndex.set(person.email, person.uid);
  }

  getPerson(uid: string): Person | undefined {
    return this.people.get(uid);
  }

  getPersonByEmail(email: string): Person | undefined {
    const uid = this.emailIndex.get(email);
    if (!uid) return undefined;
    return this.people.get(uid);
  }

  updatePerson(
    email: string,
    data: {
      tags?: PersonTag[] | string[];
      notes?: string;
      extra_data?: Record<string, unknown>;
      [key: string]: unknown;
    },
  ): Person | undefined {
    const uid = this.emailIndex.get(email);
    if (!uid) return undefined;
    const person = this.people.get(uid);
    if (!person) return undefined;

    const { tags, notes, extra_data, ...customFields } = data;

    if (tags !== undefined) {
      person.tags = tags.map((t) => (typeof t === 'string' ? { name: t } : (t as PersonTag)));
    }
    if (notes !== undefined) {
      person.notes = notes;
    }
    if (extra_data !== undefined) {
      person.extra_data = extra_data;
    }

    // Apply custom fields
    for (const [key, value] of Object.entries(customFields)) {
      if (key !== 'email') {
        person[key] = value;
      }
    }

    person.updated = new Date().toISOString();
    return person;
  }

  deletePerson(email: string): boolean {
    const uid = this.emailIndex.get(email);
    if (!uid) return false;
    this.people.delete(uid);
    this.emailIndex.delete(email);
    return true;
  }

  listPeople(): Person[] {
    return Array.from(this.people.values());
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
