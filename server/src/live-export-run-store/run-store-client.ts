/**
 * Client contract for a Live Export run store: one disposable store per routine run, hosted by
 * scratch-git (`{staging_dir}/le-<routineRunId>/run.db`), holding every per-record byte the run
 * works on — see docs/plans/2026-09-25-live-export-git-free-run-store/2026-09-25-live-export-git-free-run-store.md.
 *
 * The store is a set of named COLLECTIONS. Each collection is an ordered map of string keys to
 * entries; an entry has a small JSON `meta` object (metadata the adapters filter on) and an optional
 * `body` string (a record's JSON text, a table spec, a plan operation's payload). All the Live
 * Export adapters (pull sink, sync ports, publish plan store, …) are built on these few operations,
 * so the server side stays a generic, easily-tested key/value store.
 *
 * `HttpRunStoreClient` talks to scratch-git; `InMemoryRunStoreClient` implements the same contract
 * in process for tests.
 */

/** A run store's key: `le-<routineRunId>`. */
export type RunStoreKey = `le-${string}`;

export function runStoreKeyForRoutineRun(routineRunId: string): RunStoreKey {
  return `le-${routineRunId}`;
}

export type RunStoreEntryMeta = Record<string, unknown>;

export interface RunStoreEntryToPut {
  key: string;
  meta?: RunStoreEntryMeta;
  /** Omitted/null = no body (e.g. a tombstone). */
  body?: string | null;
}

export interface RunStoreEntry {
  key: string;
  meta: RunStoreEntryMeta;
  /** Present only when the read asked for bodies; null when the entry has none. */
  body?: string | null;
}

export interface RunStoreEntriesPage {
  entries: RunStoreEntry[];
  /** Pass as `afterKey` to read the next page; null when this was the last page. */
  nextAfterKey: string | null;
}

export interface RunStoreSummary {
  key: RunStoreKey;
  collections: Array<{ collection: string; entryCount: number; bodyBytes: number }>;
}

export interface RunStoreClient {
  /**
   * Create the store, or empty it if it exists. Fails when the total size of all run stores on the
   * git service is over its byte budget (the run should fail its first step, not fill the disk).
   */
  createOrClearRunStore(runStoreKey: RunStoreKey): Promise<void>;
  /** Delete the store and everything in it. Deleting a missing store succeeds. */
  deleteRunStore(runStoreKey: RunStoreKey): Promise<void>;
  /** Null when the store does not exist. */
  getRunStoreSummary(runStoreKey: RunStoreKey): Promise<RunStoreSummary | null>;

  /**
   * Insert or replace entries (whole entry: meta and body). Atomic only per request: the HTTP client splits
   * a very large call into several requests, so a caller that needs all-or-nothing writes to a staging
   * collection and then `mergeCollectionInto` (as the sync output sink does).
   */
  putEntries(runStoreKey: RunStoreKey, collection: string, entries: RunStoreEntryToPut[]): Promise<void>;

  /**
   * One page of a collection in ascending key order, starting after `afterKey` (exclusive).
   * `includeBodies` false returns keys + meta only (cheap). An empty or missing collection returns
   * an empty page.
   */
  readEntriesPage(
    runStoreKey: RunStoreKey,
    collection: string,
    options: { afterKey?: string | null; limit?: number; includeBodies: boolean },
  ): Promise<RunStoreEntriesPage>;

  /** The entries with these keys (in request order); keys with no entry are listed in `missingKeys`. */
  readEntriesByKeys(
    runStoreKey: RunStoreKey,
    collection: string,
    keys: string[],
    options: { includeBodies: boolean },
  ): Promise<{ entries: RunStoreEntry[]; missingKeys: string[] }>;

  /**
   * Shallow-merge `metaPatch` into each existing entry's meta (a key set to null is removed). Keys
   * with no entry are ignored and reported. One transaction per call.
   */
  patchEntryMeta(
    runStoreKey: RunStoreKey,
    collection: string,
    patches: Array<{ key: string; metaPatch: RunStoreEntryMeta }>,
  ): Promise<{ missingKeys: string[] }>;

  /**
   * Atomically move every entry of `fromCollection` into `toCollection` (replacing entries with the
   * same key) and empty `fromCollection`. Moving an empty/missing collection is a no-op. Returns the
   * number of entries moved.
   */
  mergeCollectionInto(runStoreKey: RunStoreKey, fromCollection: string, toCollection: string): Promise<number>;

  /** Remove a collection and all its entries. Removing a missing collection succeeds. */
  deleteCollection(runStoreKey: RunStoreKey, collection: string): Promise<void>;
}

/** Every operation except create/delete/summary requires the store to exist; a missing store throws this. */
export class RunStoreNotFoundError extends Error {
  constructor(runStoreKey: string) {
    super(`Run store ${runStoreKey} does not exist`);
    this.name = 'RunStoreNotFoundError';
  }
}

/**
 * Creating a run store was refused because the run stores on scratch-git together already use their
 * byte budget (`GIT_LE_RUN_STORE_MAX_BYTES`, HTTP 507). The run should fail its first step with this.
 */
export class RunStoreBudgetExceededError extends Error {
  constructor(
    public readonly runStoreKey: string,
    public readonly serverMessage: string,
  ) {
    super(`Cannot create run store ${runStoreKey}: ${serverMessage}`);
    this.name = 'RunStoreBudgetExceededError';
  }
}

/** Largest `limit` `readEntriesPage` accepts; larger (or < 1) is refused, not clamped. */
export const RUN_STORE_MAX_PAGE_LIMIT = 10_000;

/** Most keys one `readEntriesByKeys` call accepts. */
export const RUN_STORE_MAX_KEYS_PER_READ = 10_000;

/**
 * The order entries are stored and paged in: by Unicode code point, which is UTF-8 byte order (SQLite's
 * BINARY collation). NOT JavaScript's default string order (UTF-16 code units), which differs for keys
 * mixing astral characters (e.g. emoji) with U+E000–U+FFFF. Sort with this when you need the store's order.
 */
export function compareRunStoreKeys(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex) ?? 0;
    const rightCodePoint = right.codePointAt(rightIndex) ?? 0;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }
  const leftRemaining = left.length - leftIndex;
  const rightRemaining = right.length - rightIndex;
  return leftRemaining === rightRemaining ? 0 : leftRemaining < rightRemaining ? -1 : 1;
}

/** Page size the adapters read and write with (bulk: per-request overhead dominates small pages). */
export const RUN_STORE_BULK_PAGE_SIZE = 5000;

/** Pages through a whole collection in key order. */
export async function* readAllRunStoreEntries(
  client: RunStoreClient,
  runStoreKey: RunStoreKey,
  collection: string,
  options: { includeBodies: boolean; pageSize?: number },
): AsyncGenerator<RunStoreEntry[]> {
  let afterKey: string | null = null;
  do {
    const page: RunStoreEntriesPage = await client.readEntriesPage(runStoreKey, collection, {
      afterKey,
      limit: options.pageSize ?? RUN_STORE_BULK_PAGE_SIZE,
      includeBodies: options.includeBodies,
    });
    if (page.entries.length > 0) {
      yield page.entries;
    }
    afterKey = page.nextAfterKey;
  } while (afterKey !== null);
}

/** Writes entries in bulk-sized batches. */
export async function putRunStoreEntriesInBatches(
  client: RunStoreClient,
  runStoreKey: RunStoreKey,
  collection: string,
  entries: RunStoreEntryToPut[],
): Promise<void> {
  for (let index = 0; index < entries.length; index += RUN_STORE_BULK_PAGE_SIZE) {
    await client.putEntries(runStoreKey, collection, entries.slice(index, index + RUN_STORE_BULK_PAGE_SIZE));
  }
}
