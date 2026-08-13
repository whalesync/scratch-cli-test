/**
 * Linear connector type definitions.
 *
 * TypeScript interfaces for Linear GraphQL API entities.
 * API docs: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
 */

import { ConnectorAuthTokenOrProvider } from '../../connector-auth-token';

// ============= Credentials =============

/**
 * Credentials for the Linear API.
 */
export interface LinearCredentials {
  /**
   * Personal API key (a fixed string), or — for OAuth connections — a provider
   * that returns the connection's currently valid access token. OAuth passes a
   * provider so a job outliving the token's lifetime picks up the host's refresh
   * instead of 401-ing for the rest of the run (DEV-11270).
   */
  accessToken: ConnectorAuthTokenOrProvider;
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
