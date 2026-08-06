import axios, { AxiosInstance } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  GongCallExtensive,
  GongCallTranscript,
  GongLibraryFolder,
  GongListCallsExtensiveResponse,
  GongListLibraryFoldersResponse,
  GongListScorecardsResponse,
  GongListTranscriptsResponse,
  GongListUsersResponse,
  GongListWorkspacesResponse,
  GongScorecard,
  GongUser,
  GongWorkspace,
} from './gong-types';

export const GONG_DEFAULT_API_BASE_URL = 'https://api.gong.io';

/** Gong caps list pages at 100 records. */
const GONG_PAGE_SIZE = 100;

/**
 * The contentSelector sent with every POST /v2/calls/extensive request: expose
 * every analysis block Gong offers, so the stored record is the complete call
 * as the API can describe it. Blocks Gong hasn't computed yet (analysis is
 * async) are simply absent from the response and therefore from the record.
 */
const CALLS_EXTENSIVE_CONTENT_SELECTOR = {
  context: 'Extended',
  contextTiming: ['Now', 'TimeOfCall'],
  exposedFields: {
    parties: true,
    content: {
      structure: true,
      topics: true,
      trackers: true,
      trackerOccurrences: true,
      pointsOfInterest: true,
      brief: true,
      outline: true,
      highlights: true,
      keyPoints: true,
      callOutcome: true,
    },
    interaction: {
      speakers: true,
      video: true,
      personInteractionStats: true,
      questions: true,
    },
    collaboration: {
      publicComments: true,
    },
    media: true,
  },
} as const;

/**
 * Detect Gong's `429 Too Many Requests` (3 req/s, 10k req/day) and honour its
 * `Retry-After` header.
 */
const GONG_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => axios.isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!axios.isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/** Error thrown for Gong API failures, carrying the HTTP status and Gong's `errors` array. */
export class GongError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'GongError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Gong signals "no records matched" as HTTP 404 with an errors array like
 * ["No calls found corresponding to the provided filters"] — NOT as an empty
 * list. The transport treats that shape as an empty result, never an error.
 */
function isGongEmptyResultError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 404) return false;
  const errors_list_in_response_body = (error.response.data as { errors?: unknown[] } | undefined)?.errors;
  return (
    Array.isArray(errors_list_in_response_body) &&
    errors_list_in_response_body.some((entry) => typeof entry === 'string' && /No .* found/i.test(entry))
  );
}

/**
 * Low-level client for the Gong REST API (v2).
 *
 * Auth is HTTP Basic: access key as username, access key secret as password
 * (created in Gong Admin → API). The base URL is instance-specific
 * (e.g. https://us02-12345.api.gong.io); https://api.gong.io also resolves.
 *
 * Rate limits: 3 requests/second and 10,000 requests/day per company
 * (HTTP 429 + Retry-After beyond that). Every request runs through the shared
 * per-account rate limiter (when provided) plus a 429-aware retry.
 */
export class GongApiClient {
  private readonly client: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(accessKey: string, accessKeySecret: string, baseUrl?: string, opts?: { rateLimiter?: RateLimiter }) {
    this.rateLimiter = opts?.rateLimiter;
    this.client = createApiClient({
      baseURL: (baseUrl?.trim() || GONG_DEFAULT_API_BASE_URL).replace(/\/+$/, ''),
      auth: { username: accessKey, password: accessKeySecret },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
  }

  /** Every HTTP call goes through the shared limiter (3 req/s) + 429-aware retry. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, GONG_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, GONG_RETRY_OPTS);
  }

  /** Validate credentials with the cheapest authenticated read. */
  async validateCredentials(): Promise<void> {
    try {
      await this.withRetry(() => this.client.get('/v2/workspaces'));
    } catch (error) {
      if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
        throw new GongError('Invalid Gong access key or secret', error.response.status, error.response.data);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  async listWorkspaces(): Promise<GongWorkspace[]> {
    const response = await this.withRetry(() => this.client.get<GongListWorkspacesResponse>('/v2/workspaces'));
    return response.data.workspaces ?? [];
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  /** Yields pages of users; passes Gong's opaque cursor between pages. */
  async *listUsers(startCursor?: string): AsyncGenerator<{ items: GongUser[]; nextCursor: string | undefined }, void> {
    let cursor = startCursor;
    do {
      let response;
      try {
        response = await this.withRetry(() =>
          this.client.get<GongListUsersResponse>('/v2/users', {
            params: { limit: GONG_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          }),
        );
      } catch (error) {
        if (isGongEmptyResultError(error)) return;
        throw error;
      }
      const nextCursor = response.data.records?.cursor;
      yield { items: response.data.users ?? [], nextCursor };
      cursor = nextCursor;
    } while (cursor);
  }

  async getUser(id: string): Promise<GongUser | null> {
    try {
      const response = await this.withRetry(() =>
        this.client.get<{ user: GongUser }>(`/v2/users/${encodeURIComponent(id)}`),
      );
      return response.data.user ?? null;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return null;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Calls (extensive)
  // -------------------------------------------------------------------------

  /**
   * Yields pages of fully-hydrated call records for one workspace via
   * POST /v2/calls/extensive with every analysis block exposed.
   */
  async *listCallsExtensive(
    workspaceId: string,
    startCursor?: string,
  ): AsyncGenerator<{ items: GongCallExtensive[]; nextCursor: string | undefined }, void> {
    yield* this.pagedCallsPost<GongCallExtensive>('/v2/calls/extensive', workspaceId, startCursor, (data) => {
      return (data as GongListCallsExtensiveResponse).calls ?? [];
    });
  }

  /** Fetch specific calls by id (bulk — the filter accepts a callIds list). */
  async listCallsExtensiveByIds(callIds: string[]): Promise<GongCallExtensive[]> {
    const collected: GongCallExtensive[] = [];
    let cursor: string | undefined;
    do {
      let response;
      try {
        response = await this.withRetry(() =>
          this.client.post<GongListCallsExtensiveResponse>('/v2/calls/extensive', {
            ...(cursor ? { cursor } : {}),
            filter: { callIds },
            contentSelector: CALLS_EXTENSIVE_CONTENT_SELECTOR,
          }),
        );
      } catch (error) {
        if (isGongEmptyResultError(error)) return collected;
        throw error;
      }
      collected.push(...(response.data.calls ?? []));
      cursor = response.data.records?.cursor;
    } while (cursor);
    return collected;
  }

  // -------------------------------------------------------------------------
  // Transcripts
  // -------------------------------------------------------------------------

  /** Yields pages of call transcripts for one workspace via POST /v2/calls/transcript. */
  async *listCallTranscripts(
    workspaceId: string,
    startCursor?: string,
  ): AsyncGenerator<{ items: GongCallTranscript[]; nextCursor: string | undefined }, void> {
    yield* this.pagedCallsPost<GongCallTranscript>('/v2/calls/transcript', workspaceId, startCursor, (data) => {
      return (data as GongListTranscriptsResponse).callTranscripts ?? [];
    });
  }

  /** Fetch specific calls' transcripts by call id (bulk). */
  async listCallTranscriptsByCallIds(callIds: string[]): Promise<GongCallTranscript[]> {
    const collected: GongCallTranscript[] = [];
    let cursor: string | undefined;
    do {
      let response;
      try {
        response = await this.withRetry(() =>
          this.client.post<GongListTranscriptsResponse>('/v2/calls/transcript', {
            ...(cursor ? { cursor } : {}),
            filter: { callIds },
          }),
        );
      } catch (error) {
        if (isGongEmptyResultError(error)) return collected;
        throw error;
      }
      collected.push(...(response.data.callTranscripts ?? []));
      cursor = response.data.records?.cursor;
    } while (cursor);
    return collected;
  }

  // -------------------------------------------------------------------------
  // Library folders
  // -------------------------------------------------------------------------

  /** All library folders of one workspace (no pagination on this endpoint). */
  async listLibraryFolders(workspaceId: string): Promise<GongLibraryFolder[]> {
    try {
      const response = await this.withRetry(() =>
        this.client.get<GongListLibraryFoldersResponse>('/v2/library/folders', {
          params: { workspaceId },
        }),
      );
      return response.data.folders ?? [];
    } catch (error) {
      if (isGongEmptyResultError(error)) return [];
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Scorecards
  // -------------------------------------------------------------------------

  /**
   * All scorecard definitions of the company (no pagination, no workspace
   * param — callers filter by each scorecard's own workspaceId field).
   */
  async listScorecards(): Promise<GongScorecard[]> {
    try {
      const response = await this.withRetry(() =>
        this.client.get<GongListScorecardsResponse>('/v2/settings/scorecards'),
      );
      return response.data.scorecards ?? [];
    } catch (error) {
      if (isGongEmptyResultError(error)) return [];
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Shared pagination driver for the POST-with-filter call endpoints
  // -------------------------------------------------------------------------

  private async *pagedCallsPost<TItem>(
    path: '/v2/calls/extensive' | '/v2/calls/transcript',
    workspaceId: string,
    startCursor: string | undefined,
    extractItems: (responseData: unknown) => TItem[],
  ): AsyncGenerator<{ items: TItem[]; nextCursor: string | undefined }, void> {
    let cursor = startCursor;
    do {
      let response;
      try {
        response = await this.withRetry(() =>
          this.client.post(path, {
            ...(cursor ? { cursor } : {}),
            filter: { workspaceId },
            ...(path === '/v2/calls/extensive' ? { contentSelector: CALLS_EXTENSIVE_CONTENT_SELECTOR } : {}),
          }),
        );
      } catch (error) {
        if (isGongEmptyResultError(error)) return;
        throw error;
      }
      const envelope = (response.data as { records?: { cursor?: string } }).records;
      const nextCursor = envelope?.cursor;
      yield { items: extractItems(response.data), nextCursor };
      cursor = nextCursor;
    } while (cursor);
  }
}
