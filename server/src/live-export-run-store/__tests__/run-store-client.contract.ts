import {
  compareRunStoreKeys,
  putRunStoreEntriesInBatches,
  readAllRunStoreEntries,
  RUN_STORE_BULK_PAGE_SIZE,
  RUN_STORE_MAX_KEYS_PER_READ,
  RUN_STORE_MAX_PAGE_LIMIT,
  RunStoreNotFoundError,
  type RunStoreClient,
  type RunStoreEntryToPut,
  type RunStoreKey,
} from '../run-store-client';

/**
 * The behaviour every `RunStoreClient` must have, as one jest suite. Runs against `InMemoryRunStoreClient`
 * (unit, `in-memory-run-store-client.spec.ts`) and `HttpRunStoreClient` against a real scratch-git
 * (`test/integration/http-run-store-client.spec.ts`), so the reference and the real store can't drift.
 *
 * Every test uses its own run store key, so the suite can share one scratch-git.
 */
export function describeRunStoreClientContract(
  name: string,
  createClient: () => Promise<RunStoreClient> | RunStoreClient,
): void {
  describe(`RunStoreClient contract: ${name}`, () => {
    let client: RunStoreClient;
    const runStoreKeysToDelete: RunStoreKey[] = [];
    let runStoreKeyCounter = 0;
    const runStoreKeyPrefixForThisSuite: RunStoreKey = `le-rrn_Contract${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    /** A fresh, created run store for one test (deleted after the test). */
    async function createFreshRunStore(): Promise<RunStoreKey> {
      const runStoreKey = uniqueRunStoreKey();
      await client.createOrClearRunStore(runStoreKey);
      return runStoreKey;
    }

    function uniqueRunStoreKey(): RunStoreKey {
      runStoreKeyCounter += 1;
      const runStoreKey: RunStoreKey = `${runStoreKeyPrefixForThisSuite}_${runStoreKeyCounter}`;
      runStoreKeysToDelete.push(runStoreKey);
      return runStoreKey;
    }

    /** Turns a synchronous throw into a rejection, so `.rejects` works for any implementation. */
    function settle<T>(operation: () => Promise<T>): Promise<T> {
      return Promise.resolve().then(operation);
    }

    async function allKeys(runStoreKey: RunStoreKey, collection: string): Promise<string[]> {
      const keys: string[] = [];
      for await (const page of readAllRunStoreEntries(client, runStoreKey, collection, { includeBodies: false })) {
        keys.push(...page.map((entry) => entry.key));
      }
      return keys;
    }

    beforeAll(async () => {
      client = await createClient();
    });

    afterEach(async () => {
      const keys = runStoreKeysToDelete.splice(0);
      for (const runStoreKey of keys) {
        await client.deleteRunStore(runStoreKey);
      }
    });

    describe('store lifecycle', () => {
      it('creates an empty store; the summary of a missing store is null', async () => {
        const runStoreKey = uniqueRunStoreKey();
        expect(await client.getRunStoreSummary(runStoreKey)).toBeNull();

        await client.createOrClearRunStore(runStoreKey);

        expect(await client.getRunStoreSummary(runStoreKey)).toEqual({ key: runStoreKey, collections: [] });
      });

      it('create on an existing store clears it (idempotent)', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'records', [{ key: 'a', body: '{}' }]);

        await client.createOrClearRunStore(runStoreKey);
        await client.createOrClearRunStore(runStoreKey);

        expect(await client.getRunStoreSummary(runStoreKey)).toEqual({ key: runStoreKey, collections: [] });
        expect(await allKeys(runStoreKey, 'records')).toEqual([]);
      });

      it('delete removes the store and is idempotent', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'records', [{ key: 'a' }]);

        await client.deleteRunStore(runStoreKey);
        await client.deleteRunStore(runStoreKey);

        expect(await client.getRunStoreSummary(runStoreKey)).toBeNull();
        await expect(settle(() => client.putEntries(runStoreKey, 'records', [{ key: 'b' }]))).rejects.toBeInstanceOf(
          RunStoreNotFoundError,
        );
      });

      it('deleting a store that never existed succeeds', async () => {
        await expect(client.deleteRunStore(uniqueRunStoreKey())).resolves.toBeUndefined();
      });

      it('every store-scoped operation throws RunStoreNotFoundError on a missing store', async () => {
        const runStoreKey = uniqueRunStoreKey();
        const operations: Array<[string, () => Promise<unknown>]> = [
          ['putEntries', () => client.putEntries(runStoreKey, 'c', [{ key: 'a' }])],
          ['readEntriesPage', () => client.readEntriesPage(runStoreKey, 'c', { includeBodies: true })],
          ['readEntriesByKeys', () => client.readEntriesByKeys(runStoreKey, 'c', ['a'], { includeBodies: false })],
          ['patchEntryMeta', () => client.patchEntryMeta(runStoreKey, 'c', [{ key: 'a', metaPatch: { x: 1 } }])],
          ['mergeCollectionInto', () => client.mergeCollectionInto(runStoreKey, 'c', 'd')],
          ['deleteCollection', () => client.deleteCollection(runStoreKey, 'c')],
        ];
        for (const [operationName, operation] of operations) {
          await expect(settle(operation)).rejects.toThrow(RunStoreNotFoundError);
          // The failed write must not have created the store.
          expect({ operationName, summary: await client.getRunStoreSummary(runStoreKey) }).toEqual({
            operationName,
            summary: null,
          });
        }
      });
    });

    describe('summary', () => {
      it('lists non-empty collections by name with entry counts and UTF-8 body bytes', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'source:Products', [
          { key: 'a', body: 'abc' },
          { key: 'b', body: 'é' }, // 2 bytes in UTF-8
          { key: 'c' },
        ]);
        await client.putEntries(runStoreKey, 'destination:Products', [{ key: 'x', body: '😀' }]); // 4 bytes
        await client.putEntries(runStoreKey, 'emptied', [{ key: 'gone' }]);
        await client.deleteCollection(runStoreKey, 'emptied');

        expect(await client.getRunStoreSummary(runStoreKey)).toEqual({
          key: runStoreKey,
          collections: [
            { collection: 'destination:Products', entryCount: 1, bodyBytes: 4 },
            { collection: 'source:Products', entryCount: 3, bodyBytes: 5 },
          ],
        });
      });
    });

    describe('putEntries', () => {
      it('inserts entries with defaults: meta {} and body null', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'records', [
          { key: 'full', meta: { op: 'create', nested: { list: [1, 'two', null], flag: true } }, body: '{"id":1}' },
          { key: 'no-meta-no-body' },
          { key: 'null-body', meta: { deleted: true }, body: null },
          { key: 'empty-body', body: '' },
        ]);

        const page = await client.readEntriesPage(runStoreKey, 'records', { includeBodies: true });

        expect(page).toEqual({
          entries: [
            { key: 'empty-body', meta: {}, body: '' },
            { key: 'full', meta: { op: 'create', nested: { list: [1, 'two', null], flag: true } }, body: '{"id":1}' },
            { key: 'no-meta-no-body', meta: {}, body: null },
            { key: 'null-body', meta: { deleted: true }, body: null },
          ],
          nextAfterKey: null,
        });
      });

      it('replaces the whole entry (meta and body) for an existing key', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'records', [{ key: 'a', meta: { old: 1, keep: 2 }, body: 'old' }]);

        await client.putEntries(runStoreKey, 'records', [{ key: 'a', meta: { new: 1 } }]);

        const { entries } = await client.readEntriesByKeys(runStoreKey, 'records', ['a'], { includeBodies: true });
        expect(entries).toEqual([{ key: 'a', meta: { new: 1 }, body: null }]);
      });

      it('later duplicates in one call win', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'records', [
          { key: 'a', body: 'first' },
          { key: 'a', body: 'second' },
        ]);

        const { entries } = await client.readEntriesByKeys(runStoreKey, 'records', ['a'], { includeBodies: true });
        expect(entries).toEqual([{ key: 'a', meta: {}, body: 'second' }]);
      });

      it('keeps collections separate', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'one', [{ key: 'a', body: '1' }]);
        await client.putEntries(runStoreKey, 'two', [{ key: 'a', body: '2' }]);

        expect((await client.readEntriesByKeys(runStoreKey, 'one', ['a'], { includeBodies: true })).entries).toEqual([
          { key: 'a', meta: {}, body: '1' },
        ]);
        expect((await client.readEntriesByKeys(runStoreKey, 'two', ['a'], { includeBodies: true })).entries).toEqual([
          { key: 'a', meta: {}, body: '2' },
        ]);
      });

      it('round-trips large bodies and many entries (bulk batches)', async () => {
        const runStoreKey = await createFreshRunStore();
        const largeBody = JSON.stringify({ text: 'x'.repeat(200_000), unicode: 'é😀' });
        const entries: RunStoreEntryToPut[] = Array.from({ length: RUN_STORE_BULK_PAGE_SIZE + 7 }, (_, index) => ({
          key: `rec${String(index).padStart(6, '0')}`,
          meta: { index },
          body: index === 3 ? largeBody : `{"i":${index}}`,
        }));

        await putRunStoreEntriesInBatches(client, runStoreKey, 'records', entries);

        expect(await allKeys(runStoreKey, 'records')).toEqual(entries.map((entry) => entry.key));
        const { entries: largeEntries } = await client.readEntriesByKeys(runStoreKey, 'records', ['rec000003'], {
          includeBodies: true,
        });
        expect(largeEntries[0]?.body).toBe(largeBody);
      });
    });

    describe('readEntriesPage', () => {
      // Code point (= UTF-8 byte) order. JavaScript's default sort would put '😀' (a surrogate pair)
      // before '￿'.
      const keysInStoreOrder = ['', ' ', 'B', 'a', 'a b', 'a/b', 'aa', 'b', 'é', '￿', '😀'];

      async function storeWithOrderingKeys(): Promise<RunStoreKey> {
        const runStoreKey = await createFreshRunStore();
        const shuffledKeys = [...keysInStoreOrder].reverse();
        await client.putEntries(
          runStoreKey,
          'records',
          shuffledKeys.map((key) => ({ key, meta: { key }, body: `body of ${key}` })),
        );
        return runStoreKey;
      }

      it('compareRunStoreKeys is code point order', () => {
        expect([...keysInStoreOrder].reverse().sort(compareRunStoreKeys)).toEqual(keysInStoreOrder);
        expect(compareRunStoreKeys('a', 'a')).toBe(0);
        expect(compareRunStoreKeys('a', 'ab')).toBeLessThan(0);
        expect(compareRunStoreKeys('￿', '😀')).toBeLessThan(0);
      });

      it('returns entries in ascending code point (UTF-8 byte) order', async () => {
        const runStoreKey = await storeWithOrderingKeys();

        const page = await client.readEntriesPage(runStoreKey, 'records', { includeBodies: false });

        expect(page.entries.map((entry) => entry.key)).toEqual(keysInStoreOrder);
        expect(page.nextAfterKey).toBeNull();
      });

      it('pages with an exclusive afterKey cursor and a limit', async () => {
        const runStoreKey = await storeWithOrderingKeys();

        const firstPage = await client.readEntriesPage(runStoreKey, 'records', { limit: 4, includeBodies: true });
        expect(firstPage.entries.map((entry) => entry.key)).toEqual(keysInStoreOrder.slice(0, 4));
        expect(firstPage.nextAfterKey).toBe(keysInStoreOrder[3]);
        expect(firstPage.entries[1]).toEqual({ key: ' ', meta: { key: ' ' }, body: 'body of  ' });

        const secondPage = await client.readEntriesPage(runStoreKey, 'records', {
          afterKey: firstPage.nextAfterKey,
          limit: 4,
          includeBodies: true,
        });
        expect(secondPage.entries.map((entry) => entry.key)).toEqual(keysInStoreOrder.slice(4, 8));

        const lastPage = await client.readEntriesPage(runStoreKey, 'records', {
          afterKey: secondPage.nextAfterKey,
          limit: 4,
          includeBodies: true,
        });
        expect(lastPage.entries.map((entry) => entry.key)).toEqual(keysInStoreOrder.slice(8));
        expect(lastPage.nextAfterKey).toBeNull();
      });

      it('has no next cursor when a page ends exactly at the last entry', async () => {
        const runStoreKey = await storeWithOrderingKeys();

        const page = await client.readEntriesPage(runStoreKey, 'records', {
          limit: keysInStoreOrder.length,
          includeBodies: false,
        });

        expect(page.entries).toHaveLength(keysInStoreOrder.length);
        expect(page.nextAfterKey).toBeNull();
      });

      it('treats afterKey "" as a real cursor (excludes the "" key) and null as the start', async () => {
        const runStoreKey = await storeWithOrderingKeys();

        const afterEmpty = await client.readEntriesPage(runStoreKey, 'records', { afterKey: '', includeBodies: false });
        const fromStart = await client.readEntriesPage(runStoreKey, 'records', {
          afterKey: null,
          includeBodies: false,
        });

        expect(afterEmpty.entries.map((entry) => entry.key)).toEqual(keysInStoreOrder.slice(1));
        expect(fromStart.entries.map((entry) => entry.key)).toEqual(keysInStoreOrder);
      });

      it('accepts an afterKey that is not a stored key, including astral characters', async () => {
        const runStoreKey = await storeWithOrderingKeys();

        const afterAb = await client.readEntriesPage(runStoreKey, 'records', { afterKey: 'a0', includeBodies: false });
        const afterFfff = await client.readEntriesPage(runStoreKey, 'records', {
          afterKey: '￿',
          includeBodies: false,
        });

        expect(afterAb.entries.map((entry) => entry.key)).toEqual(['aa', 'b', 'é', '￿', '😀']);
        expect(afterFfff.entries.map((entry) => entry.key)).toEqual(['😀']);
      });

      it('omits body entirely when includeBodies is false, and returns null for a missing body when true', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'records', [{ key: 'with', body: 'b' }, { key: 'without' }]);

        const withoutBodies = await client.readEntriesPage(runStoreKey, 'records', { includeBodies: false });
        const withBodies = await client.readEntriesPage(runStoreKey, 'records', { includeBodies: true });

        expect(withoutBodies.entries).toEqual([
          { key: 'with', meta: {} },
          { key: 'without', meta: {} },
        ]);
        expect(withoutBodies.entries.every((entry) => !('body' in entry))).toBe(true);
        expect(withBodies.entries).toEqual([
          { key: 'with', meta: {}, body: 'b' },
          { key: 'without', meta: {}, body: null },
        ]);
      });

      it('returns an empty page for a missing collection', async () => {
        const runStoreKey = await createFreshRunStore();

        expect(await client.readEntriesPage(runStoreKey, 'never-written', { includeBodies: true })).toEqual({
          entries: [],
          nextAfterKey: null,
        });
      });

      it('defaults to a page of 1000', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(
          runStoreKey,
          'records',
          Array.from({ length: 1001 }, (_, index) => ({ key: `k${String(index).padStart(4, '0')}` })),
        );

        const page = await client.readEntriesPage(runStoreKey, 'records', { includeBodies: false });

        expect(page.entries).toHaveLength(1000);
        expect(page.nextAfterKey).toBe('k0999');
      });

      it(`refuses a limit below 1 or above ${RUN_STORE_MAX_PAGE_LIMIT}`, async () => {
        const runStoreKey = await createFreshRunStore();

        for (const limit of [0, RUN_STORE_MAX_PAGE_LIMIT + 1]) {
          const rejection = settle(() =>
            client.readEntriesPage(runStoreKey, 'records', { limit, includeBodies: false }),
          );
          await expect(rejection).rejects.toThrow();
          await expect(rejection).rejects.not.toBeInstanceOf(RunStoreNotFoundError);
        }
        await expect(
          client.readEntriesPage(runStoreKey, 'records', { limit: RUN_STORE_MAX_PAGE_LIMIT, includeBodies: false }),
        ).resolves.toEqual({ entries: [], nextAfterKey: null });
      });
    });

    describe('readEntriesByKeys', () => {
      it('returns entries in request order (duplicates repeat) and lists missing keys', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'records', [
          { key: 'a', meta: { n: 1 }, body: 'A' },
          { key: 'b', meta: { n: 2 } },
        ]);

        const result = await client.readEntriesByKeys(
          runStoreKey,
          'records',
          ['b', 'missing-1', 'a', 'b', 'missing-2'],
          {
            includeBodies: true,
          },
        );

        expect(result).toEqual({
          entries: [
            { key: 'b', meta: { n: 2 }, body: null },
            { key: 'a', meta: { n: 1 }, body: 'A' },
            { key: 'b', meta: { n: 2 }, body: null },
          ],
          missingKeys: ['missing-1', 'missing-2'],
        });
      });

      it('omits bodies when includeBodies is false', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'records', [{ key: 'a', meta: { n: 1 }, body: 'A' }]);

        const result = await client.readEntriesByKeys(runStoreKey, 'records', ['a'], { includeBodies: false });

        expect(result).toEqual({ entries: [{ key: 'a', meta: { n: 1 } }], missingKeys: [] });
        expect('body' in (result.entries[0] ?? {})).toBe(false);
      });

      it('reports every key missing for a missing collection, and handles an empty key list', async () => {
        const runStoreKey = await createFreshRunStore();

        expect(await client.readEntriesByKeys(runStoreKey, 'nothing', ['x', 'y'], { includeBodies: true })).toEqual({
          entries: [],
          missingKeys: ['x', 'y'],
        });
        expect(await client.readEntriesByKeys(runStoreKey, 'nothing', [], { includeBodies: true })).toEqual({
          entries: [],
          missingKeys: [],
        });
      });

      it(`refuses more than ${RUN_STORE_MAX_KEYS_PER_READ} keys`, async () => {
        const runStoreKey = await createFreshRunStore();
        const tooManyKeys = Array.from({ length: RUN_STORE_MAX_KEYS_PER_READ + 1 }, (_, index) => `k${index}`);

        const rejection = settle(() =>
          client.readEntriesByKeys(runStoreKey, 'records', tooManyKeys, { includeBodies: false }),
        );
        await expect(rejection).rejects.toThrow();
        await expect(rejection).rejects.not.toBeInstanceOf(RunStoreNotFoundError);
      });
    });

    describe('patchEntryMeta', () => {
      it('shallow-merges, removes fields set to null, replaces nested objects wholesale, keeps the body', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'plan', [
          {
            key: 'op1',
            meta: { status: 'pending', error: 'stale', nested: { x: 1, y: 2 }, untouched: [1, 2] },
            body: '{"payload":true}',
          },
          { key: 'op2', meta: {} },
        ]);

        const result = await client.patchEntryMeta(runStoreKey, 'plan', [
          { key: 'op1', metaPatch: { status: 'success', error: null, nested: { x: 9 }, added: 'yes' } },
          { key: 'nope', metaPatch: { status: 'failed' } },
          { key: 'op2', metaPatch: { status: 'failed', error: 'boom' } },
        ]);

        expect(result).toEqual({ missingKeys: ['nope'] });
        const { entries } = await client.readEntriesByKeys(runStoreKey, 'plan', ['op1', 'op2'], {
          includeBodies: true,
        });
        expect(entries).toEqual([
          {
            key: 'op1',
            meta: { status: 'success', nested: { x: 9 }, untouched: [1, 2], added: 'yes' },
            body: '{"payload":true}',
          },
          { key: 'op2', meta: { status: 'failed', error: 'boom' }, body: null },
        ]);
      });

      it('applies patches to the same key in order', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'plan', [{ key: 'a', meta: { n: 0 } }]);

        await client.patchEntryMeta(runStoreKey, 'plan', [
          { key: 'a', metaPatch: { n: 1, temp: true } },
          { key: 'a', metaPatch: { n: 2, temp: null } },
        ]);

        const { entries } = await client.readEntriesByKeys(runStoreKey, 'plan', ['a'], { includeBodies: false });
        expect(entries).toEqual([{ key: 'a', meta: { n: 2 } }]);
      });

      it('reports every key missing in a missing collection, and accepts an empty patch list', async () => {
        const runStoreKey = await createFreshRunStore();

        expect(await client.patchEntryMeta(runStoreKey, 'nothing', [{ key: 'a', metaPatch: { x: 1 } }])).toEqual({
          missingKeys: ['a'],
        });
        expect(await client.patchEntryMeta(runStoreKey, 'nothing', [])).toEqual({ missingKeys: [] });
      });
    });

    describe('mergeCollectionInto', () => {
      it('moves every entry, replacing same-key entries wholesale, and empties the source', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'staging', [
          { key: 'a', meta: { from: 'staging' }, body: 'new-a' },
          { key: 'c', body: 'c' },
        ]);
        await client.putEntries(runStoreKey, 'final', [
          { key: 'a', meta: { from: 'final', extra: 1 }, body: 'old-a' },
          { key: 'b', body: 'b' },
        ]);

        const moved = await client.mergeCollectionInto(runStoreKey, 'staging', 'final');

        expect(moved).toBe(2);
        const page = await client.readEntriesPage(runStoreKey, 'final', { includeBodies: true });
        expect(page.entries).toEqual([
          { key: 'a', meta: { from: 'staging' }, body: 'new-a' },
          { key: 'b', meta: {}, body: 'b' },
          { key: 'c', meta: {}, body: 'c' },
        ]);
        expect(await allKeys(runStoreKey, 'staging')).toEqual([]);
        expect((await client.getRunStoreSummary(runStoreKey))?.collections).toEqual([
          { collection: 'final', entryCount: 3, bodyBytes: 7 },
        ]);
      });

      it('creates the target collection when it did not exist', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'staging', [{ key: 'a', body: 'x' }]);

        expect(await client.mergeCollectionInto(runStoreKey, 'staging', 'brand-new')).toBe(1);
        expect(await allKeys(runStoreKey, 'brand-new')).toEqual(['a']);
      });

      it('is a no-op returning 0 for an empty or missing source collection', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'final', [{ key: 'a' }]);

        expect(await client.mergeCollectionInto(runStoreKey, 'missing', 'final')).toBe(0);
        expect(await allKeys(runStoreKey, 'final')).toEqual(['a']);
      });

      it('refuses to merge a collection into itself', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'final', [{ key: 'a' }]);

        const rejection = settle(() => client.mergeCollectionInto(runStoreKey, 'final', 'final'));
        await expect(rejection).rejects.toThrow();
        await expect(rejection).rejects.not.toBeInstanceOf(RunStoreNotFoundError);
        expect(await allKeys(runStoreKey, 'final')).toEqual(['a']);
      });
    });

    describe('deleteCollection', () => {
      it('removes only that collection; removing a missing collection succeeds', async () => {
        const runStoreKey = await createFreshRunStore();
        await client.putEntries(runStoreKey, 'a', [{ key: '1' }, { key: '2' }]);
        await client.putEntries(runStoreKey, 'b', [{ key: '1' }]);

        await client.deleteCollection(runStoreKey, 'a');
        await client.deleteCollection(runStoreKey, 'a');
        await client.deleteCollection(runStoreKey, 'never-existed');

        expect(await allKeys(runStoreKey, 'a')).toEqual([]);
        expect(await allKeys(runStoreKey, 'b')).toEqual(['1']);
      });
    });

    describe('keys and collection names', () => {
      it('round-trips arbitrary UTF-8 keys through every operation', async () => {
        const runStoreKey = await createFreshRunStore();
        const awkwardKeys = [
          'Products/sub folder/record 1.json',
          'q?x=1&y=2#frag',
          '100% "quoted" \\ back\\slash',
          'tab\tnew\nline',
          'ünïcödé/日本語.json',
          '😀/emoji.json',
          '+plus+ and %2F literal',
        ];
        await client.putEntries(
          runStoreKey,
          'source:Products.v1',
          awkwardKeys.map((key) => ({ key, meta: { original: key }, body: key })),
        );

        expect(await allKeys(runStoreKey, 'source:Products.v1')).toEqual([...awkwardKeys].sort(compareRunStoreKeys));

        const byKeys = await client.readEntriesByKeys(runStoreKey, 'source:Products.v1', awkwardKeys, {
          includeBodies: true,
        });
        expect(byKeys.missingKeys).toEqual([]);
        expect(byKeys.entries.map((entry) => [entry.key, entry.meta.original, entry.body])).toEqual(
          awkwardKeys.map((key) => [key, key, key]),
        );

        const { missingKeys } = await client.patchEntryMeta(
          runStoreKey,
          'source:Products.v1',
          awkwardKeys.map((key) => ({ key, metaPatch: { patched: true } })),
        );
        expect(missingKeys).toEqual([]);

        // Every awkward key works as a cursor.
        const sortedKeys = [...awkwardKeys].sort(compareRunStoreKeys);
        for (let index = 0; index < sortedKeys.length; index += 1) {
          const page = await client.readEntriesPage(runStoreKey, 'source:Products.v1', {
            afterKey: sortedKeys[index],
            includeBodies: false,
          });
          expect(page.entries.map((entry) => entry.key)).toEqual(sortedKeys.slice(index + 1));
        }
      });
    });
  });
}
