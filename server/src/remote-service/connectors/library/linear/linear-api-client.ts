/**
 * Linear GraphQL API Client
 *
 * Low-level client for the Linear GraphQL API using axios.
 *
 * API docs: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
 */

import { AxiosInstance, isAxiosError } from 'axios';
import { RateLimiter, WithRetryOpts, withRetry as standaloneWithRetry } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
// Generated query fields
import { CYCLES_QUERY_FIELDS } from './graphql/schemas/cycles.schema';
import { ISSUES_QUERY_FIELDS } from './graphql/schemas/issues.schema';
import { LABELS_QUERY_FIELDS } from './graphql/schemas/labels.schema';
import { PROJECTS_QUERY_FIELDS } from './graphql/schemas/projects.schema';
import { TEAMS_QUERY_FIELDS } from './graphql/schemas/teams.schema';
import { USERS_QUERY_FIELDS } from './graphql/schemas/users.schema';
// Generated mutations
import {
  ISSUES_CREATE_MUTATION,
  ISSUES_DELETE_MUTATION,
  ISSUES_UPDATE_MUTATION,
} from './graphql/mutations/issues.mutations';
import {
  PROJECTS_CREATE_MUTATION,
  PROJECTS_DELETE_MUTATION,
  PROJECTS_UPDATE_MUTATION,
} from './graphql/mutations/projects.mutations';
// Generated entity registry
import { ENTITY_REGISTRY, type EntityType } from './graphql';
import { LinearConnection, LinearCredentials, LinearGraphQLResponse } from './linear-types';

const LINEAR_API_URL = 'https://api.linear.app/graphql';

const LINEAR_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) =>
    error instanceof LinearError && (error.statusCode === 429 || error.message.toLowerCase().includes('rate limit')),
  maxRetryDelayMs: 30_000,
};

/**
 * Query fields mapping from entity type to generated query field strings.
 */
const QUERY_FIELDS_MAP: Record<EntityType, string> = {
  issues: ISSUES_QUERY_FIELDS,
  projects: PROJECTS_QUERY_FIELDS,
  teams: TEAMS_QUERY_FIELDS,
  users: USERS_QUERY_FIELDS,
  labels: LABELS_QUERY_FIELDS,
  cycles: CYCLES_QUERY_FIELDS,
};

/**
 * Root field names for list queries (plural connection fields).
 */
const ROOT_FIELD_MAP: Record<EntityType, string> = {
  issues: 'issues',
  projects: 'projects',
  teams: 'teams',
  users: 'users',
  labels: 'issueLabels',
  cycles: 'cycles',
};

/**
 * Linear GraphQL filter input type names per entity type. Each list connection
 * accepts a typed `filter` argument of this input type, and every one of these
 * inputs exposes an `updatedAt: DateComparator` comparator (verified against
 * `@linear/sdk`'s generated documents). Used to declare the `$filter` variable
 * type when an incremental filter is supplied to {@link listEntities}.
 */
const FILTER_TYPE_MAP: Record<EntityType, string> = {
  issues: 'IssueFilter',
  projects: 'ProjectFilter',
  teams: 'TeamFilter',
  users: 'UserFilter',
  labels: 'IssueLabelFilter',
  cycles: 'CycleFilter',
};

/**
 * Singular root field names for single-node queries.
 */
const SINGULAR_FIELD_MAP: Record<EntityType, string> = {
  issues: 'issue',
  projects: 'project',
  teams: 'team',
  users: 'user',
  labels: 'issueLabel',
  cycles: 'cycle',
};

/**
 * Linear API error
 */
export class LinearError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'LinearError';
  }
}

/**
 * Linear GraphQL API client.
 */
export class LinearApiClient {
  private readonly client: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(credentials: LinearCredentials, opts?: { rateLimiter?: RateLimiter }) {
    this.rateLimiter = opts?.rateLimiter;

    this.client = createApiClient({
      baseURL: LINEAR_API_URL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: credentials.accessToken,
      },
    });
  }

  // ============= Core GraphQL Execution =============

  /**
   * Execute a GraphQL query/mutation with automatic retry on rate limiting.
   */
  private async query<T>(queryString: string, variables?: Record<string, unknown>): Promise<T> {
    const fn = () => this.executeQuery<T>(queryString, variables);
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, LINEAR_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, LINEAR_RETRY_OPTS);
  }

  /**
   * Execute a single GraphQL query/mutation (no retry).
   */
  private async executeQuery<T>(queryString: string, variables?: Record<string, unknown>): Promise<T> {
    let response;
    try {
      response = await this.client.post<LinearGraphQLResponse<T>>('', {
        query: queryString,
        variables,
      });
    } catch (error) {
      // Extract GraphQL error details from HTTP error responses (e.g. 400)
      if (isAxiosError(error) && error.response?.data) {
        const body = error.response.data as LinearGraphQLResponse<T>;
        if (body.errors && body.errors.length > 0) {
          const gqlError = body.errors[0];
          const code = gqlError.extensions?.code as string | undefined;
          throw new LinearError(gqlError.message, error.response.status, code);
        }
      }
      throw error;
    }

    const result = response.data;

    if (result.errors && result.errors.length > 0) {
      const error = result.errors[0];
      const code = error.extensions?.code as string | undefined;
      throw new LinearError(error.message, 400, code);
    }

    if (!result.data) {
      throw new LinearError('No data returned from Linear API', 500);
    }

    return result.data;
  }

  // ============= Connection Validation =============

  /**
   * Validate credentials by querying the viewer (current user).
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.query<{ viewer: { id: string; name: string } }>(`
        query { viewer { id name } }
      `);
    } catch (error) {
      if (error instanceof LinearError && (error.statusCode === 401 || error.statusCode === 403)) {
        throw new LinearError('Invalid Linear credentials', 401, 'UNAUTHORIZED');
      }
      throw error;
    }
  }

  // ============= Generic List Methods =============

  /**
   * List entities by type using cursor-based pagination.
   *
   * When `filter` is supplied (incremental pull), the query declares a typed
   * `$filter` variable of the entity's Linear filter input type and passes it
   * to the root connection. When omitted, the query is emitted unchanged — a
   * full scan with zero behavior change.
   */
  async *listEntities(
    entityType: EntityType,
    pageSize = 50,
    resumeCursor?: string,
    filter?: Record<string, unknown>,
  ): AsyncGenerator<{ nodes: Record<string, unknown>[]; endCursor: string | null }, void> {
    const queryFields = QUERY_FIELDS_MAP[entityType];
    const rootField = ROOT_FIELD_MAP[entityType];

    const filterType = filter ? FILTER_TYPE_MAP[entityType] : undefined;
    const varDecls = filterType
      ? `$first: Int!, $after: String, $filter: ${filterType}`
      : `$first: Int!, $after: String`;
    const rootArgs = filterType ? `first: $first, after: $after, filter: $filter` : `first: $first, after: $after`;

    const queryString = `
      query List${capitalize(rootField)}(${varDecls}) {
        ${rootField}(${rootArgs}) {
          nodes { ${queryFields} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    yield* this.paginatedList(queryString, rootField, pageSize, resumeCursor, filterType ? { filter } : undefined);
  }

  /**
   * Generic paginated list generator using Relay-style cursor pagination.
   * `extraVariables` are merged into the GraphQL variables on every page (used
   * to pass a stable `filter` across all pages of an incremental pull).
   */
  private async *paginatedList<T>(
    queryString: string,
    rootField: string,
    pageSize: number,
    resumeCursor?: string,
    extraVariables?: Record<string, unknown>,
  ): AsyncGenerator<{ nodes: T[]; endCursor: string | null }, void> {
    let cursor: string | null = resumeCursor ?? null;
    let hasMore = true;

    while (hasMore) {
      type ResponseType = Record<string, LinearConnection<T>>;
      const response: ResponseType = await this.query<ResponseType>(queryString, {
        first: pageSize,
        after: cursor,
        ...extraVariables,
      });

      const connection: LinearConnection<T> | undefined = response[rootField];
      if (!connection || connection.nodes.length === 0) break;

      hasMore = connection.pageInfo.hasNextPage;
      cursor = connection.pageInfo.endCursor;

      yield { nodes: connection.nodes, endCursor: cursor };
    }
  }

  // ============= Node Fetching =============

  /**
   * Fetch a single entity by ID.
   */
  async fetchNodeById(entityType: EntityType, id: string): Promise<Record<string, unknown> | null> {
    const config = ENTITY_REGISTRY[entityType];
    const queryFields = QUERY_FIELDS_MAP[entityType];
    const singularField = SINGULAR_FIELD_MAP[entityType];

    const queryString = `
      query Fetch${config.graphqlType}($id: String!) {
        ${singularField}(id: $id) {
          ${queryFields}
        }
      }
    `;

    try {
      const data = await this.query<Record<string, Record<string, unknown> | null>>(queryString, { id });
      return data[singularField] ?? null;
    } catch (error) {
      if (error instanceof LinearError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  // ============= CRUD Operations =============

  /**
   * Create an issue.
   */
  async createIssue(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await this.query<{
      issueCreate: { success: boolean; issue: Record<string, unknown> | null };
    }>(ISSUES_CREATE_MUTATION, { input });

    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new LinearError('Failed to create issue', 500);
    }

    return data.issueCreate.issue;
  }

  /**
   * Update an issue.
   */
  async updateIssue(id: string, input: Record<string, unknown>): Promise<void> {
    const data = await this.query<{
      issueUpdate: { success: boolean };
    }>(ISSUES_UPDATE_MUTATION, { id, input });

    if (!data.issueUpdate.success) {
      throw new LinearError('Failed to update issue', 500);
    }
  }

  /**
   * Delete an issue.
   */
  async deleteIssue(id: string): Promise<void> {
    const data = await this.query<{
      issueDelete: { success: boolean };
    }>(ISSUES_DELETE_MUTATION, { id });

    if (!data.issueDelete.success) {
      throw new LinearError('Failed to delete issue', 500);
    }
  }

  /**
   * Create a project.
   */
  async createProject(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await this.query<{
      projectCreate: { success: boolean; project: Record<string, unknown> | null };
    }>(PROJECTS_CREATE_MUTATION, { input });

    if (!data.projectCreate.success || !data.projectCreate.project) {
      throw new LinearError('Failed to create project', 500);
    }

    return data.projectCreate.project;
  }

  /**
   * Update a project.
   */
  async updateProject(id: string, input: Record<string, unknown>): Promise<void> {
    const data = await this.query<{
      projectUpdate: { success: boolean };
    }>(PROJECTS_UPDATE_MUTATION, { id, input });

    if (!data.projectUpdate.success) {
      throw new LinearError('Failed to update project', 500);
    }
  }

  /**
   * Delete a project.
   */
  async deleteProject(id: string): Promise<void> {
    const data = await this.query<{
      projectDelete: { success: boolean };
    }>(PROJECTS_DELETE_MUTATION, { id });

    if (!data.projectDelete.success) {
      throw new LinearError('Failed to delete project', 500);
    }
  }
}

// ============= Utilities =============

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
