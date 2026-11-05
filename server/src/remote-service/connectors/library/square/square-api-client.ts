import axios, { AxiosInstance } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { assertUnreachable } from 'src/utils/asserts';
import { ConnectorAuthTokenOrProvider, toConnectorAuthTokenProvider } from '../../connector-auth-token';
import { createApiClient } from '../../create-api-client';
import {
  SQUARE_ALL_ORDER_STATES,
  SQUARE_API_BASE_URL_BY_ENVIRONMENT,
  SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE,
  SQUARE_ORDERS_SEARCH_MAX_LOCATION_IDS,
  SquareApiErrorEntry,
  SquareCredentials,
  SquareEntityConfig,
  SquareEntityType,
  SquareEnvironment,
  SquarePullProgress,
} from './square-types';

/**
 * The Square API version this connector is pinned to, sent as `Square-Version` on every request.
 *
 * Without a pin, Square serves the version the *application* defaults to in the Developer
 * Dashboard, so the payload shape would differ per app and shift whenever someone bumps that
 * setting. It must equal the version `square-entity-schemas.generated.ts` was generated from —
 * bump both together by re-running `server/scripts/generate-square-entity-schemas.mjs`.
 *
 * https://developer.squareup.com/docs/build-basics/versioning-overview
 */
export const SQUARE_CONNECTOR_API_VERSION = '2026-09-16';

/** A failed Square API call, carrying Square's own `errors` array. */
export class SquareError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly squareErrors: SquareApiErrorEntry[] = [],
    public readonly responseData?: unknown,
  ) {
    super(message);
    this.name = 'SquareError';
  }
}

/**
 * True when Square is throttling us. Square signals this with HTTP 429 (error code `RATE_LIMITED`)
 * and documents no `Retry-After` header, so detection is by status and the retry uses the default
 * exponential backoff.
 *
 * https://developer.squareup.com/docs/build-basics/handling-errors
 */
export function isSquareRateLimitError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 429;
}

/**
 * Retry policy for every Square call. Safe because every call this connector makes is a read:
 * GETs, plus POSTs with no side effects (SearchOrders, SearchTeamMembers, SearchSubscriptions, and
 * RetrieveTokenStatus).
 */
export const SQUARE_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: isSquareRateLimitError,
};

/** Convert an axios failure into a {@link SquareError} that reads Square's `errors[].detail`. */
export function toSquareError(error: unknown): unknown {
  if (!axios.isAxiosError(error) || !error.response) return error;
  const responseData = error.response.data as { errors?: SquareApiErrorEntry[] } | undefined;
  const squareErrors = Array.isArray(responseData?.errors) ? responseData.errors : [];
  const detailMessages = squareErrors
    .map((squareError) => squareError.detail ?? squareError.code)
    .filter((message): message is string => typeof message === 'string' && message.length > 0);
  const message =
    detailMessages.length > 0
      ? `Square API error (${error.response.status}): ${detailMessages.join('; ')}`
      : `Square API error (${error.response.status}): ${error.message}`;
  return new SquareError(message, error.response.status, squareErrors, error.response.data);
}

function buildSquareHttpClient(
  accessTokenOrProvider: ConnectorAuthTokenOrProvider,
  environment: SquareEnvironment,
): AxiosInstance {
  const accessTokenProvider = toConnectorAuthTokenProvider(accessTokenOrProvider);
  return createApiClient(
    {
      baseURL: SQUARE_API_BASE_URL_BY_ENVIRONMENT[environment],
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Square-Version': SQUARE_CONNECTOR_API_VERSION,
      },
    },
    { authorizationHeaderValueProvider: async () => `Bearer ${await accessTokenProvider()}` },
  );
}

/** One page of records from a list/search endpoint, plus where a resumed pull should continue. */
export interface SquareRecordPage {
  records: Record<string, unknown>[];
  progressAfterPage: SquarePullProgress;
}

interface SquareCursorPageResponse {
  cursor?: string;
  [recordsKey: string]: unknown;
}

/**
 * Low-level client for the Square API.
 *
 * Square's list endpoints disagree on scope and defaults, so each table declares a listing
 * strategy (`SquareListingStrategy` in square-types.ts) and this client implements each one. The two
 * defaults that would silently drop data are overridden here: ListPayments / ListPayouts cover
 * only the seller's main location unless given `location_id`, and they (with ListRefunds) return
 * only the last year unless given an early `begin_time`.
 *
 * API docs: https://developer.squareup.com/reference/square
 */
export class SquareApiClient {
  private readonly httpClient: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;
  private sortedLocationIdsPromise?: Promise<string[]>;

  constructor(
    private readonly credentials: SquareCredentials,
    opts?: { rateLimiter?: RateLimiter },
  ) {
    this.rateLimiter = opts?.rateLimiter;
    this.httpClient = buildSquareHttpClient(credentials.accessToken, credentials.environment);
  }

  get environment(): SquareEnvironment {
    return this.credentials.environment;
  }

  /**
   * Work out which Square environment an access token belongs to by asking each one who the
   * merchant is. Square issues separate tokens per environment and each rejects the other's with
   * a 401, so the first environment that accepts the token is its home.
   *
   * @returns the environment, or `null` when both reject the token as unauthorized.
   */
  static async detectEnvironmentForAccessToken(accessToken: string): Promise<SquareEnvironment | null> {
    for (const candidateEnvironment of ['production', 'sandbox'] as const) {
      const candidateHttpClient = buildSquareHttpClient(accessToken, candidateEnvironment);
      try {
        await standaloneWithRetry(() => candidateHttpClient.get('/v2/merchants/me'), SQUARE_RETRY_OPTS);
        return candidateEnvironment;
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 401) continue;
        throw toSquareError(error);
      }
    }
    return null;
  }

  private async request<T>(fn: () => Promise<T>): Promise<T> {
    try {
      if (this.rateLimiter) {
        return await this.rateLimiter.withRetry(fn, SQUARE_RETRY_OPTS);
      }
      return await standaloneWithRetry(fn, SQUARE_RETRY_OPTS);
    } catch (error) {
      throw toSquareError(error);
    }
  }

  /** Confirm the token still works by fetching the merchant it belongs to. */
  async validateCredentials(): Promise<void> {
    await this.request(() => this.httpClient.get('/v2/merchants/me'));
  }

  /**
   * The permissions the access token was granted, from RetrieveTokenStatus. An OAuth connection keeps the scopes it
   * was signed in with, so one made before a table was added may lack that table's scope.
   *
   * https://developer.squareup.com/reference/square/o-auth-api/retrieve-token-status
   */
  async retrieveGrantedScopes(): Promise<Set<string>> {
    const response = await this.request(() => this.httpClient.post<{ scopes?: unknown }>('/oauth2/token/status', {}));
    const scopes = Array.isArray(response.data.scopes) ? response.data.scopes : [];
    return new Set(scopes.filter((scope): scope is string => typeof scope === 'string'));
  }

  /**
   * Every location id of the seller (active and inactive), sorted so a resumed pull walks them in
   * the same order as the run that saved its progress. Fetched once per client.
   */
  async listAllLocationIdsSorted(): Promise<string[]> {
    this.sortedLocationIdsPromise ??= this.request(() =>
      this.httpClient.get<{ locations?: { id?: unknown }[] }>('/v2/locations'),
    ).then((response) =>
      (response.data.locations ?? [])
        .map((location) => location.id)
        .filter((locationId): locationId is string => typeof locationId === 'string')
        .sort(),
    );
    return this.sortedLocationIdsPromise;
  }

  /**
   * Walk every record of a table, page by page. Records are yielded exactly as Square returned
   * them; only the response envelope (the records key and `cursor`) is stripped.
   */
  async *listEntityPages(
    entityType: SquareEntityType,
    resumeFromProgress?: SquarePullProgress,
  ): AsyncGenerator<SquareRecordPage, void> {
    const entityConfig = SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE[entityType];
    switch (entityConfig.listingStrategy) {
      case 'single-request':
        yield* this.listSingleRequestPages(entityConfig);
        return;
      case 'cursor':
        yield* this.listCursorPages(entityConfig, resumeFromProgress?.cursor);
        return;
      case 'cursor-per-location':
        yield* this.listCursorPagesPerLocation(entityConfig, resumeFromProgress);
        return;
      case 'cursor-per-payout':
        yield* this.listCursorPagesPerPayout(entityConfig, resumeFromProgress);
        return;
      case 'orders-search':
        yield* this.listOrdersSearchPages(entityConfig, resumeFromProgress);
        return;
      case 'cursor-search':
        yield* this.listCursorSearchPages(entityConfig, resumeFromProgress?.cursor);
        return;
      default:
        assertUnreachable(entityConfig.listingStrategy);
    }
  }

  private recordsFromResponse(entityConfig: SquareEntityConfig, responseData: unknown): Record<string, unknown>[] {
    const records = (responseData as Record<string, unknown> | undefined)?.[entityConfig.listResponseRecordsKey];
    return Array.isArray(records) ? (records as Record<string, unknown>[]) : [];
  }

  private async *listSingleRequestPages(entityConfig: SquareEntityConfig): AsyncGenerator<SquareRecordPage, void> {
    const response = await this.request(() =>
      this.httpClient.get<unknown>(entityConfig.listEndpointPath, { params: entityConfig.listQueryParams }),
    );
    const records = this.recordsFromResponse(entityConfig, response.data);
    if (records.length > 0) yield { records, progressAfterPage: {} };
  }

  private async *listCursorPages(
    entityConfig: SquareEntityConfig,
    resumeCursor: string | undefined,
    extraQueryParams: Record<string, string> = {},
    progressForCursor: (nextCursor: string | undefined) => SquarePullProgress = (nextCursor) =>
      nextCursor ? { cursor: nextCursor } : {},
    listEndpointPath: string = entityConfig.listEndpointPath,
  ): AsyncGenerator<SquareRecordPage, void> {
    let cursor = resumeCursor;
    do {
      const params = { ...entityConfig.listQueryParams, ...extraQueryParams, ...(cursor ? { cursor } : {}) };
      const response = await this.request(() =>
        this.httpClient.get<SquareCursorPageResponse>(listEndpointPath, { params }),
      );
      const records = this.recordsFromResponse(entityConfig, response.data);
      cursor = typeof response.data.cursor === 'string' && response.data.cursor ? response.data.cursor : undefined;
      // Square may return a short (even empty) page that still carries a cursor; keep walking.
      if (records.length > 0) yield { records, progressAfterPage: progressForCursor(cursor) };
    } while (cursor);
  }

  private async *listCursorPagesPerLocation(
    entityConfig: SquareEntityConfig,
    resumeFromProgress: SquarePullProgress | undefined,
  ): AsyncGenerator<SquareRecordPage, void> {
    const sortedLocationIds = await this.listAllLocationIdsSorted();
    const firstLocationIndex = resumeFromProgress?.locationIndex ?? 0;
    for (let locationIndex = firstLocationIndex; locationIndex < sortedLocationIds.length; locationIndex++) {
      const resumeCursor = locationIndex === firstLocationIndex ? resumeFromProgress?.cursor : undefined;
      yield* this.listCursorPages(
        entityConfig,
        resumeCursor,
        { location_id: sortedLocationIds[locationIndex] },
        (nextCursor) => (nextCursor ? { locationIndex, cursor: nextCursor } : { locationIndex: locationIndex + 1 }),
      );
    }
  }

  /**
   * Every payout id of the seller, across every location and the full history, oldest first (ties by id). A resumed
   * pull walks them in the same order as the run that saved its progress, and a payout created in between lands at
   * the end, so the saved position still points at the same payout. (Payout ids are random, so ordering by id
   * would let a new payout shift every later one.)
   */
  private async listAllPayoutIdsOldestFirst(): Promise<string[]> {
    const payoutsWithCreationTime: { payoutId: string; createdAtEpochMilliseconds: number }[] = [];
    for await (const payoutPage of this.listCursorPagesPerLocation(SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE.payouts, {})) {
      for (const payout of payoutPage.records) {
        if (typeof payout.id !== 'string') continue;
        const createdAtEpochMilliseconds = Date.parse(String(payout.created_at));
        payoutsWithCreationTime.push({
          payoutId: payout.id,
          createdAtEpochMilliseconds: Number.isNaN(createdAtEpochMilliseconds) ? 0 : createdAtEpochMilliseconds,
        });
      }
    }
    return payoutsWithCreationTime
      .sort(
        (first, second) =>
          first.createdAtEpochMilliseconds - second.createdAtEpochMilliseconds ||
          first.payoutId.localeCompare(second.payoutId),
      )
      .map(({ payoutId }) => payoutId);
  }

  private async *listCursorPagesPerPayout(
    entityConfig: SquareEntityConfig,
    resumeFromProgress: SquarePullProgress | undefined,
  ): AsyncGenerator<SquareRecordPage, void> {
    const payoutIdsOldestFirst = await this.listAllPayoutIdsOldestFirst();
    const firstPayoutIndex = resumeFromProgress?.payoutIndex ?? 0;
    for (let payoutIndex = firstPayoutIndex; payoutIndex < payoutIdsOldestFirst.length; payoutIndex++) {
      const resumeCursor = payoutIndex === firstPayoutIndex ? resumeFromProgress?.cursor : undefined;
      yield* this.listCursorPages(
        entityConfig,
        resumeCursor,
        {},
        (nextCursor) => (nextCursor ? { payoutIndex, cursor: nextCursor } : { payoutIndex: payoutIndex + 1 }),
        entityConfig.listEndpointPath.replace('{payout_id}', encodeURIComponent(payoutIdsOldestFirst[payoutIndex])),
      );
    }
  }

  private async *listOrdersSearchPages(
    entityConfig: SquareEntityConfig,
    resumeFromProgress: SquarePullProgress | undefined,
  ): AsyncGenerator<SquareRecordPage, void> {
    const sortedLocationIds = await this.listAllLocationIdsSorted();
    const firstBatchStartIndex = resumeFromProgress?.locationIndex ?? 0;
    for (
      let batchStartIndex = firstBatchStartIndex;
      batchStartIndex < sortedLocationIds.length;
      batchStartIndex += SQUARE_ORDERS_SEARCH_MAX_LOCATION_IDS
    ) {
      const locationIdsInBatch = sortedLocationIds.slice(
        batchStartIndex,
        batchStartIndex + SQUARE_ORDERS_SEARCH_MAX_LOCATION_IDS,
      );
      let cursor = batchStartIndex === firstBatchStartIndex ? resumeFromProgress?.cursor : undefined;
      do {
        const requestBody = {
          location_ids: locationIdsInBatch,
          // Square's default page size; the 1000 maximum makes for multi-megabyte responses.
          limit: 500,
          return_entries: false,
          query: {
            filter: { state_filter: { states: SQUARE_ALL_ORDER_STATES } },
            sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' },
          },
          ...(cursor ? { cursor } : {}),
        };
        const response = await this.request(() =>
          this.httpClient.post<SquareCursorPageResponse>(entityConfig.listEndpointPath, requestBody),
        );
        const records = this.recordsFromResponse(entityConfig, response.data);
        cursor = typeof response.data.cursor === 'string' && response.data.cursor ? response.data.cursor : undefined;
        if (records.length > 0) {
          yield {
            records,
            progressAfterPage: cursor
              ? { locationIndex: batchStartIndex, cursor }
              : { locationIndex: batchStartIndex + SQUARE_ORDERS_SEARCH_MAX_LOCATION_IDS },
          };
        }
      } while (cursor);
    }
  }

  private async *listCursorSearchPages(
    entityConfig: SquareEntityConfig,
    resumeCursor: string | undefined,
  ): AsyncGenerator<SquareRecordPage, void> {
    let cursor = resumeCursor;
    do {
      // No `query`: Square then includes records of every status at every location.
      const requestBody = { limit: 100, ...(cursor ? { cursor } : {}) };
      const response = await this.request(() =>
        this.httpClient.post<SquareCursorPageResponse>(entityConfig.listEndpointPath, requestBody),
      );
      const records = this.recordsFromResponse(entityConfig, response.data);
      cursor = typeof response.data.cursor === 'string' && response.data.cursor ? response.data.cursor : undefined;
      if (records.length > 0) yield { records, progressAfterPage: cursor ? { cursor } : {} };
    } while (cursor);
  }

  /**
   * Fetch one record by id, exactly as Square returns it. Returns `null` when Square has no such
   * record — or, for a catalog table, when the id belongs to a catalog object of a different type,
   * since that object is not a record of this table.
   *
   * Throws for a table Square has no single-record endpoint for: answering `null` there would read
   * as "this record was deleted".
   */
  async retrieveEntity(entityType: SquareEntityType, recordId: string): Promise<Record<string, unknown> | null> {
    const entityConfig = SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE[entityType];
    const { retrieveOneRecord } = entityConfig;
    if (!retrieveOneRecord) {
      throw new SquareError(
        `Square can't fetch a single ${entityConfig.displayName} record. Pull the whole table to refresh it.`,
      );
    }
    const retrievePath = retrieveOneRecord.endpointPathTemplate.replace('{id}', encodeURIComponent(recordId));
    try {
      const response = await this.request(() => this.httpClient.get<Record<string, unknown>>(retrievePath));
      const record = response.data[retrieveOneRecord.responseRecordKey];
      if (!record || typeof record !== 'object') return null;
      const typedRecord = record as Record<string, unknown>;
      if (entityConfig.catalogObjectType && typedRecord.type !== entityConfig.catalogObjectType) return null;
      return typedRecord;
    } catch (error) {
      if (error instanceof SquareError && error.statusCode === 404) return null;
      throw error;
    }
  }
}
