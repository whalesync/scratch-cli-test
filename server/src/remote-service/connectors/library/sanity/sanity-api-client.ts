import { AxiosInstance, isAxiosError, RawAxiosRequestHeaders } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  SanityDataset,
  SanityDeployedSchemaDocument,
  SanityDocument,
  SanityErrorResponseBody,
  SanityMutation,
  SanityMutationResponse,
  SanityProject,
  SanityQueryResponse,
} from './sanity-types';

/**
 * The Content Lake API version every data request is pinned to. Sanity versions its
 * HTTP API by date in the URL path (`/v2025-02-19/data/...`). v2025-02-19 is the
 * version where the default query perspective became `published`; we still pass
 * `perspective=published` explicitly on every query so pulls never depend on a default.
 */
export const SANITY_DATA_API_VERSION = 'v2025-02-19';

/** The management API (projects/datasets) is versioned independently of the data API. */
const SANITY_MANAGEMENT_API_BASE_URL = 'https://api.sanity.io/v2021-06-07';

/**
 * We pull only published documents. Draft documents coexist in the dataset under
 * `drafts.<id>` ids; pulling them (perspective `raw` or `drafts`) is a possible
 * future connection option — see STATE.md.
 */
const SANITY_QUERY_PERSPECTIVE = 'published';

export class SanityError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'SanityError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

const SANITY_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/**
 * Low-level client for the Sanity HTTP APIs, authenticated with a robot token
 * (`Authorization: Bearer <token>`).
 *
 * Two hosts are involved: the management API at `api.sanity.io` (projects, datasets)
 * and the per-project data API at `{projectId}.api.sanity.io` (GROQ queries, mutations).
 */
export class SanityApiClient {
  private readonly managementClient: AxiosInstance;
  private readonly dataClientsByProjectId = new Map<string, AxiosInstance>();
  private readonly authHeaders: RawAxiosRequestHeaders;
  private readonly rateLimiter?: RateLimiter;

  constructor(apiToken: string, opts?: { rateLimiter?: RateLimiter }) {
    this.authHeaders = {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    this.managementClient = createApiClient({
      baseURL: SANITY_MANAGEMENT_API_BASE_URL,
      headers: this.authHeaders,
    });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, SANITY_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, SANITY_RETRY_OPTS);
  }

  private dataClientForProject(projectId: string): AxiosInstance {
    const existingClient = this.dataClientsByProjectId.get(projectId);
    if (existingClient) return existingClient;
    const newClient = createApiClient({
      baseURL: `https://${projectId}.api.sanity.io/${SANITY_DATA_API_VERSION}`,
      headers: this.authHeaders,
    });
    this.dataClientsByProjectId.set(projectId, newClient);
    return newClient;
  }

  /**
   * List the projects the token can access. A robot token is project-scoped, so this
   * normally returns exactly one project — which is how the connector auto-discovers
   * the project id from the token alone.
   */
  async listProjects(): Promise<SanityProject[]> {
    const response = await this.withRetry(() => this.managementClient.get<SanityProject[]>('/projects'));
    return response.data;
  }

  /** List the datasets in a project (e.g. `production`, `staging`). */
  async listDatasets(projectId: string): Promise<SanityDataset[]> {
    const response = await this.withRetry(() =>
      this.managementClient.get<SanityDataset[]>(`/projects/${projectId}/datasets`),
    );
    return response.data;
  }

  /**
   * Run a GROQ query against a dataset and return the raw `result`.
   *
   * Uses POST (the query rides in the body) so query length never hits URL limits.
   * Always queries the `published` perspective — see SANITY_QUERY_PERSPECTIVE.
   */
  async query<TResult>(
    projectId: string,
    datasetName: string,
    groqQuery: string,
    groqParams?: Record<string, unknown>,
  ): Promise<TResult> {
    const response = await this.withRetry(() =>
      this.dataClientForProject(projectId).post<SanityQueryResponse<TResult>>(
        `/data/query/${datasetName}?perspective=${SANITY_QUERY_PERSPECTIVE}`,
        { query: groqQuery, params: groqParams ?? {} },
      ),
    );
    return response.data.result;
  }

  /**
   * Apply a transaction of mutations to a dataset. With `returnDocuments: true` the
   * response carries each affected document as the service stored it.
   */
  async mutate(
    projectId: string,
    datasetName: string,
    mutations: SanityMutation[],
    opts?: { returnDocuments?: boolean },
  ): Promise<SanityMutationResponse> {
    const returnDocumentsFlag = opts?.returnDocuments ? 'true' : 'false';
    const response = await this.withRetry(() =>
      this.dataClientForProject(projectId).post<SanityMutationResponse>(
        `/data/mutate/${datasetName}?returnDocuments=${returnDocumentsFlag}`,
        { mutations },
      ),
    );
    return response.data;
  }

  /**
   * Extract the human-readable message from a Sanity error response body, if the
   * given error is an axios error carrying one.
   */
  static extractSanityErrorDescription(error: unknown): string | undefined {
    if (!isAxiosError(error)) return undefined;
    const body = error.response?.data as SanityErrorResponseBody | undefined;
    return body?.error?.description ?? body?.message;
  }

  /**
   * Fetch the deployed Studio schema system documents (`sanity schema deploy` stores one
   * per Studio workspace, id `_.schemas.<workspaceName>`). Returns `[]` when the project
   * never deployed a schema.
   *
   * Fetch mechanism (probed live 2026-07-31 against project hkcx2dra): a GROQ path
   * query `*[_id in path("_.schemas.**")]` returns system documents even at
   * `perspective=published`, so the ordinary query pipeline works. (A `_type`-scoped
   * query also works but the live `_type` is `"system.schema"`, not the documented
   * `"sanity.workspace.schema"` — the id path is the stable contract. The doc endpoint
   * `GET /data/doc/{dataset}/{id}` works too but needs the workspace name up front.)
   */
  async fetchDeployedWorkspaceSchemaDocuments(
    projectId: string,
    datasetName: string,
  ): Promise<SanityDeployedSchemaDocument[]> {
    return this.query<SanityDeployedSchemaDocument[]>(projectId, datasetName, '*[_id in path("_.schemas.**")]');
  }

  /**
   * Fetch documents of one type in stable `_id` order, for cursor pagination.
   * `modifiedSinceIso` (incremental pulls) ANDs a server-side `_updatedAt` cutoff
   * into the filter so unchanged documents are never fetched.
   */
  async fetchDocumentsPageOrderedById(
    projectId: string,
    datasetName: string,
    typeName: string,
    afterDocumentId: string,
    pageSize: number,
    modifiedSinceIso?: string,
  ): Promise<SanityDocument[]> {
    const modifiedSinceClause = modifiedSinceIso ? ' && dateTime(_updatedAt) >= dateTime($since)' : '';
    // Slice bounds can't be GROQ params, so the (integer) page size is inlined.
    const groqQuery = `*[_type == $type && _id > $afterId${modifiedSinceClause}] | order(_id asc) [0...${pageSize}]`;
    return this.query<SanityDocument[]>(projectId, datasetName, groqQuery, {
      type: typeName,
      afterId: afterDocumentId,
      ...(modifiedSinceIso ? { since: modifiedSinceIso } : {}),
    });
  }
}
