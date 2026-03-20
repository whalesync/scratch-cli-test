/**
 * Types for the Memberstack Admin API.
 *
 * Memberstack is a membership/authentication platform.
 * The Admin API exposes a single "Members" entity with cursor-based pagination.
 *
 * API Documentation: https://developers.memberstack.com/admin-rest-api/member-actions
 */

/**
 * A plan connection on a Memberstack member.
 */
export interface MemberstackPlanConnection {
  id: string;
  active: boolean;
  status?: string;
  planId: string;
  planName?: string;
  type: string;
  payment?: string | null;
}

/**
 * A member record from the Memberstack API.
 */
export interface MemberstackMember {
  id: string;
  auth: { email: string };
  customFields: Record<string, string>;
  metaData: Record<string, unknown>;
  json: Record<string, unknown>;
  planConnections: MemberstackPlanConnection[];
  loginRedirect: string;
  permissions: string[];
  verified?: boolean;
  createdAt: string;
  lastLogin?: string;
}

/**
 * Paginated response from Memberstack list members endpoint.
 */
export interface MemberstackPaginatedResponse {
  totalCount: number;
  endCursor: string | null;
  hasNextPage: boolean;
  data: MemberstackMember[];
}

/**
 * Request body for creating a member.
 */
export interface MemberstackCreateMemberRequest {
  email: string;
  password: string;
  plans?: { planId: string }[];
  customFields?: Record<string, string>;
  metaData?: Record<string, unknown>;
  json?: Record<string, unknown>;
  loginRedirect?: string;
}

/**
 * Request body for updating a member.
 */
export interface MemberstackUpdateMemberRequest {
  email?: string;
  customFields?: Record<string, string>;
  metaData?: Record<string, unknown>;
  json?: Record<string, unknown>;
  loginRedirect?: string;
}

/**
 * Request body for deleting a member.
 */
export interface MemberstackDeleteMemberRequest {
  deleteStripeCustomer?: boolean;
  cancelStripeSubscriptions?: boolean;
}
