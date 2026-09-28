import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import {
  RunStoreBudgetExceededError,
  RunStoreNotFoundError,
  type RunStoreClient,
  type RunStoreEntriesPage,
  type RunStoreEntry,
  type RunStoreEntryMeta,
  type RunStoreEntryToPut,
  type RunStoreKey,
  type RunStoreSummary,
} from './run-store-client';

const gzipAsync = promisify(gzip);

/** Request bodies at least this large are gzipped (`Content-Encoding: gzip`); smaller ones aren't worth it. */
export const RUN_STORE_REQUEST_GZIP_THRESHOLD_BYTES = 64 * 1024;

/**
 * Most uncompressed JSON one `putEntries` request carries; a larger call is split into several requests.
 * The nginx proxy in front of scratch-git refuses bodies over 50 MB (`client_max_body_size` in the
 * scratch-git VM's startup script), and this stays under that even for entries gzip can't shrink.
 */
export const RUN_STORE_PUT_REQUEST_MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;

/** Splits entries into consecutive batches of at most `maxBytes` of (approximate) request JSON each. */
export function splitEntriesIntoRequestSizedBatches(
  entries: RunStoreEntryToPut[],
  maxBytes: number = RUN_STORE_PUT_REQUEST_MAX_UNCOMPRESSED_BYTES,
): RunStoreEntryToPut[][] {
  const batches: RunStoreEntryToPut[][] = [];
  let currentBatch: RunStoreEntryToPut[] = [];
  let currentBatchBytes = 0;
  for (const entry of entries) {
    // Key, meta and body as JSON strings, plus a little for the object's own punctuation.
    const entryBytes =
      Buffer.byteLength(JSON.stringify(entry.key)) +
      Buffer.byteLength(JSON.stringify(entry.meta ?? {})) +
      (entry.body ? Buffer.byteLength(JSON.stringify(entry.body)) : 4) +
      32;
    if (currentBatch.length > 0 && currentBatchBytes + entryBytes > maxBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchBytes = 0;
    }
    currentBatch.push(entry);
    currentBatchBytes += entryBytes;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

/** Calls slower than this are logged with WSLogger.warn. */
const SLOW_RUN_STORE_CALL_THRESHOLD_MS = 1000;

/** Longest slice of an error response body kept in the thrown error / log. */
const MAXIMUM_ERROR_RESPONSE_BODY_CHARACTERS = 1000;

const LOG_SOURCE = 'HttpRunStoreClient';

/** Where scratch-git is and how to authenticate to it — the same settings `ScratchGitClient` uses. */
export interface HttpRunStoreClientConnectionSettings {
  /** e.g. `http://localhost:3100` (no trailing slash needed). */
  scratchGitApiUrl: string;
  /** Shared bearer token (`SCRATCH_GIT_AUTH_TOKEN`); undefined → no `Authorization` header. */
  scratchGitAuthToken: string | undefined;
  /** Default true. False sends and asks for uncompressed bodies (benchmarks, debugging with a proxy). */
  gzipRequestAndResponseBodies?: boolean;
}

/** What one call is about, for errors and slow-call logs. */
interface RunStoreCallDescription {
  operation: keyof RunStoreClient;
  runStoreKey: RunStoreKey;
  collection?: string;
  entryCount?: number;
}

/** A non-2xx response the caller decides how to map. */
class RunStoreHttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
    description: RunStoreCallDescription,
    method: string,
    path: string,
  ) {
    super(`scratch-git run store ${description.operation} failed: ${method} ${path} → HTTP ${status}: ${responseBody}`);
    this.name = 'RunStoreHttpStatusError';
  }
}

/** The `{ data, status }` envelope's `data.error` when present, else the raw body (truncated). */
function readableErrorMessageFromResponseBody(responseBody: string): string {
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (typeof parsed === 'object' && parsed !== null && 'data' in parsed) {
      const data: unknown = parsed.data;
      if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
        return data.error;
      }
    }
  } catch {
    // Not JSON (e.g. axum's plain-text extractor rejections) — fall through to the raw text.
  }
  return responseBody;
}

function truncateForError(text: string): string {
  return text.length > MAXIMUM_ERROR_RESPONSE_BODY_CHARACTERS
    ? `${text.slice(0, MAXIMUM_ERROR_RESPONSE_BODY_CHARACTERS)}… (truncated)`
    : text;
}

/**
 * `RunStoreClient` over HTTP to scratch-git's `/api/run-store/…` endpoints (scratch-git-2/docs/RUN_STORE.md).
 * Behaves exactly like `InMemoryRunStoreClient` — the shared contract suite
 * (`__tests__/run-store-client.contract.ts`) runs against both.
 *
 * Transport: request bodies of 64 KB or more are gzipped; responses are requested gzipped
 * (`Accept-Encoding: gzip`, which Node's fetch decompresses transparently). Every response is unwrapped from
 * scratch-git's `{ data, status }` envelope. A 404 on a store-scoped call → `RunStoreNotFoundError`; a 507 on
 * create → `RunStoreBudgetExceededError`; any other non-2xx → an Error carrying the status and (truncated) body.
 */
export class HttpRunStoreClient implements RunStoreClient {
  private readonly scratchGitApiUrl: string;
  private readonly scratchGitAuthToken: string | undefined;
  private readonly gzipRequestAndResponseBodies: boolean;

  constructor(connectionSettings: HttpRunStoreClientConnectionSettings) {
    this.scratchGitApiUrl = connectionSettings.scratchGitApiUrl.replace(/\/+$/, '');
    this.scratchGitAuthToken = connectionSettings.scratchGitAuthToken;
    this.gzipRequestAndResponseBodies = connectionSettings.gzipRequestAndResponseBodies ?? true;
  }

  async createOrClearRunStore(runStoreKey: RunStoreKey): Promise<void> {
    const description: RunStoreCallDescription = { operation: 'createOrClearRunStore', runStoreKey };
    try {
      await this.callRunStoreApi(description, 'POST', this.runStorePath(runStoreKey));
    } catch (error) {
      if (error instanceof RunStoreHttpStatusError && error.status === 507) {
        throw new RunStoreBudgetExceededError(runStoreKey, readableErrorMessageFromResponseBody(error.responseBody));
      }
      throw error;
    }
  }

  async deleteRunStore(runStoreKey: RunStoreKey): Promise<void> {
    await this.callRunStoreApi({ operation: 'deleteRunStore', runStoreKey }, 'DELETE', this.runStorePath(runStoreKey));
  }

  async getRunStoreSummary(runStoreKey: RunStoreKey): Promise<RunStoreSummary | null> {
    try {
      return (await this.callRunStoreApi(
        { operation: 'getRunStoreSummary', runStoreKey },
        'GET',
        this.runStorePath(runStoreKey),
      )) as RunStoreSummary;
    } catch (error) {
      if (error instanceof RunStoreHttpStatusError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** A call larger than `RUN_STORE_PUT_REQUEST_MAX_UNCOMPRESSED_BYTES` is sent as several requests. */
  async putEntries(runStoreKey: RunStoreKey, collection: string, entries: RunStoreEntryToPut[]): Promise<void> {
    for (const batch of splitEntriesIntoRequestSizedBatches(entries)) {
      await this.callStoreScopedApi(
        { operation: 'putEntries', runStoreKey, collection, entryCount: batch.length },
        'POST',
        `${this.collectionPath(runStoreKey, collection)}/entries`,
        { entries: batch },
      );
    }
  }

  async readEntriesPage(
    runStoreKey: RunStoreKey,
    collection: string,
    options: { afterKey?: string | null; limit?: number; includeBodies: boolean },
  ): Promise<RunStoreEntriesPage> {
    const query = new URLSearchParams({ includeBodies: String(options.includeBodies) });
    if (options.afterKey !== undefined && options.afterKey !== null) {
      query.set('afterKey', options.afterKey);
    }
    if (options.limit !== undefined) {
      query.set('limit', String(options.limit));
    }
    const page = (await this.callStoreScopedApi(
      { operation: 'readEntriesPage', runStoreKey, collection },
      'GET',
      `${this.collectionPath(runStoreKey, collection)}/entries?${query.toString()}`,
    )) as RunStoreEntriesPage;
    return page;
  }

  async readEntriesByKeys(
    runStoreKey: RunStoreKey,
    collection: string,
    keys: string[],
    options: { includeBodies: boolean },
  ): Promise<{ entries: RunStoreEntry[]; missingKeys: string[] }> {
    return (await this.callStoreScopedApi(
      { operation: 'readEntriesByKeys', runStoreKey, collection, entryCount: keys.length },
      'POST',
      `${this.collectionPath(runStoreKey, collection)}/entries/by-keys`,
      { keys, includeBodies: options.includeBodies },
    )) as { entries: RunStoreEntry[]; missingKeys: string[] };
  }

  async patchEntryMeta(
    runStoreKey: RunStoreKey,
    collection: string,
    patches: Array<{ key: string; metaPatch: RunStoreEntryMeta }>,
  ): Promise<{ missingKeys: string[] }> {
    return (await this.callStoreScopedApi(
      { operation: 'patchEntryMeta', runStoreKey, collection, entryCount: patches.length },
      'POST',
      `${this.collectionPath(runStoreKey, collection)}/entries/patch-meta`,
      { patches },
    )) as { missingKeys: string[] };
  }

  async mergeCollectionInto(runStoreKey: RunStoreKey, fromCollection: string, toCollection: string): Promise<number> {
    const result = (await this.callStoreScopedApi(
      { operation: 'mergeCollectionInto', runStoreKey, collection: `${fromCollection} → ${toCollection}` },
      'POST',
      `${this.collectionPath(runStoreKey, fromCollection)}/merge-into/${encodeURIComponent(toCollection)}`,
    )) as { moved: number };
    return result.moved;
  }

  async deleteCollection(runStoreKey: RunStoreKey, collection: string): Promise<void> {
    await this.callStoreScopedApi(
      { operation: 'deleteCollection', runStoreKey, collection },
      'DELETE',
      this.collectionPath(runStoreKey, collection),
    );
  }

  private runStorePath(runStoreKey: RunStoreKey): string {
    return `/api/run-store/${encodeURIComponent(runStoreKey)}`;
  }

  private collectionPath(runStoreKey: RunStoreKey, collection: string): string {
    return `${this.runStorePath(runStoreKey)}/collections/${encodeURIComponent(collection)}`;
  }

  /** A call that needs the store to exist: 404 → `RunStoreNotFoundError`. */
  private async callStoreScopedApi(
    description: RunStoreCallDescription,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    try {
      return await this.callRunStoreApi(description, method, path, body);
    } catch (error) {
      if (error instanceof RunStoreHttpStatusError && error.status === 404) {
        throw new RunStoreNotFoundError(description.runStoreKey);
      }
      throw error;
    }
  }

  /** One HTTP round-trip: gzip a large body, check the status, unwrap the `{ data, status }` envelope. */
  private async callRunStoreApi(
    description: RunStoreCallDescription,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'Accept-Encoding': this.gzipRequestAndResponseBodies ? 'gzip' : 'identity',
    };
    if (this.scratchGitAuthToken) {
      headers.Authorization = `Bearer ${this.scratchGitAuthToken}`;
    }
    let requestBody: string | Uint8Array<ArrayBuffer> | undefined;
    let requestBodyBytes = 0;
    if (body !== undefined) {
      const requestJson = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      requestBodyBytes = Buffer.byteLength(requestJson);
      if (this.gzipRequestAndResponseBodies && requestBodyBytes >= RUN_STORE_REQUEST_GZIP_THRESHOLD_BYTES) {
        // Level 1: record JSON still shrinks several-fold, at a fraction of the default level's CPU time.
        const gzippedRequestJson = await gzipAsync(requestJson, { level: 1 });
        requestBody = new Uint8Array(gzippedRequestJson);
        requestBodyBytes = gzippedRequestJson.byteLength;
        headers['Content-Encoding'] = 'gzip';
      } else {
        requestBody = requestJson;
      }
    }

    const startMs = Date.now();
    let response: Response;
    let responseText: string;
    try {
      response = await fetch(`${this.scratchGitApiUrl}${path}`, { method, headers, body: requestBody });
      responseText = await response.text();
    } catch (error) {
      // Node's fetch wraps connection errors in a generic TypeError — surface the real cause.
      const rootCause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      throw new Error(
        `scratch-git run store ${description.operation}: ${method} ${path} failed: ${rootCause instanceof Error ? rootCause.message : String(rootCause)}`,
        { cause: error },
      );
    }
    const durationMs = Date.now() - startMs;

    let data: unknown = undefined;
    let failure: Error | undefined;
    if (!response.ok) {
      failure = new RunStoreHttpStatusError(response.status, truncateForError(responseText), description, method, path);
    } else {
      try {
        const parsedResponse: unknown = JSON.parse(responseText);
        // Unpack the `{ data, status }` envelope the same way ScratchGitClient does.
        data =
          parsedResponse && typeof parsedResponse === 'object' && 'data' in parsedResponse
            ? parsedResponse.data
            : parsedResponse;
      } catch {
        failure = new Error(
          `scratch-git run store ${description.operation}: invalid JSON response from ${method} ${path}: ${truncateForError(responseText)}`,
        );
      }
    }

    if (durationMs > SLOW_RUN_STORE_CALL_THRESHOLD_MS) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Slow scratch-git run store call',
        operation: description.operation,
        runStoreKey: description.runStoreKey,
        collection: description.collection,
        entryCount: description.entryCount ?? countEntriesInResponseData(data),
        requestBytes: requestBodyBytes,
        responseCharacters: responseText.length,
        status: response.status,
        durationMs,
      });
    }

    if (failure) {
      throw failure;
    }
    return data;
  }
}

/** For slow-call logs of reads: how many entries came back. */
function countEntriesInResponseData(data: unknown): number | undefined {
  if (typeof data === 'object' && data !== null && 'entries' in data && Array.isArray(data.entries)) {
    return data.entries.length;
  }
  return undefined;
}

/** Builds the client from the same scratch-git URL + auth token config `ScratchGitClient` reads. */
export function createHttpRunStoreClientFromConfig(scratchConfigService: ScratchConfigService): HttpRunStoreClient {
  return new HttpRunStoreClient({
    scratchGitApiUrl: scratchConfigService.getScratchGitApiUrl(),
    scratchGitAuthToken: scratchConfigService.getScratchGitAuthToken(),
  });
}
