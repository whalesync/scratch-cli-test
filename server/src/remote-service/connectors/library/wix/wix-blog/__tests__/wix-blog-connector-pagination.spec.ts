import { BaseJsonTableSpec, ConnectorFile, EntityId } from '../../../../types';
import { WixBlogConnector } from '../wix-blog-connector';
import { buildWixBlogJsonTableSpec } from '../wix-blog-json-schema';
import { wixBlogEntityId } from '../wix-blog-tables';

// Break the circular import chain through the connector base -> display-names
// (the same shim the ClickUp connector spec uses).
jest.mock('../../../../display-names', () => ({
  getServiceDisplayName: () => 'Wix Blog',
}));

// Mock the Wix SDK so constructing the connector performs no network I/O.
//
// Blog Posts pages by CURSOR through `queryDraftPosts`' query builder, so the mock mirrors the real
// builder: chainable `ascending`/`limit`/`skipTo`, and a `find()` returning a page that carries its
// own `cursors`/`hasNext()`/`next()`. `mockDraftPostPages` is the queue of pages `find()`/`next()`
// hand back in order.
const mockQueryDraftPosts = jest.fn<unknown, [{ fieldsets?: string[] }?]>();
const mockDraftPostsAscending = jest.fn<unknown, [string]>();
const mockDraftPostsLimit = jest.fn<unknown, [number]>();
const mockDraftPostsSkipTo = jest.fn<unknown, [string]>();

type DraftPostPage = { items: { _id: string }[]; cursors?: { next?: string | null } };
let mockDraftPostPages: DraftPostPage[] = [];
let draftPostFindCallCount = 0;

function nextDraftPostPage(): DraftPostPage & { hasNext: () => boolean; next: () => Promise<unknown> } {
  const page = mockDraftPostPages[draftPostFindCallCount++] ?? { items: [] };
  return {
    ...page,
    // The real `hasNext()` reflects Wix's own view of the page chain — it is NOT derived from
    // `items`, which is exactly why the connector guards on both.
    hasNext: () => !!page.cursors?.next,
    next: () => Promise.resolve(nextDraftPostPage()),
  };
}

const draftPostsQueryBuilder = {
  ascending: (...fields: string[]) => {
    mockDraftPostsAscending(fields[0]);
    return draftPostsQueryBuilder;
  },
  limit: (limit: number) => {
    mockDraftPostsLimit(limit);
    return draftPostsQueryBuilder;
  },
  skipTo: (cursor: string) => {
    mockDraftPostsSkipTo(cursor);
    return draftPostsQueryBuilder;
  },
  find: () => Promise.resolve(nextDraftPostPage()),
};

const mockBulkUpdateDraftPosts = jest.fn<Promise<unknown>, [Record<string, unknown>]>();
const mockBulkDeleteDraftPosts = jest.fn<Promise<unknown>, [string[], { permanent?: boolean }?]>();
const mockCreateDraftPost = jest.fn<Promise<unknown>, [unknown, { fieldsets: string[] }]>();
const mockListCategories = jest.fn<Promise<unknown>, [{ paging: { limit: number; offset: number } }]>();
const mockListMembers = jest.fn<
  Promise<unknown>,
  [{ paging: { limit: number; offset: number }; fieldsets: string[] }]
>();
// The tags module only exposes a query builder, so paging is skip/limit on a chained query.
const mockTagsFind = jest.fn<Promise<unknown>, []>();
const mockTagsSkip = jest.fn<unknown, [number]>();
const mockTagsLimit = jest.fn<unknown, [number]>();
const tagsQueryBuilder = {
  skip: (offset: number) => {
    mockTagsSkip(offset);
    return tagsQueryBuilder;
  },
  limit: (limit: number) => {
    mockTagsLimit(limit);
    return tagsQueryBuilder;
  },
  find: () => mockTagsFind(),
};
jest.mock('@wix/sdk', () => ({
  createClient: () => ({
    draftPosts: {
      queryDraftPosts: (options?: { fieldsets?: string[] }) => {
        mockQueryDraftPosts(options);
        return draftPostsQueryBuilder;
      },
      createDraftPost: mockCreateDraftPost,
      bulkUpdateDraftPosts: mockBulkUpdateDraftPosts,
      bulkDeleteDraftPosts: mockBulkDeleteDraftPosts,
    },
    categories: { listCategories: mockListCategories },
    tags: { queryTags: () => tagsQueryBuilder },
    members: { listMembers: mockListMembers },
  }),
  OAuthStrategy: () => ({}),
  TokenRole: { NONE: 'NONE' },
}));

describe('WixBlogConnector.pullRecordFiles pagination', () => {
  const tableSpec: BaseJsonTableSpec = buildWixBlogJsonTableSpec({
    wsId: 'site',
    remoteId: ['site'],
  } satisfies EntityId);

  let connector: WixBlogConnector;
  let emittedBatches: { files: ConnectorFile[]; connectorProgress?: unknown }[];

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WixBlogConnector('fake-access-token');
    emittedBatches = [];
    mockDraftPostPages = [];
    draftPostFindCallCount = 0;
  });

  const collectBatch = (batch: { files: ConnectorFile[]; connectorProgress?: unknown }): Promise<void> => {
    emittedBatches.push(batch);
    return Promise.resolve();
  };
  const pulledIds = (): unknown[] => emittedBatches.flatMap((batch) => batch.files.map((file) => file._id));

  it('walks the cursor chain and clears the checkpoint on the final page', async () => {
    mockDraftPostPages = [
      { items: [{ _id: 'a' }, { _id: 'b' }], cursors: { next: 'cursor-2' } },
      { items: [{ _id: 'c' }], cursors: { next: null } },
    ];

    await connector.pullRecordFiles(tableSpec, collectBatch, {}, {} as never);

    expect(pulledIds()).toEqual(['a', 'b', 'c']);
    // The first page checkpoints Wix's cursor; the terminal page clears it so a later pull restarts.
    expect(emittedBatches[0].connectorProgress).toEqual({ cursor: 'cursor-2' });
    expect(emittedBatches[1].connectorProgress).toEqual({});
  });

  it('resumes the scan from the checkpointed cursor instead of restarting', async () => {
    mockDraftPostPages = [{ items: [{ _id: 'resumed' }], cursors: { next: null } }];

    await connector.pullRecordFiles(tableSpec, collectBatch, { cursor: 'cursor-42' }, {} as never);

    expect(mockDraftPostsSkipTo).toHaveBeenCalledWith('cursor-42');
    expect(pulledIds()).toEqual(['resumed']);
  });

  it('does not call skipTo on a fresh scan', async () => {
    mockDraftPostPages = [{ items: [{ _id: 'a' }] }];

    await connector.pullRecordFiles(tableSpec, collectBatch, {}, {} as never);

    expect(mockDraftPostsSkipTo).not.toHaveBeenCalled();
  });

  // Regression for DEV-10702, carried over from the offset loop: never trust the API's own
  // "there's more" signal alone. If `hasNext()` ever disagrees with an empty page, believing it
  // would spin forever re-fetching nothing.
  it('terminates on an empty page even when Wix still claims a next cursor', async () => {
    mockDraftPostPages = [
      { items: [{ _id: 'p1' }], cursors: { next: 'cursor-2' } },
      { items: [], cursors: { next: 'cursor-3' } },
    ];

    await connector.pullRecordFiles(tableSpec, collectBatch, {}, {} as never);

    expect(pulledIds()).toEqual(['p1']);
    expect(emittedBatches[emittedBatches.length - 1].connectorProgress).toEqual({});
  });

  // DEV-11123: offset paging over a mutable ordering silently SKIPS a record when a post is edited
  // mid-scan. Cursor paging makes Wix track the position, and `_id` is an ordering that cannot
  // change — together that removes the failure mode rather than mitigating it.
  it('pages by cursor over an immutable ordering, requesting the post body', async () => {
    mockDraftPostPages = [{ items: [{ _id: 'p1' }] }];

    await connector.pullRecordFiles(tableSpec, collectBatch, {}, {} as never);

    expect(mockQueryDraftPosts).toHaveBeenCalledWith({ fieldsets: ['RICH_CONTENT'] });
    expect(mockDraftPostsAscending).toHaveBeenCalledWith('_id');
    expect(mockDraftPostsLimit).toHaveBeenCalledWith(100);
  });
});

describe('WixBlogConnector.pullRecordFiles table routing', () => {
  let connector: WixBlogConnector;
  let emittedBatches: { files: ConnectorFile[]; connectorProgress?: unknown }[];

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WixBlogConnector('fake-access-token');
    emittedBatches = [];
  });

  const collectBatch = (batch: { files: ConnectorFile[]; connectorProgress?: unknown }): Promise<void> => {
    emittedBatches.push(batch);
    return Promise.resolve();
  };
  const pulledIds = (): unknown[] => emittedBatches.flatMap((batch) => batch.files.map((file) => file._id));

  it('pulls Categories from the categories endpoint', async () => {
    mockListCategories.mockResolvedValueOnce({ categories: [{ _id: 'cat1' }], metaData: { total: 1 } });

    await connector.pullRecordFiles(
      buildWixBlogJsonTableSpec(wixBlogEntityId('categories')),
      collectBatch,
      {},
      {} as never,
    );

    expect(mockListCategories).toHaveBeenCalledTimes(1);
    expect(mockQueryDraftPosts).not.toHaveBeenCalled();
    expect(pulledIds()).toEqual(['cat1']);
  });

  it('pulls Tags through the query builder using skip/limit', async () => {
    mockTagsFind.mockResolvedValueOnce({ items: [{ _id: 'tag1' }], totalCount: 1 });

    await connector.pullRecordFiles(buildWixBlogJsonTableSpec(wixBlogEntityId('tags')), collectBatch, {}, {} as never);

    expect(mockTagsSkip).toHaveBeenCalledWith(0);
    expect(mockTagsLimit).toHaveBeenCalledWith(100);
    expect(pulledIds()).toEqual(['tag1']);
  });

  it('pulls Members with the FULL fieldset so contact and photo are populated', async () => {
    mockListMembers.mockResolvedValueOnce({ members: [{ _id: 'mem1' }], metadata: { total: 1 } });

    await connector.pullRecordFiles(
      buildWixBlogJsonTableSpec(wixBlogEntityId('members')),
      collectBatch,
      {},
      {} as never,
    );

    expect(mockListMembers.mock.calls[0][0].fieldsets).toEqual(['FULL']);
    expect(pulledIds()).toEqual(['mem1']);
  });

  it('tolerates a null total from the members endpoint', async () => {
    // `metadata.total` is `number | null | undefined` on this endpoint; a null must fall back to the
    // short-page termination rule rather than being compared numerically.
    mockListMembers.mockResolvedValueOnce({ members: [{ _id: 'mem1' }], metadata: { total: null } });

    await connector.pullRecordFiles(
      buildWixBlogJsonTableSpec(wixBlogEntityId('members')),
      collectBatch,
      {},
      {} as never,
    );

    expect(mockListMembers).toHaveBeenCalledTimes(1);
    expect(emittedBatches[emittedBatches.length - 1].connectorProgress).toEqual({});
  });

  it.each(['categories', 'tags', 'members'] as const)('refuses to write to the read-only %s table', async (table) => {
    const spec = buildWixBlogJsonTableSpec(wixBlogEntityId(table));
    const file = { _id: 'x' } as unknown as ConnectorFile;

    await expect(connector.createRecords(spec, [file])).rejects.toThrow(/only Blog Posts is writable/);
    await expect(connector.updateRecords(spec, [file])).rejects.toThrow(/only Blog Posts is writable/);
    await expect(connector.deleteRecords(spec, [file])).rejects.toThrow(/only Blog Posts is writable/);
  });
});

describe('WixBlogConnector bulk writes', () => {
  const postsSpec = buildWixBlogJsonTableSpec(wixBlogEntityId('posts'));
  let connector: WixBlogConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WixBlogConnector('fake-access-token');
  });

  const file = (id: string): ConnectorFile => ({ _id: id }) as unknown as ConnectorFile;
  const succeeded = (index: number, id: string): unknown => ({
    itemMetadata: { success: true, originalIndex: index, _id: id },
    item: { _id: id, title: `persisted ${id}` },
  });

  // DEV-11129: the SDK's own `@maxSize` annotations, and the one deliberate exception.
  it('sizes batches per operation, keeping creates at one', () => {
    expect(connector.getBatchSize('update')).toBe(20);
    expect(connector.getBatchSize('delete')).toBe(100);
    // Wix's bulk endpoints are non-atomic and the publish layer retries a failed batch
    // record-by-record, so bulking creates would turn one rejection into N duplicate posts.
    expect(connector.getBatchSize('create')).toBe(1);
  });

  it('creates one post per request rather than bulking', async () => {
    mockCreateDraftPost
      .mockResolvedValueOnce({ draftPost: { _id: 'new-1' } })
      .mockResolvedValueOnce({ draftPost: { _id: 'new-2' } });

    const created = await connector.createRecords(postsSpec, [file('a'), file('b')]);

    expect(mockCreateDraftPost).toHaveBeenCalledTimes(2);
    expect(created.map((record) => record._id)).toEqual(['new-1', 'new-2']);
  });

  it('updates through the bulk endpoint and returns what Wix persisted, in request order', async () => {
    // Wix is free to reorder results; `originalIndex` is the correlation back to the request array.
    mockBulkUpdateDraftPosts.mockResolvedValueOnce({ results: [succeeded(1, 'b'), succeeded(0, 'a')] });

    const updated = await connector.updateRecords(postsSpec, [file('a'), file('b')]);

    expect(mockBulkUpdateDraftPosts).toHaveBeenCalledTimes(1);
    expect(mockBulkUpdateDraftPosts.mock.calls[0][0]).toMatchObject({
      draftPosts: [{ draftPost: { _id: 'a' } }, { draftPost: { _id: 'b' } }],
      returnFullEntity: true,
      fieldsets: ['RICH_CONTENT'],
    });
    expect(updated.map((record) => record.title)).toEqual(['persisted a', 'persisted b']);
  });

  it('falls back to the sent payload for a record Wix did not echo back', async () => {
    mockBulkUpdateDraftPosts.mockResolvedValueOnce({
      results: [{ itemMetadata: { success: true, originalIndex: 0 } }],
    });

    const updated = await connector.updateRecords(postsSpec, [file('a')]);

    expect(updated.map((record) => record._id)).toEqual(['a']);
  });

  it('deletes through the bulk endpoint in one call', async () => {
    mockBulkDeleteDraftPosts.mockResolvedValueOnce({ results: [succeeded(0, 'a'), succeeded(1, 'b')] });

    await connector.deleteRecords(postsSpec, [file('a'), file('b')]);

    expect(mockBulkDeleteDraftPosts).toHaveBeenCalledTimes(1);
    expect(mockBulkDeleteDraftPosts.mock.calls[0][0]).toEqual(['a', 'b']);
  });

  // A bulk call answers 200 with per-item outcomes, so a partial failure is invisible unless we
  // look. Reporting success here would publish "successfully" while silently dropping the record.
  it('fails an update when Wix rejected any item in the batch', async () => {
    mockBulkUpdateDraftPosts.mockResolvedValueOnce({
      results: [
        succeeded(0, 'a'),
        { itemMetadata: { success: false, originalIndex: 1, _id: 'b', error: { description: 'Title too long' } } },
      ],
    });

    await expect(connector.updateRecords(postsSpec, [file('a'), file('b')])).rejects.toThrow(
      /rejected 1 of 2 posts in a bulk update.*post b — Title too long/,
    );
  });

  it('fails a delete when Wix rejected any item in the batch', async () => {
    mockBulkDeleteDraftPosts.mockResolvedValueOnce({
      results: [{ itemMetadata: { success: false, originalIndex: 0, _id: 'a' } }],
    });

    await expect(connector.deleteRecords(postsSpec, [file('a')])).rejects.toThrow(
      /rejected 1 of 1 posts in a bulk delete/,
    );
  });

  it('chunks an oversized batch to the endpoint maximum on its own', async () => {
    // Correct standalone, not only when the publish layer happens to slice it by `getBatchSize`.
    const twentyFiveIds = Array.from({ length: 25 }, (_unused, index) => `p${index}`);
    mockBulkDeleteDraftPosts.mockResolvedValue({ results: [] });

    await connector.deleteRecords(
      postsSpec,
      twentyFiveIds.map((id) => file(id)),
    );

    expect(mockBulkDeleteDraftPosts).toHaveBeenCalledTimes(1);
    mockBulkUpdateDraftPosts.mockResolvedValue({ results: [] });
    await connector.updateRecords(
      postsSpec,
      twentyFiveIds.map((id) => file(id)),
    );
    // 25 updates exceed the SDK's `@maxSize 20`, so they must split across two calls.
    expect(mockBulkUpdateDraftPosts).toHaveBeenCalledTimes(2);
    expect((mockBulkUpdateDraftPosts.mock.calls[0][0].draftPosts as unknown[]).length).toBe(20);
    expect((mockBulkUpdateDraftPosts.mock.calls[1][0].draftPosts as unknown[]).length).toBe(5);
  });
});

describe('WixBlogConnector.listTables — Members Area gating', () => {
  let connector: WixBlogConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WixBlogConnector('fake-access-token');
  });

  const tableNames = async (): Promise<string[]> => (await connector.listTables()).map((table) => table.displayName);

  it('lists Members when the site can actually serve it', async () => {
    mockListMembers.mockResolvedValueOnce({ members: [], metadata: { total: 0 } });

    expect(await tableNames()).toEqual(['Blog Posts', 'Categories', 'Tags', 'Members']);
  });

  // The Members Area is a separate App Market app that Wix Blog only offers to install. Listing the
  // table on a site without it let a user map a folder that could never pull — a permanently red
  // folder blaming our app permissions for their missing site app.
  it.each([403, 404, 428])('omits Members when Wix answers %i', async (status) => {
    mockListMembers.mockRejectedValueOnce({ response: { status } });

    expect(await tableNames()).toEqual(['Blog Posts', 'Categories', 'Tags']);
  });

  it('still lists Members when the probe fails inconclusively', async () => {
    // Hiding a table the user really does have is the worse failure — it silently drops data they
    // asked for — so only a definitive answer removes it.
    mockListMembers.mockRejectedValue({ response: { status: 500 } });

    expect(await tableNames()).toContain('Members');
  });
});
