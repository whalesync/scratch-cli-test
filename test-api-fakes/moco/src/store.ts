export interface MocoCompany {
  id: number;
  name?: string;
  [key: string]: unknown;
  created_at: string;
  updated_at: string;
}

export interface MocoContact {
  id: number;
  firstname?: string;
  lastname?: string;
  [key: string]: unknown;
  created_at: string;
  updated_at: string;
}

export interface MocoProject {
  id: number;
  name?: string;
  [key: string]: unknown;
  created_at: string;
  updated_at: string;
}

interface QueuedError {
  statusCode: number;
  body: unknown;
}

class Store {
  companies: Map<number, MocoCompany> = new Map();
  contacts: Map<number, MocoContact> = new Map();
  projects: Map<number, MocoProject> = new Map();
  nextCompanyId: number = 1;
  nextContactId: number = 1;
  nextProjectId: number = 1;
  errorQueue: QueuedError[] = [];
  rateLimitCount: number = 0;
  rateLimitRetryAfterSeconds: number = 30;

  reset(): void {
    this.companies.clear();
    this.contacts.clear();
    this.projects.clear();
    this.nextCompanyId = 1;
    this.nextContactId = 1;
    this.nextProjectId = 1;
    this.errorQueue = [];
    this.rateLimitCount = 0;
    this.rateLimitRetryAfterSeconds = 30;
  }

  addCompany(data: Partial<MocoCompany>): MocoCompany {
    const id = data.id ?? this.nextCompanyId++;
    if (id >= this.nextCompanyId) {
      this.nextCompanyId = id + 1;
    }
    const now = new Date().toISOString();
    const company: MocoCompany = {
      ...data,
      id,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
    };
    this.companies.set(id, company);
    return company;
  }

  getCompany(id: number): MocoCompany | undefined {
    return this.companies.get(id);
  }

  updateCompany(
    id: number,
    data: Partial<MocoCompany>,
  ): MocoCompany | undefined {
    const company = this.companies.get(id);
    if (!company) return undefined;
    const updated: MocoCompany = {
      ...company,
      ...data,
      id,
      created_at: company.created_at,
      updated_at: new Date().toISOString(),
    };
    this.companies.set(id, updated);
    return updated;
  }

  deleteCompany(id: number): boolean {
    return this.companies.delete(id);
  }

  listCompanies(): MocoCompany[] {
    return Array.from(this.companies.values());
  }

  addContact(data: Partial<MocoContact>): MocoContact {
    const id = data.id ?? this.nextContactId++;
    if (id >= this.nextContactId) {
      this.nextContactId = id + 1;
    }
    const now = new Date().toISOString();
    const contact: MocoContact = {
      ...data,
      id,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
    };
    this.contacts.set(id, contact);
    return contact;
  }

  getContact(id: number): MocoContact | undefined {
    return this.contacts.get(id);
  }

  updateContact(
    id: number,
    data: Partial<MocoContact>,
  ): MocoContact | undefined {
    const contact = this.contacts.get(id);
    if (!contact) return undefined;
    const updated: MocoContact = {
      ...contact,
      ...data,
      id,
      created_at: contact.created_at,
      updated_at: new Date().toISOString(),
    };
    this.contacts.set(id, updated);
    return updated;
  }

  deleteContact(id: number): boolean {
    return this.contacts.delete(id);
  }

  listContacts(): MocoContact[] {
    return Array.from(this.contacts.values());
  }

  addProject(data: Partial<MocoProject>): MocoProject {
    const id = data.id ?? this.nextProjectId++;
    if (id >= this.nextProjectId) {
      this.nextProjectId = id + 1;
    }
    const now = new Date().toISOString();
    const project: MocoProject = {
      ...data,
      id,
      created_at: data.created_at ?? now,
      updated_at: data.updated_at ?? now,
    };
    this.projects.set(id, project);
    return project;
  }

  getProject(id: number): MocoProject | undefined {
    return this.projects.get(id);
  }

  updateProject(
    id: number,
    data: Partial<MocoProject>,
  ): MocoProject | undefined {
    const project = this.projects.get(id);
    if (!project) return undefined;
    const updated: MocoProject = {
      ...project,
      ...data,
      id,
      created_at: project.created_at,
      updated_at: new Date().toISOString(),
    };
    this.projects.set(id, updated);
    return updated;
  }

  deleteProject(id: number): boolean {
    return this.projects.delete(id);
  }

  listProjects(): MocoProject[] {
    return Array.from(this.projects.values());
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
