/**
 * Supabase Management API client.
 * Ported from Whalesync's supabase-api-client.ts — uses axios for HTTP requests.
 *
 * All endpoints authenticate with Bearer token from the Supabase OAuth flow.
 */
import { AxiosError, AxiosInstance } from 'axios';
import { withRetry, type WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import { SupabasePoolerConfig, SupabaseProject } from './supabase-types';

const SUPABASE_API_BASE = 'https://api.supabase.com/v1';

/**
 * Pulls the Postgres SQLSTATE out of the error text the Management API returns when a statement
 * sent to `/database/query` fails. That text is Postgres' own error line, e.g.
 * `ERROR:  42P07: relation "users" already exists` (the dashboard prefixes it with
 * `Failed to run sql query: `), optionally followed by LINE / DETAIL / HINT lines. Returns
 * undefined when there is no SQL error in it.
 */
export function parsePostgresSqlStateFromManagementApiErrorMessage(message: string): string | undefined {
  return /\b(?:ERROR|FATAL|PANIC):\s+([0-9A-Z]{5}):/.exec(message)?.[1];
}

/**
 * True when the Management API turned a request away for exceeding its rate limit (120 requests a
 * minute per project for our OAuth app). The request never reached the database, so retrying it
 * cannot apply a statement twice.
 */
export function isSupabaseManagementApiRateLimitError(error: unknown): boolean {
  return error instanceof SupabaseApiError && error.statusCode === 429;
}

/**
 * Retry policy for SQL sent through {@link SupabaseApiClient.executeQuery}. Live Export DDL spends
 * one request per table and per added field (DEV-12084), so a large export can run into the
 * per-minute limit; the backoff (2s, 4s, 8s, 16s, 32s, plus jitter) outlasts a full one-minute
 * window before giving up.
 */
export const SUPABASE_MANAGEMENT_API_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: isSupabaseManagementApiRateLimitError,
  initialRetryDelayMs: 2_000,
  maxRetries: 5,
};

export class SupabaseApiClient {
  private readonly client: AxiosInstance;

  constructor(accessToken: string) {
    this.client = createApiClient({
      baseURL: SUPABASE_API_BASE,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });
  }

  /**
   * List all Supabase projects accessible to the authenticated user.
   * GET /v1/projects
   */
  async getProjects(): Promise<SupabaseProject[]> {
    const response = await this.get<SupabaseProject[]>('/projects');
    return response;
  }

  /**
   * Get the connection pooler (Supavisor) configuration for a project.
   * GET /v1/projects/{ref}/config/database/pooler
   */
  async getPoolerConfig(projectRef: string): Promise<SupabasePoolerConfig[]> {
    const response = await this.get<SupabasePoolerConfig[]>(`/projects/${projectRef}/config/database/pooler`);
    return response;
  }

  /**
   * Execute a raw SQL query on the project's database via the Management API.
   * POST /v1/projects/{ref}/database/query
   *
   * This runs as the project's `postgres` role, so it can create roles, grant
   * permissions, and execute DDL that the service account cannot. On Supabase
   * that role is the project's admin but not a true superuser: it can still be
   * refused on objects another role owns.
   *
   * A failed statement surfaces as a {@link SupabaseApiError} carrying the
   * Postgres SQLSTATE in `code`. A rate-limited request (429) is retried with
   * backoff ({@link SUPABASE_MANAGEMENT_API_RETRY_OPTS}).
   */
  async executeQuery(projectRef: string, query: string): Promise<unknown> {
    const path = `/projects/${projectRef}/database/query`;
    return withRetry(async () => {
      try {
        const response = await this.client.post<unknown>(path, { query }, { timeout: 30_000 });
        return response.data;
      } catch (error) {
        throw this.wrapError(error, path);
      }
    }, SUPABASE_MANAGEMENT_API_RETRY_OPTS);
  }

  /**
   * Run a read-only SQL statement through {@link executeQuery} and return its
   * result rows. This is how a project that has no Scratch database role yet is
   * browsed — see {@link SupabaseManagementApiCatalogReader}.
   *
   * The endpoint answers with the statement's rows as a JSON array; anything
   * else (an empty body from a statement that returns nothing) yields [].
   */
  async runSqlQuery<TRow>(projectRef: string, query: string): Promise<TRow[]> {
    const result = await this.executeQuery(projectRef, query);
    return Array.isArray(result) ? (result as TRow[]) : [];
  }

  private async get<T>(path: string): Promise<T> {
    try {
      const response = await this.client.get<T>(path);
      return response.data;
    } catch (error) {
      throw this.wrapError(error, path);
    }
  }

  private wrapError(error: unknown, path: string): Error {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const data: unknown = error.response?.data;
      const message = extractErrorBodyMessage(data) ?? error.message;

      if (status === 401) {
        return new SupabaseApiError(`Supabase authorization failed. Please reconnect your account.`, status);
      }
      if (status === 403) {
        return new SupabaseApiError(`Insufficient permissions for Supabase API (${path}).`, status);
      }
      return new SupabaseApiError(
        `Supabase API error (${status ?? 'unknown'}): ${message}`,
        status,
        parsePostgresSqlStateFromManagementApiErrorMessage(message),
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * The human-readable text of an error response body. The Management API answers with `{ message }`;
 * a SQL failure can instead come back as `{ error: "<Postgres error text>" }`.
 */
function extractErrorBodyMessage(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  if ('message' in data) {
    return String((data as { message: unknown }).message);
  }
  if ('error' in data && typeof (data as { error: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  return undefined;
}

export class SupabaseApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    /**
     * The Postgres SQLSTATE (e.g. `42P07`, `42501`) of a statement that failed inside
     * `/database/query`, so the shared `isDuplicateTableError` / `isInsufficientPrivilegeError`
     * checks recognize it exactly as they recognize a `pg` driver error.
     */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'SupabaseApiError';
  }
}
