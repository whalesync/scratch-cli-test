/**
 * Linear connector type definitions.
 *
 * TypeScript interfaces for Linear GraphQL API entities.
 * API docs: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
 */

// ============= Credentials =============

/**
 * Credentials for the Linear API.
 */
export interface LinearCredentials {
  /** OAuth access token or Personal API key */
  accessToken: string;
}

// ============= GraphQL Infrastructure =============

/**
 * GraphQL pagination info (Relay-style cursor pagination).
 */
export interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Generic GraphQL connection type for paginated results.
 */
export interface LinearConnection<T> {
  nodes: T[];
  pageInfo: LinearPageInfo;
}

/**
 * Generic GraphQL response wrapper.
 */
export interface LinearGraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;
}
