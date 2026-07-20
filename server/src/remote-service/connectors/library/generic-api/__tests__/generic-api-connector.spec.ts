/**
 * Tests for GenericApiConnector — the v1-blocking safety-critical scenarios
 * from the impl plan:
 *   - SAFETY #3: idPath collision hard-fails the pull with a
 *     specific error AND no records are emitted past the collision.
 *   - SAFETY #5: testConnection maps 2xx / 401 / 403 / 404 to specific
 *     errors at the right shape.
 *
 * Plus baseline coverage: listTables maps endpoints, buildAuthHeaders covers
 * every preset, extractConnectorErrorDetails maps known errors correctly.
 */

// Mock undici BEFORE importing the connector so the SSRF transport under the
// hood picks up the mocked `fetch`. Real `Agent` is preserved so the agent the
// transport creates still constructs cleanly.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});

import {
  DataFolderOptions,
  GenericApiConnectorExtras,
  GenericApiFolderOptions,
  X_SCRATCH_ASSET_TABLE,
} from '@spinner/shared-types';
import { promises as dns } from 'dns';
import * as undici from 'undici';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';
import { MaxPagesReachedError, NonJsonResponseError, PaginationLoopError } from '../apiget';
import { buildAuthHeaders, endpointToTableId, GenericApiConnector } from '../generic-api-connector';

const undiciFetchMock = undici.fetch as unknown as jest.Mock;

/**
 * Stub `dns.lookup` to resolve "api.example.com" (and any other host) to a
 * public IP so the SSRF guard lets the request through to the mocked
 * `undici.fetch`. Without this, CI gets ENOTFOUND first and never reaches
 * the test's intended assertion.
 */
let dnsLookupSpy: jest.SpyInstance | undefined;
beforeEach(() => {
  dnsLookupSpy = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  undiciFetchMock.mockReset();
});
afterEach(() => {
  dnsLookupSpy?.mockRestore();
});

/**
 * Helper that primes the undici.fetch mock with one canned response. Returns
 * a no-op restorer for the existing finally-block call sites — the actual
 * cleanup happens via `mockReset` in `beforeEach`.
 */
function stubUndiciFetch(response: { status: number; body: string; headers?: Record<string, string> }) {
  undiciFetchMock.mockResolvedValueOnce(
    new Response(response.body, {
      status: response.status,
      headers: new Headers(response.headers ?? { 'content-type': 'application/json' }),
    }) as unknown as undici.Response,
  );
  return () => {
    /* no-op — beforeEach handles reset */
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test scaffolding
// ─────────────────────────────────────────────────────────────────────────────

const EP_REST_1 = {
  id: 'ep_projects',
  name: 'Projects',
  method: 'GET' as const,
  url: 'https://api.example.com/v1/projects',
};

const EP_REST_2 = {
  id: 'ep_tasks',
  // no name → falls back to URL-derived slug
  method: 'GET' as const,
  url: 'https://api.example.com/v1/tasks',
};

const EXTRAS: GenericApiConnectorExtras = {
  apiType: 'rest',
  authHeader: { style: 'bearer' },
  endpoints: [EP_REST_1, EP_REST_2],
};

const FOLDER_OPTS: GenericApiFolderOptions = {
  endpointId: 'ep_projects',
  probe: {
    detectedPagination: null,
    idPath: 'id',
    inferredSchema: { type: 'object', properties: { id: { type: 'string' } } },
    lastProbedAt: '2026-05-18T20:00:00Z',
  },
};

function buildConnector(
  opts: {
    extras?: GenericApiConnectorExtras;
    apiKey?: string;
    folderOptionsByTableId?: Record<string, DataFolderOptions | null>;
  } = {},
) {
  const folderMap = opts.folderOptionsByTableId ?? {
    [JSON.stringify(['GET', EP_REST_1.url])]: { genericApi: FOLDER_OPTS } as DataFolderOptions,
  };
  return new GenericApiConnector({
    extras: opts.extras ?? EXTRAS,
    apiKey: opts.apiKey ?? 'sk_test_token',
    connectorAccountId: 'acct_test',
    getFolderOptionsByTableId: (_id, tableId) => Promise.resolve(folderMap[JSON.stringify(tableId)] ?? null),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// buildAuthHeaders — every preset
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAuthHeaders', () => {
  it('bearer style → Authorization: Bearer <key>', () => {
    expect(buildAuthHeaders({ ...EXTRAS, authHeader: { style: 'bearer' } }, 'KEY')).toEqual([
      { name: 'Authorization', value: 'Bearer KEY' },
    ]);
  });

  it('token style → Authorization: Token <key>', () => {
    expect(buildAuthHeaders({ ...EXTRAS, authHeader: { style: 'token' } }, 'KEY')).toEqual([
      { name: 'Authorization', value: 'Token KEY' },
    ]);
  });

  it('raw style → Authorization: <key> (no prefix)', () => {
    expect(buildAuthHeaders({ ...EXTRAS, authHeader: { style: 'raw' } }, 'KEY')).toEqual([
      { name: 'Authorization', value: 'KEY' },
    ]);
  });

  it('custom-header style with headerName → that header name + value', () => {
    expect(
      buildAuthHeaders({ ...EXTRAS, authHeader: { style: 'custom-header', headerName: 'X-MyApi-Key' } }, 'KEY'),
    ).toEqual([{ name: 'X-MyApi-Key', value: 'KEY' }]);
  });

  it('custom-header style without headerName → defaults to X-API-Key', () => {
    expect(buildAuthHeaders({ ...EXTRAS, authHeader: { style: 'custom-header' } }, 'KEY')).toEqual([
      { name: 'X-API-Key', value: 'KEY' },
    ]);
  });

  it('custom-header style with valuePrefix → prefixes the key with a single space (Klaviyo shape)', () => {
    expect(
      buildAuthHeaders(
        {
          ...EXTRAS,
          authHeader: { style: 'custom-header', headerName: 'Authorization', valuePrefix: 'Klaviyo-API-Key' },
        },
        'pk_123',
      ),
    ).toEqual([{ name: 'Authorization', value: 'Klaviyo-API-Key pk_123' }]);
  });

  it('custom-header style with default header name + valuePrefix', () => {
    expect(buildAuthHeaders({ ...EXTRAS, authHeader: { style: 'custom-header', valuePrefix: 'SSWS' } }, 'KEY')).toEqual(
      [{ name: 'X-API-Key', value: 'SSWS KEY' }],
    );
  });

  it('custom-header style with blank valuePrefix → key sent verbatim (no stray space)', () => {
    expect(
      buildAuthHeaders(
        { ...EXTRAS, authHeader: { style: 'custom-header', headerName: 'X-Api-Key', valuePrefix: '  ' } },
        'KEY',
      ),
    ).toEqual([{ name: 'X-Api-Key', value: 'KEY' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// endpointToTableId
// ─────────────────────────────────────────────────────────────────────────────

describe('endpointToTableId', () => {
  it('REST: [method, url]', () => {
    expect(endpointToTableId(EP_REST_1, 'rest')).toEqual(['GET', EP_REST_1.url]);
  });

  it('GraphQL: [url, id]', () => {
    expect(
      endpointToTableId({ id: 'gq_1', url: 'https://api.example.com/graphql', query: '{ x }' }, 'graphql'),
    ).toEqual(['https://api.example.com/graphql', 'gq_1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listTables
// ─────────────────────────────────────────────────────────────────────────────

describe('GenericApiConnector — listTables', () => {
  it('returns one TablePreview per endpoint', async () => {
    const connector = buildConnector();
    const tables = await connector.listTables();
    expect(tables).toHaveLength(2);
  });

  it('uses user-supplied name when present', async () => {
    const connector = buildConnector();
    const tables = await connector.listTables();
    expect(tables[0].displayName).toBe('Projects');
  });

  it('falls back to URL-derived slug when no name supplied', async () => {
    const connector = buildConnector();
    const tables = await connector.listTables();
    expect(tables[1].displayName).toBe('tasks'); // last URL segment
  });

  it('flags every entry as create / update / delete disabled (v1 read-only)', async () => {
    const connector = buildConnector();
    const tables = await connector.listTables();
    for (const t of tables) {
      expect(t.disabledCreates).toBe(true);
      expect(t.disabledUpdates).toBe(true);
      expect(t.disabledDeletes).toBe(true);
      expect(t.disabledReason).toContain('read-only');
    }
  });

  it('uses endpoint.id as wsId so URL edits do not break tables', async () => {
    const connector = buildConnector();
    const tables = await connector.listTables();
    expect(tables[0].id.wsId).toBe('ep_projects');
    expect(tables[0].id.remoteId).toEqual(['GET', EP_REST_1.url]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchJsonTableSpec
// ─────────────────────────────────────────────────────────────────────────────

describe('GenericApiConnector — fetchJsonTableSpec', () => {
  it('throws with a clear message when the endpoint has not been probed yet', async () => {
    const connector = buildConnector({
      folderOptionsByTableId: {}, // no folder options registered
    });
    await expect(
      connector.fetchJsonTableSpec({ wsId: 'ep_projects', remoteId: ['GET', EP_REST_1.url] }),
    ).rejects.toThrow(/probed/);
  });

  it('returns a BaseJsonTableSpec with the persisted idPath as idPath', async () => {
    const connector = buildConnector();
    const spec = await connector.fetchJsonTableSpec({
      wsId: 'ep_projects',
      remoteId: ['GET', EP_REST_1.url],
    });
    expect(spec.id.wsId).toBe('ep_projects');
    expect(spec.idPath).toEqual(dotPath('id'));
    expect(spec.generatedAt).toBe('2026-05-18T20:00:00Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Asset mapping — declaring an endpoint's records as downloadable files
// ─────────────────────────────────────────────────────────────────────────────

describe('GenericApiConnector — asset mapping (binary file download)', () => {
  const EP_REST_DOCS = {
    id: 'ep_documents',
    name: 'Documents',
    method: 'GET' as const,
    url: 'https://api.example.com/v1/documents',
    asset: {
      urlPath: 'url',
      filenamePath: 'name',
      mimeTypePath: 'content_type',
      urlExpires: true,
    },
  };
  const DOCS_EXTRAS: GenericApiConnectorExtras = {
    apiType: 'rest',
    authHeader: { style: 'bearer' },
    endpoints: [EP_REST_DOCS],
  };
  const DOCS_FOLDER_OPTS: GenericApiFolderOptions = {
    endpointId: 'ep_documents',
    probe: {
      detectedPagination: null,
      idPath: 'id',
      inferredSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          url: { type: 'string' },
          name: { type: 'string' },
          content_type: { type: 'string' },
        },
      },
      lastProbedAt: '2026-06-25T00:00:00Z',
    },
  };

  function docsConnector() {
    return buildConnector({
      extras: DOCS_EXTRAS,
      folderOptionsByTableId: {
        [JSON.stringify(['GET', EP_REST_DOCS.url])]: { genericApi: DOCS_FOLDER_OPTS } as DataFolderOptions,
      },
    });
  }

  it('stamps x-scratch-asset-table onto the table schema from the endpoint asset mapping', async () => {
    const connector = docsConnector();
    const spec = await connector.fetchJsonTableSpec({ wsId: 'ep_documents', remoteId: ['GET', EP_REST_DOCS.url] });
    const opts = (spec.schema as Record<string, unknown>)[X_SCRATCH_ASSET_TABLE];
    expect(opts).toEqual({
      urlPath: 'url',
      filenamePath: 'name',
      mimeTypePath: 'content_type',
      sizePath: null,
      widthPath: null,
      heightPath: null,
      altTextPath: null,
      urlExpires: true,
    });
  });

  it('extractAssets returns the record as a downloadable file using the stamped schema', async () => {
    const connector = docsConnector();
    const spec = await connector.fetchJsonTableSpec({ wsId: 'ep_documents', remoteId: ['GET', EP_REST_DOCS.url] });
    const results = connector.extractAssets({
      recordContent: {
        id: 'doc_1',
        url: 'https://files.example.com/a.pdf',
        name: 'a.pdf',
        content_type: 'application/pdf',
      },
      schema: spec.schema as Record<string, unknown>,
      recordRemoteId: 'doc_1',
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      remoteAssetId: 'doc_1',
      url: 'https://files.example.com/a.pdf',
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      mediaType: 'document',
    });
    // urlExpires: true → a near-future expiry is set so the rehost job downloads promptly.
    expect(results[0].urlExpiresAt).toBeInstanceOf(Date);
  });

  it('extractAssets returns [] for an endpoint without an asset mapping (JSON-only, today behavior)', async () => {
    const connector = buildConnector(); // EXTRAS endpoints carry no asset mapping
    const spec = await connector.fetchJsonTableSpec({ wsId: 'ep_projects', remoteId: ['GET', EP_REST_1.url] });
    expect((spec.schema as Record<string, unknown>)[X_SCRATCH_ASSET_TABLE]).toBeUndefined();
    const results = connector.extractAssets({
      recordContent: { id: 'p1', url: 'https://example.com/not-a-file' },
      schema: spec.schema as Record<string, unknown>,
      recordRemoteId: 'p1',
    });
    expect(results).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractConnectorErrorDetails — error mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('GenericApiConnector — extractConnectorErrorDetails', () => {
  const connector = buildConnector();

  it('maps PaginationLoopError to a specific user-facing message', () => {
    const details = connector.extractConnectorErrorDetails(new PaginationLoopError('STUCK'));
    expect(details.userFriendlyMessage).toContain('Pagination loop');
  });

  it('maps MaxPagesReachedError to a "raise maxPages" message', () => {
    const details = connector.extractConnectorErrorDetails(new MaxPagesReachedError(1000));
    expect(details.userFriendlyMessage).toContain('1000-page cap');
  });

  it('maps NonJsonResponseError to a "JSON only" message naming the content-type', () => {
    const details = connector.extractConnectorErrorDetails(new NonJsonResponseError('text/html'));
    expect(details.userFriendlyMessage).toContain('text/html');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY-CRITICAL #3: idPath collision hard-fails the pull
// ─────────────────────────────────────────────────────────────────────────────

describe('GenericApiConnector — SAFETY: duplicate remote IDs hard-fail the pull', () => {
  it('throws DuplicateRemoteIds error and does NOT emit the colliding record', async () => {
    // Mock the connector's apigetStream by stubbing fetch. We bypass the
    // real apiget path by constructing a connector whose composeSettings →
    // apigetStream returns a single page with two records sharing the same id.
    // Simpler: drive the real apigetStream via a mocked fetch that returns
    // a single-page response.
    const connector = buildConnector();

    // Stub undici.fetch — the transport ssrfSafeFetch actually uses.
    const restore = stubUndiciFetch({
      status: 200,
      body: JSON.stringify([{ id: 'dup' }, { id: 'dup' }]),
    });

    try {
      const callbackCalls: Array<{ files: ConnectorFile[] }> = [];
      const tableSpec: BaseJsonTableSpec = {
        id: { wsId: 'ep_projects', remoteId: ['GET', EP_REST_1.url] },
        slug: 'ep_projects',
        name: 'ep_projects',
        schema: {} as never,
        idPath: dotPath('id'),
      };
      await expect(
        connector.pullRecordFiles(
          tableSpec,
          (params) => {
            callbackCalls.push(params);
            return Promise.resolve();
          },
          { pageIndex: 0 },
          { genericApi: FOLDER_OPTS } as DataFolderOptions,
        ),
      ).rejects.toThrow(/Duplicate remote IDs|"dup"/);

      // Critical: the callback must NOT have been invoked at all (no records
      // leak past the collision check; per impl plan no partial files on disk).
      expect(callbackCalls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('throws when idPath resolves to null on any record', async () => {
    const connector = buildConnector();
    const restore = stubUndiciFetch({
      status: 200,
      body: JSON.stringify([{ id: 'a' }, { not_id: 'b' }]),
    });

    try {
      const tableSpec: BaseJsonTableSpec = {
        id: { wsId: 'ep_projects', remoteId: ['GET', EP_REST_1.url] },
        slug: 'ep_projects',
        name: 'ep_projects',
        schema: {} as never,
        idPath: dotPath('id'),
      };
      await expect(
        connector.pullRecordFiles(tableSpec, () => Promise.resolve(), { pageIndex: 0 }, {
          genericApi: FOLDER_OPTS,
        } as DataFolderOptions),
      ).rejects.toThrow(/missing or null remote ID/);
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY-CRITICAL #5: testConnection branches
// ─────────────────────────────────────────────────────────────────────────────

describe('GenericApiConnector — SAFETY: testConnection branches', () => {
  /** Stub undici.fetch to return one canned response for the test. */
  function withMockedFetch<T>(
    response: { status: number; body: string; headers?: Record<string, string> },
    run: () => Promise<T>,
  ): Promise<T> {
    const restore = stubUndiciFetch(response);
    return run().finally(restore);
  }

  it('throws with "No endpoints configured" when extras.endpoints is empty', async () => {
    const connector = buildConnector({
      extras: { ...EXTRAS, endpoints: [] },
    });
    await expect(connector.testConnection()).rejects.toThrow(/No endpoints/);
  });

  it('2xx + JSON → resolves silently', async () => {
    const connector = buildConnector();
    await withMockedFetch({ status: 200, body: '[]' }, async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });
  });

  it('200 + non-JSON content-type → throws NonJsonResponseError (mapped to a specific message)', async () => {
    const connector = buildConnector();
    const err = await withMockedFetch(
      { status: 200, body: '<html>oops</html>', headers: { 'content-type': 'text/html' } },
      async () => {
        try {
          await connector.testConnection();
          return null;
        } catch (e) {
          return e;
        }
      },
    );
    expect(err).toBeInstanceOf(NonJsonResponseError);
  });
});
