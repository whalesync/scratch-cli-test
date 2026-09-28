import {
  compareRunStoreKeys,
  RUN_STORE_MAX_KEYS_PER_READ,
  RUN_STORE_MAX_PAGE_LIMIT,
  RunStoreNotFoundError,
  type RunStoreClient,
  type RunStoreEntriesPage,
  type RunStoreEntry,
  type RunStoreEntryMeta,
  type RunStoreEntryToPut,
  type RunStoreKey,
  type RunStoreSummary,
} from './run-store-client';

interface StoredEntry {
  meta: RunStoreEntryMeta;
  body: string | null;
}

/**
 * `RunStoreClient` in process memory — the reference semantics for the HTTP store, and the store the
 * Live Export adapter unit tests run against. Keys order by Unicode code point (`compareRunStoreKeys`),
 * which is UTF-8 byte order — SQLite's BINARY collation, what the HTTP store uses. The same request
 * limits as the HTTP store apply (page limit, keys per read), so an adapter can't pass here and fail there.
 */
export class InMemoryRunStoreClient implements RunStoreClient {
  private readonly stores = new Map<RunStoreKey, Map<string, Map<string, StoredEntry>>>();

  /** Every call made, for tests that assert on round-trips. */
  readonly callLog: Array<{ method: keyof RunStoreClient; collection?: string; size?: number }> = [];

  createOrClearRunStore(runStoreKey: RunStoreKey): Promise<void> {
    this.callLog.push({ method: 'createOrClearRunStore' });
    this.stores.set(runStoreKey, new Map());
    return Promise.resolve();
  }

  deleteRunStore(runStoreKey: RunStoreKey): Promise<void> {
    this.callLog.push({ method: 'deleteRunStore' });
    this.stores.delete(runStoreKey);
    return Promise.resolve();
  }

  getRunStoreSummary(runStoreKey: RunStoreKey): Promise<RunStoreSummary | null> {
    const store = this.stores.get(runStoreKey);
    if (!store) return Promise.resolve(null);
    return Promise.resolve({
      key: runStoreKey,
      collections: [...store.entries()]
        .filter(([, entries]) => entries.size > 0)
        .map(([collection, entries]) => ({
          collection,
          entryCount: entries.size,
          bodyBytes: [...entries.values()].reduce((total, entry) => total + Buffer.byteLength(entry.body ?? ''), 0),
        }))
        .sort((left, right) => (left.collection < right.collection ? -1 : 1)),
    });
  }

  putEntries(runStoreKey: RunStoreKey, collection: string, entries: RunStoreEntryToPut[]): Promise<void> {
    this.callLog.push({ method: 'putEntries', collection, size: entries.length });
    const entriesOfCollection = this.collectionOf(runStoreKey, collection, true);
    for (const entry of entries) {
      entriesOfCollection.set(entry.key, { meta: { ...(entry.meta ?? {}) }, body: entry.body ?? null });
    }
    return Promise.resolve();
  }

  readEntriesPage(
    runStoreKey: RunStoreKey,
    collection: string,
    options: { afterKey?: string | null; limit?: number; includeBodies: boolean },
  ): Promise<RunStoreEntriesPage> {
    this.callLog.push({ method: 'readEntriesPage', collection });
    const limit = options.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > RUN_STORE_MAX_PAGE_LIMIT) {
      return Promise.reject(new Error(`Run store page limit must be between 1 and ${RUN_STORE_MAX_PAGE_LIMIT}`));
    }
    const entriesOfCollection = this.collectionOf(runStoreKey, collection, false);
    const afterKey = options.afterKey;
    const keysInOrder = [...(entriesOfCollection?.keys() ?? [])]
      .filter((key) => afterKey === undefined || afterKey === null || compareRunStoreKeys(key, afterKey) > 0)
      .sort(compareRunStoreKeys);
    const pageKeys = keysInOrder.slice(0, limit);
    const entries = pageKeys.map((key) => this.toEntry(key, entriesOfCollection?.get(key), options.includeBodies));
    const nextAfterKey = keysInOrder.length > limit ? pageKeys[pageKeys.length - 1] : null;
    return Promise.resolve({ entries, nextAfterKey });
  }

  readEntriesByKeys(
    runStoreKey: RunStoreKey,
    collection: string,
    keys: string[],
    options: { includeBodies: boolean },
  ): Promise<{ entries: RunStoreEntry[]; missingKeys: string[] }> {
    this.callLog.push({ method: 'readEntriesByKeys', collection, size: keys.length });
    if (keys.length > RUN_STORE_MAX_KEYS_PER_READ) {
      return Promise.reject(new Error(`Run store read-by-keys accepts at most ${RUN_STORE_MAX_KEYS_PER_READ} keys`));
    }
    const entriesOfCollection = this.collectionOf(runStoreKey, collection, false);
    const entries: RunStoreEntry[] = [];
    const missingKeys: string[] = [];
    for (const key of keys) {
      const stored = entriesOfCollection?.get(key);
      if (stored) {
        entries.push(this.toEntry(key, stored, options.includeBodies));
      } else {
        missingKeys.push(key);
      }
    }
    return Promise.resolve({ entries, missingKeys });
  }

  patchEntryMeta(
    runStoreKey: RunStoreKey,
    collection: string,
    patches: Array<{ key: string; metaPatch: RunStoreEntryMeta }>,
  ): Promise<{ missingKeys: string[] }> {
    this.callLog.push({ method: 'patchEntryMeta', collection, size: patches.length });
    const entriesOfCollection = this.collectionOf(runStoreKey, collection, false);
    const missingKeys: string[] = [];
    for (const { key, metaPatch } of patches) {
      const stored = entriesOfCollection?.get(key);
      if (!stored) {
        missingKeys.push(key);
        continue;
      }
      for (const [field, value] of Object.entries(metaPatch)) {
        if (value === null) {
          delete stored.meta[field];
        } else {
          stored.meta[field] = value;
        }
      }
    }
    return Promise.resolve({ missingKeys });
  }

  mergeCollectionInto(runStoreKey: RunStoreKey, fromCollection: string, toCollection: string): Promise<number> {
    this.callLog.push({ method: 'mergeCollectionInto', collection: fromCollection });
    const from = this.collectionOf(runStoreKey, fromCollection, false);
    if (fromCollection === toCollection) {
      return Promise.reject(new Error(`Cannot merge run store collection '${fromCollection}' into itself`));
    }
    if (!from || from.size === 0) return Promise.resolve(0);
    const to = this.collectionOf(runStoreKey, toCollection, true);
    for (const [key, entry] of from) {
      to.set(key, entry);
    }
    const moved = from.size;
    from.clear();
    return Promise.resolve(moved);
  }

  deleteCollection(runStoreKey: RunStoreKey, collection: string): Promise<void> {
    this.callLog.push({ method: 'deleteCollection', collection });
    const store = this.stores.get(runStoreKey);
    if (!store) {
      throw new RunStoreNotFoundError(runStoreKey);
    }
    store.delete(collection);
    return Promise.resolve();
  }

  private collectionOf(runStoreKey: RunStoreKey, collection: string, create: true): Map<string, StoredEntry>;
  private collectionOf(
    runStoreKey: RunStoreKey,
    collection: string,
    create: false,
  ): Map<string, StoredEntry> | undefined;
  private collectionOf(
    runStoreKey: RunStoreKey,
    collection: string,
    create: boolean,
  ): Map<string, StoredEntry> | undefined {
    const store = this.stores.get(runStoreKey);
    if (!store) {
      throw new RunStoreNotFoundError(runStoreKey);
    }
    let entries = store.get(collection);
    if (!entries && create) {
      entries = new Map();
      store.set(collection, entries);
    }
    return entries;
  }

  private toEntry(key: string, stored: StoredEntry | undefined, includeBodies: boolean): RunStoreEntry {
    const entry: RunStoreEntry = { key, meta: { ...(stored?.meta ?? {}) } };
    if (includeBodies) {
      entry.body = stored?.body ?? null;
    }
    return entry;
  }
}
