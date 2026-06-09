import axios, { AxiosInstance, isAxiosError, RawAxiosRequestHeaders } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  CLICKUP_BASE_URL,
  CLICKUP_BASE_URL_V3,
  CLICKUP_TASK_PAGE_SIZE,
  ClickUpCredentials,
  ClickUpCustomFieldDefinition,
  ClickUpDoc,
  ClickUpFolder,
  ClickUpList,
  ClickUpSpace,
  ClickUpTeam,
} from './clickup-types';

const LOG_SOURCE = 'ClickUpApiClient';

/** Parse a numeric header value (string or number); undefined for anything else. */
function parseHeaderSeconds(raw: unknown): number | undefined {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const seconds = parseInt(raw, 10);
    return isNaN(seconds) ? undefined : seconds;
  }
  return undefined;
}

/**
 * Detect ClickUp's `429 Too Many Requests` and honour the reset hint. ClickUp
 * returns `X-RateLimit-Reset` as an epoch-seconds timestamp of when the window
 * resets; fall back to `Retry-After` (delta seconds) if present.
 */
const CLICKUP_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    const headers = error.response?.headers ?? {};

    const retryAfter = parseHeaderSeconds(headers['retry-after']);
    if (retryAfter !== undefined && retryAfter > 0) return retryAfter;

    const resetEpochSeconds = parseHeaderSeconds(headers['x-ratelimit-reset']);
    if (resetEpochSeconds !== undefined) {
      const deltaSeconds = resetEpochSeconds - Math.floor(Date.now() / 1000);
      if (deltaSeconds > 0) return Math.min(deltaSeconds, 60);
    }
    return undefined;
  },
};

/** Custom error class for ClickUp API errors. */
export class ClickUpError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'ClickUpError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the ClickUp v2 REST API.
 *
 * Auth is a personal API token sent verbatim in the `Authorization` header (no
 * `Bearer` prefix). Tables are discovered by walking Workspace → Space →
 * (Folder →) List; records are a list's tasks, paged 100 at a time.
 */
export class ClickUpApiClient {
  private readonly client: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(credentials: ClickUpCredentials, opts?: { rateLimiter?: RateLimiter }) {
    this.rateLimiter = opts?.rateLimiter;

    const headers: RawAxiosRequestHeaders = {
      Authorization: credentials.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    this.client = createApiClient({ baseURL: CLICKUP_BASE_URL, headers });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, CLICKUP_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, CLICKUP_RETRY_OPTS);
  }

  // --- Connection test ---

  /** Validate credentials with the lightest authenticated call. Throws on 401. */
  async testConnection(): Promise<void> {
    try {
      await this.withRetry(() => this.client.get('/user'));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 401) {
        throw new ClickUpError('Invalid ClickUp API token', 401, error.response?.data);
      }
      throw error;
    }
  }

  // --- Hierarchy walk (table discovery) ---

  /** List the workspaces (ClickUp calls them "teams") the token can access. */
  async listTeams(): Promise<ClickUpTeam[]> {
    const response = await this.withRetry(() => this.client.get<{ teams?: ClickUpTeam[] }>('/team'));
    return response.data.teams ?? [];
  }

  /** List the spaces in a workspace (excludes archived). */
  async listSpaces(teamId: string): Promise<ClickUpSpace[]> {
    const response = await this.withRetry(() =>
      this.client.get<{ spaces?: ClickUpSpace[] }>(`/team/${teamId}/space`, { params: { archived: false } }),
    );
    return response.data.spaces ?? [];
  }

  /** List the folders in a space; each folder carries its lists inline. */
  async listFolders(spaceId: string): Promise<ClickUpFolder[]> {
    const response = await this.withRetry(() =>
      this.client.get<{ folders?: ClickUpFolder[] }>(`/space/${spaceId}/folder`, { params: { archived: false } }),
    );
    return response.data.folders ?? [];
  }

  /** List the folderless lists in a space (lists that live directly under the space). */
  async listFolderlessLists(spaceId: string): Promise<ClickUpList[]> {
    const response = await this.withRetry(() =>
      this.client.get<{ lists?: ClickUpList[] }>(`/space/${spaceId}/list`, { params: { archived: false } }),
    );
    return response.data.lists ?? [];
  }

  /** Fetch a single list (used to resolve its display name in `fetchJsonTableSpec`). */
  async getList(listId: string): Promise<ClickUpList | null> {
    try {
      const response = await this.withRetry(() => this.client.get<ClickUpList>(`/list/${listId}`));
      return response.data ?? null;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // --- Schema (custom fields) ---

  /** Fetch the custom field definitions accessible on a list (drives the dynamic schema). */
  async listCustomFields(listId: string): Promise<ClickUpCustomFieldDefinition[]> {
    const response = await this.withRetry(() =>
      this.client.get<{ fields?: ClickUpCustomFieldDefinition[] }>(`/list/${listId}/field`),
    );
    return response.data.fields ?? [];
  }

  // --- Docs (v3 API — separate codepath) ---

  /**
   * List all docs in a workspace via the **v3** API (different base + shape than
   * the v2 task/list endpoints). Cursor-paginated; returns docs verbatim.
   */
  async listDocs(teamId: string): Promise<ClickUpDoc[]> {
    const docs: ClickUpDoc[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.withRetry(() =>
        this.client.get<{ docs?: ClickUpDoc[]; next_cursor?: string | null }>(
          `${CLICKUP_BASE_URL_V3}/workspaces/${teamId}/docs`,
          { params: { limit: 50, ...(cursor ? { next_cursor: cursor } : {}) } },
        ),
      );
      if (Array.isArray(response.data.docs)) docs.push(...response.data.docs);
      cursor = response.data.next_cursor ?? undefined;
    } while (cursor);
    return docs;
  }

  // --- Listing tasks (page-based) ---

  /**
   * Fetch one page of a list's tasks. Includes subtasks and closed tasks so a
   * full pull captures everything; `last_page` tells the caller when to stop.
   */
  async listTasksPage(listId: string, page: number): Promise<{ tasks: Record<string, unknown>[]; lastPage: boolean }> {
    const response = await this.withRetry(() =>
      this.client.get<{ tasks?: Record<string, unknown>[]; last_page?: boolean }>(`/list/${listId}/task`, {
        params: { page, subtasks: true, include_closed: true, archived: false },
      }),
    );
    const tasks = Array.isArray(response.data.tasks) ? response.data.tasks : [];
    // ClickUp omits `last_page` on some responses; a short page also signals the end.
    const lastPage = response.data.last_page === true || tasks.length < CLICKUP_TASK_PAGE_SIZE;
    return { tasks, lastPage };
  }

  // --- Single task fetch ---

  /** Get one task by id. Returns null on 404 (already deleted). */
  async getTask(taskId: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.withRetry(() => this.client.get<Record<string, unknown>>(`/task/${taskId}`));
      return response.data ?? null;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // --- Create / Update / Delete ---

  /** Create a task in a list. Returns ClickUp's response (includes the assigned id). */
  async createTask(listId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.withRetry(() =>
      this.client.post<Record<string, unknown>>(`/list/${listId}/task`, body),
    );
    return response.data ?? {};
  }

  /** Update a task. ClickUp applies only the fields present in the body. */
  async updateTask(taskId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.withRetry(() => this.client.put<Record<string, unknown>>(`/task/${taskId}`, body));
    return response.data ?? {};
  }

  /** Delete a task. Ignores 404 (already deleted). */
  async deleteTask(taskId: string): Promise<void> {
    try {
      await this.withRetry(() => this.client.delete(`/task/${taskId}`));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        WSLogger.warn({ source: LOG_SOURCE, message: `Task ${taskId} not found (404) during delete, ignoring` });
        return;
      }
      throw error;
    }
  }

  /** Set a single custom field's value on a task (`POST /task/{id}/field/{field_id}`). */
  async setCustomFieldValue(taskId: string, fieldId: string, value: unknown): Promise<void> {
    await this.withRetry(() => this.client.post(`/task/${taskId}/field/${fieldId}`, { value }));
  }
}

/** True when the error is an Axios error from ClickUp (used by error extraction). */
export function isClickUpAxiosError(error: unknown): boolean {
  return axios.isAxiosError(error);
}
