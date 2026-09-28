import { gunzipSync } from 'node:zlib';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import {
  createHttpRunStoreClientFromConfig,
  HttpRunStoreClient,
  RUN_STORE_PUT_REQUEST_MAX_UNCOMPRESSED_BYTES,
  RUN_STORE_REQUEST_GZIP_THRESHOLD_BYTES,
  splitEntriesIntoRequestSizedBatches,
} from '../http-run-store-client';
import { RunStoreBudgetExceededError, RunStoreNotFoundError, type RunStoreKey } from '../run-store-client';

const RUN_STORE_KEY: RunStoreKey = 'le-rrn_Unit000001';

function envelopeResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, status: { gcInProgress: null } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | string | undefined;
}

describe('HttpRunStoreClient', () => {
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
  let client: HttpRunStoreClient;
  let warnSpy: jest.SpyInstance;

  function capturedRequest(callIndex = 0): CapturedRequest {
    const call = fetchMock.mock.calls[callIndex];
    if (!call) throw new Error(`no fetch call #${callIndex}`);
    const [url, init] = call;
    return {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body as Uint8Array | string | undefined,
    };
  }

  function requestJson(request: CapturedRequest): unknown {
    if (request.body === undefined) return undefined;
    const text =
      request.headers['Content-Encoding'] === 'gzip'
        ? gunzipSync(request.body as Uint8Array).toString('utf8')
        : (request.body as string);
    return JSON.parse(text);
  }

  beforeEach(() => {
    fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
    jest
      .spyOn(global, 'fetch')
      .mockImplementation((input, init) =>
        fetchMock(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init ?? {}),
      );
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation();
    client = new HttpRunStoreClient({ scratchGitApiUrl: 'http://git:3100/', scratchGitAuthToken: 's3cret' });
  });

  afterEach(() => jest.restoreAllMocks());

  describe('requests', () => {
    it('sends small bodies as plain JSON with the auth token and Accept-Encoding: gzip', async () => {
      fetchMock.mockResolvedValue(envelopeResponse({ written: 1 }));

      await client.putEntries(RUN_STORE_KEY, 'source:Products', [{ key: 'a', meta: { n: 1 }, body: '{}' }]);

      const request = capturedRequest();
      expect(request.url).toBe(`http://git:3100/api/run-store/${RUN_STORE_KEY}/collections/source%3AProducts/entries`);
      expect(request.method).toBe('POST');
      expect(request.headers).toEqual({
        'Accept-Encoding': 'gzip',
        Authorization: 'Bearer s3cret',
        'Content-Type': 'application/json',
      });
      expect(typeof request.body).toBe('string');
      expect(requestJson(request)).toEqual({ entries: [{ key: 'a', meta: { n: 1 }, body: '{}' }] });
    });

    it(`gzips bodies of ${RUN_STORE_REQUEST_GZIP_THRESHOLD_BYTES} bytes or more`, async () => {
      fetchMock.mockResolvedValue(envelopeResponse({ written: 1 }));
      const largeBody = 'x'.repeat(RUN_STORE_REQUEST_GZIP_THRESHOLD_BYTES);

      await client.putEntries(RUN_STORE_KEY, 'records', [{ key: 'a', body: largeBody }]);

      const request = capturedRequest();
      expect(request.headers['Content-Encoding']).toBe('gzip');
      expect(request.body).toBeInstanceOf(Uint8Array);
      expect((request.body as Uint8Array).byteLength).toBeLessThan(RUN_STORE_REQUEST_GZIP_THRESHOLD_BYTES / 10);
      expect(requestJson(request)).toEqual({ entries: [{ key: 'a', body: largeBody }] });
    });

    it('splits a put that would exceed the proxy body limit into several requests, in order', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(envelopeResponse({ written: 1 })));
      const sixMegabyteBody = 'y'.repeat(6 * 1024 * 1024);
      const entries = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, body: sixMegabyteBody }));

      await client.putEntries(RUN_STORE_KEY, 'records', entries);

      const sentKeys = fetchMock.mock.calls.map((_call, index) =>
        (requestJson(capturedRequest(index)) as { entries: Array<{ key: string }> }).entries.map((entry) => entry.key),
      );
      expect(sentKeys).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    });

    it('sends no Authorization header without a token', async () => {
      client = new HttpRunStoreClient({ scratchGitApiUrl: 'http://git:3100', scratchGitAuthToken: undefined });
      fetchMock.mockResolvedValue(envelopeResponse({ deleted: true }));

      await client.deleteRunStore(RUN_STORE_KEY);

      const request = capturedRequest();
      expect(request).toMatchObject({ url: `http://git:3100/api/run-store/${RUN_STORE_KEY}`, method: 'DELETE' });
      expect(request.headers).toEqual({ 'Accept-Encoding': 'gzip' });
      expect(request.body).toBeUndefined();
    });

    it('puts the page cursor, limit and includeBodies in the query string', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(envelopeResponse({ entries: [], nextAfterKey: null })));

      await client.readEntriesPage(RUN_STORE_KEY, 'records', { afterKey: 'a/b c&d', limit: 50, includeBodies: true });
      await client.readEntriesPage(RUN_STORE_KEY, 'records', { afterKey: null, includeBodies: false });

      const withCursor = new URL(capturedRequest(0).url);
      expect(withCursor.pathname).toBe(`/api/run-store/${RUN_STORE_KEY}/collections/records/entries`);
      expect(Object.fromEntries(withCursor.searchParams)).toEqual({
        includeBodies: 'true',
        afterKey: 'a/b c&d',
        limit: '50',
      });
      expect(Object.fromEntries(new URL(capturedRequest(1).url).searchParams)).toEqual({ includeBodies: 'false' });
    });

    it('encodes both collections of a merge as path segments', async () => {
      fetchMock.mockResolvedValue(envelopeResponse({ moved: 3 }));

      await expect(client.mergeCollectionInto(RUN_STORE_KEY, 'sync:staging', 'sync:final')).resolves.toBe(3);

      expect(capturedRequest().url).toBe(
        `http://git:3100/api/run-store/${RUN_STORE_KEY}/collections/sync%3Astaging/merge-into/sync%3Afinal`,
      );
    });
  });

  describe('responses', () => {
    it('unwraps the { data, status } envelope', async () => {
      const page = { entries: [{ key: 'a', meta: { n: 1 }, body: null }], nextAfterKey: 'a' };
      fetchMock.mockResolvedValue(envelopeResponse(page));

      await expect(client.readEntriesPage(RUN_STORE_KEY, 'records', { includeBodies: true })).resolves.toEqual(page);
    });

    it('returns by-keys and patch-meta results', async () => {
      fetchMock
        .mockResolvedValueOnce(envelopeResponse({ entries: [], missingKeys: ['x'] }))
        .mockResolvedValueOnce(envelopeResponse({ missingKeys: ['y'] }));

      await expect(client.readEntriesByKeys(RUN_STORE_KEY, 'c', ['x'], { includeBodies: false })).resolves.toEqual({
        entries: [],
        missingKeys: ['x'],
      });
      await expect(client.patchEntryMeta(RUN_STORE_KEY, 'c', [{ key: 'y', metaPatch: { s: null } }])).resolves.toEqual({
        missingKeys: ['y'],
      });
      expect(requestJson(capturedRequest(0))).toEqual({ keys: ['x'], includeBodies: false });
      expect(requestJson(capturedRequest(1))).toEqual({ patches: [{ key: 'y', metaPatch: { s: null } }] });
    });
  });

  describe('errors', () => {
    const notFound = (): Response => envelopeResponse({ error: 'File not found' }, 404);

    it('maps 404 on every store-scoped call to RunStoreNotFoundError', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(notFound()));

      const storeScopedCalls: Array<() => Promise<unknown>> = [
        () => client.putEntries(RUN_STORE_KEY, 'c', [{ key: 'a' }]),
        () => client.readEntriesPage(RUN_STORE_KEY, 'c', { includeBodies: false }),
        () => client.readEntriesByKeys(RUN_STORE_KEY, 'c', ['a'], { includeBodies: false }),
        () => client.patchEntryMeta(RUN_STORE_KEY, 'c', []),
        () => client.mergeCollectionInto(RUN_STORE_KEY, 'c', 'd'),
        () => client.deleteCollection(RUN_STORE_KEY, 'c'),
      ];
      for (const call of storeScopedCalls) {
        await expect(call()).rejects.toThrow(new RunStoreNotFoundError(RUN_STORE_KEY));
      }
    });

    it('maps 404 on the summary to null', async () => {
      fetchMock.mockResolvedValue(notFound());

      await expect(client.getRunStoreSummary(RUN_STORE_KEY)).resolves.toBeNull();
    });

    it('maps 507 on create to RunStoreBudgetExceededError carrying the server message', async () => {
      const serverMessage = 'Live Export run store budget exhausted: … (GIT_LE_RUN_STORE_MAX_BYTES)';
      fetchMock.mockResolvedValue(envelopeResponse({ error: serverMessage }, 507));

      const rejection = client.createOrClearRunStore(RUN_STORE_KEY);

      await expect(rejection).rejects.toBeInstanceOf(RunStoreBudgetExceededError);
      await expect(rejection).rejects.toMatchObject({ runStoreKey: RUN_STORE_KEY, serverMessage });
    });

    it('throws an Error with the status and a truncated body for other failures', async () => {
      fetchMock.mockResolvedValue(new Response(`boom ${'y'.repeat(5000)}`, { status: 500 }));

      const rejection = client.putEntries(RUN_STORE_KEY, 'c', [{ key: 'a' }]);

      await expect(rejection).rejects.toThrow(/HTTP 500: boom y+… \(truncated\)/);
      await expect(rejection).rejects.not.toBeInstanceOf(RunStoreNotFoundError);
      await rejection.catch((error: Error) => expect(error.message.length).toBeLessThan(1300));
    });

    it('does not map 404 to not-found on create or delete', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(notFound()));

      await expect(client.createOrClearRunStore(RUN_STORE_KEY)).rejects.toThrow(/HTTP 404/);
      await expect(client.deleteRunStore(RUN_STORE_KEY)).rejects.toThrow(/HTTP 404/);
    });

    it('throws on an invalid JSON response', async () => {
      fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

      await expect(client.deleteRunStore(RUN_STORE_KEY)).rejects.toThrow(/invalid JSON response/);
    });

    it('surfaces the root cause of a connection failure', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }));

      await expect(client.deleteRunStore(RUN_STORE_KEY)).rejects.toThrow(/ECONNREFUSED/);
    });
  });

  describe('slow-call logging', () => {
    it('warns with the operation, collection, entry count and duration when a call takes over 1 s', async () => {
      let nowMs = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => {
        nowMs += 1500;
        return nowMs;
      });
      fetchMock.mockResolvedValue(envelopeResponse({ entries: [{ key: 'a', meta: {} }], nextAfterKey: null }));

      await client.readEntriesPage(RUN_STORE_KEY, 'records', { includeBodies: false });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'HttpRunStoreClient',
          operation: 'readEntriesPage',
          runStoreKey: RUN_STORE_KEY,
          collection: 'records',
          entryCount: 1,
          durationMs: 1500,
        }),
      );
    });

    it('stays quiet for fast calls', async () => {
      fetchMock.mockResolvedValue(envelopeResponse({ written: 0 }));

      await client.putEntries(RUN_STORE_KEY, 'records', []);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it('createHttpRunStoreClientFromConfig reads the ScratchGitClient settings', async () => {
    const scratchConfigService = {
      getScratchGitApiUrl: () => 'http://from-config:3100',
      getScratchGitAuthToken: () => 'config-token',
    } as unknown as ScratchConfigService;
    fetchMock.mockResolvedValue(envelopeResponse({ deleted: false }));

    await createHttpRunStoreClientFromConfig(scratchConfigService).deleteRunStore(RUN_STORE_KEY);

    expect(capturedRequest().url).toBe(`http://from-config:3100/api/run-store/${RUN_STORE_KEY}`);
    expect(capturedRequest().headers.Authorization).toBe('Bearer config-token');
  });
});

describe('splitEntriesIntoRequestSizedBatches', () => {
  it('keeps small puts in one batch and gives an oversized entry a batch of its own', () => {
    const small = [{ key: 'a', body: '{}' }, { key: 'b' }];
    expect(splitEntriesIntoRequestSizedBatches(small)).toEqual([small]);
    expect(splitEntriesIntoRequestSizedBatches([])).toEqual([]);

    const oversized = { key: 'huge', body: 'z'.repeat(RUN_STORE_PUT_REQUEST_MAX_UNCOMPRESSED_BYTES + 1) };
    expect(splitEntriesIntoRequestSizedBatches([{ key: 'a' }, oversized, { key: 'b' }])).toEqual([
      [{ key: 'a' }],
      [oversized],
      [{ key: 'b' }],
    ]);
  });
});
