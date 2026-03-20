export interface PlanConnection {
  id: string;
  active: boolean;
  status: string;
  planId: string;
  planName: string;
  type: string;
  payment: string | null;
}

export interface Member {
  id: string;
  auth: { email: string };
  customFields: Record<string, string>;
  metaData: Record<string, unknown>;
  json: Record<string, unknown>;
  planConnections: PlanConnection[];
  loginRedirect: string;
  permissions: string[];
  verified: boolean;
  createdAt: string;
  lastLogin: string | null;
}

interface QueuedError {
  statusCode: number;
  body: unknown;
}

let memberCounter = 0;

function generateMemberId(): string {
  memberCounter++;
  const rand = Math.random().toString(36).substring(2, 10);
  return `mem_${rand}${memberCounter}`;
}

function generatePlanConnectionId(): string {
  const rand = Math.random().toString(36).substring(2, 10);
  return `plnc_${rand}`;
}

class Store {
  members: Map<string, Member> = new Map();
  emailIndex: Map<string, string> = new Map();
  errorQueue: QueuedError[] = [];
  rateLimitCount: number = 0;
  rateLimitRetryAfterSeconds: number = 30;

  reset(): void {
    this.members.clear();
    this.emailIndex.clear();
    this.errorQueue = [];
    this.rateLimitCount = 0;
    this.rateLimitRetryAfterSeconds = 30;
    memberCounter = 0;
  }

  addMember(data: {
    email: string;
    password?: string;
    plans?: { planId: string }[];
    customFields?: Record<string, string>;
    metaData?: Record<string, unknown>;
    json?: Record<string, unknown>;
    loginRedirect?: string;
  }): Member {
    const id = generateMemberId();
    const now = new Date().toISOString();

    // Check for duplicate email
    if (this.emailIndex.has(data.email)) {
      throw new MemberstackStoreError("A member with this email already exists", 400);
    }

    const planConnections: PlanConnection[] = (data.plans ?? []).map((p) => ({
      id: generatePlanConnectionId(),
      active: true,
      status: "active",
      planId: p.planId,
      planName: `Plan ${p.planId}`,
      type: "free",
      payment: null,
    }));

    const member: Member = {
      id,
      auth: { email: data.email },
      customFields: data.customFields ?? {},
      metaData: data.metaData ?? {},
      json: data.json ?? {},
      planConnections,
      loginRedirect: data.loginRedirect ?? "",
      permissions: [],
      verified: false,
      createdAt: now,
      lastLogin: null,
    };

    this.members.set(id, member);
    this.emailIndex.set(data.email, id);
    return member;
  }

  addMemberWithId(member: Member): void {
    this.members.set(member.id, member);
    this.emailIndex.set(member.auth.email, member.id);
  }

  getMember(id: string): Member | undefined {
    return this.members.get(id);
  }

  getMemberByEmail(email: string): Member | undefined {
    const id = this.emailIndex.get(email);
    if (!id) return undefined;
    return this.members.get(id);
  }

  getMemberByIdOrEmail(idOrEmail: string): Member | undefined {
    // Try by ID first
    const byId = this.members.get(idOrEmail);
    if (byId) return byId;
    // Then by email
    return this.getMemberByEmail(idOrEmail);
  }

  updateMember(
    id: string,
    data: {
      email?: string;
      customFields?: Record<string, string>;
      metaData?: Record<string, unknown>;
      json?: Record<string, unknown>;
      loginRedirect?: string;
    },
  ): Member | undefined {
    const member = this.members.get(id);
    if (!member) return undefined;

    if (data.email !== undefined && data.email !== member.auth.email) {
      // Check for duplicate email
      if (this.emailIndex.has(data.email)) {
        throw new MemberstackStoreError("A member with this email already exists", 400);
      }
      this.emailIndex.delete(member.auth.email);
      member.auth.email = data.email;
      this.emailIndex.set(data.email, id);
    }

    if (data.customFields !== undefined) {
      member.customFields = data.customFields;
    }
    if (data.metaData !== undefined) {
      member.metaData = data.metaData;
    }
    if (data.json !== undefined) {
      member.json = data.json;
    }
    if (data.loginRedirect !== undefined) {
      member.loginRedirect = data.loginRedirect;
    }

    return member;
  }

  deleteMember(id: string): boolean {
    const member = this.members.get(id);
    if (!member) return false;
    this.emailIndex.delete(member.auth.email);
    this.members.delete(id);
    return true;
  }

  addPlanToMember(memberId: string, planId: string): boolean {
    const member = this.members.get(memberId);
    if (!member) return false;

    // Don't add duplicate plans
    if (member.planConnections.some((p) => p.planId === planId)) {
      return true;
    }

    member.planConnections.push({
      id: generatePlanConnectionId(),
      active: true,
      status: "active",
      planId,
      planName: `Plan ${planId}`,
      type: "free",
      payment: null,
    });
    return true;
  }

  removePlanFromMember(memberId: string, planId: string): boolean {
    const member = this.members.get(memberId);
    if (!member) return false;
    member.planConnections = member.planConnections.filter(
      (p) => p.planId !== planId,
    );
    return true;
  }

  listMembers(): Member[] {
    return Array.from(this.members.values());
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

export class MemberstackStoreError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "MemberstackStoreError";
    this.statusCode = statusCode;
  }
}

export const store = new Store();
