import { BaseJsonTableSpec, ConnectorFile, EntityId } from '../../../../types';
import { WixBlogConnector } from '../wix-blog-connector';
import { buildWixBlogJsonTableSpec } from '../wix-blog-json-schema';
import { wixBlogEntityId } from '../wix-blog-tables';

// Break the circular import chain through the connector base -> display-names
// (the same shim the ClickUp connector spec uses).
jest.mock('../../../../display-names', () => ({
  getServiceDisplayName: () => 'Wix Blog',
}));

// Mock the Wix SDK so constructing the connector performs no network I/O: the
// SDK client's `draftPosts.listDraftPosts` is the jest.fn() we drive per test.
// Typed with the request arg shape so reading `mock.calls` stays type-safe.
const mockListDraftPosts = jest.fn<
  Promise<unknown>,
  [{ paging: { limit: number; offset: number }; fieldsets: string[]; sort?: string }]
>();
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
    draftPosts: { listDraftPosts: mockListDraftPosts },
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
  });

  const collectBatch = (batch: { files: ConnectorFile[]; connectorProgress?: unknown }): Promise<void> => {
    emittedBatches.push(batch);
    return Promise.resolve();
  };

  // Regression for DEV-10702: the offset-paged full scan looped forever when
  // `metaData.total` over-reported what the API actually paginated — an empty
  // page left `offset` unchanged (`+= 0`) while `offset < total` stayed true.
  it('terminates on an empty page even when metaData.total over-reports', async () => {
    // `total` claims 5, but only one post actually paginates: the second fetch
    // comes back empty. Pre-fix, offset (1) < total (5) never advances and the
    // loop re-fetches the empty page forever.
    mockListDraftPosts
      .mockResolvedValueOnce({ draftPosts: [{ _id: 'p1' }], metaData: { total: 5 } })
      .mockResolvedValueOnce({ draftPosts: [], metaData: { total: 5 } });

    await connector.pullRecordFiles(tableSpec, collectBatch, {}, {} as never);

    expect(mockListDraftPosts).toHaveBeenCalledTimes(2);
    expect(emittedBatches.flatMap((batch) => batch.files.map((file) => file._id))).toEqual(['p1']);
    // The empty final page flows through the callback that clears the resume
    // checkpoint, so the next pull restarts at offset 0.
    expect(emittedBatches[emittedBatches.length - 1].connectorProgress).toEqual({});
  });

  it('paginates by offset and clears the checkpoint on the final page', async () => {
    mockListDraftPosts
      .mockResolvedValueOnce({ draftPosts: [{ _id: 'a' }, { _id: 'b' }], metaData: { total: 3 } })
      .mockResolvedValueOnce({ draftPosts: [{ _id: 'c' }], metaData: { total: 3 } });

    await connector.pullRecordFiles(tableSpec, collectBatch, {}, {} as never);

    expect(mockListDraftPosts).toHaveBeenCalledTimes(2);
    expect(emittedBatches.flatMap((batch) => batch.files.map((file) => file._id))).toEqual(['a', 'b', 'c']);
    // First page advances the resume offset; the terminal page clears it.
    expect(emittedBatches[0].connectorProgress).toEqual({ offset: 2 });
    expect(emittedBatches[1].connectorProgress).toEqual({});
  });

  it('stops on a short page when the response omits metaData.total', async () => {
    // No `total` → fall back to "stop when the page is shorter than the limit".
    mockListDraftPosts.mockResolvedValueOnce({ draftPosts: [{ _id: 'only' }] });

    await connector.pullRecordFiles(tableSpec, collectBatch, {}, {} as never);

    expect(mockListDraftPosts).toHaveBeenCalledTimes(1);
    expect(emittedBatches[emittedBatches.length - 1].connectorProgress).toEqual({});
  });

  it('resumes the scan from the checkpointed offset', async () => {
    mockListDraftPosts.mockResolvedValueOnce({ draftPosts: [{ _id: 'resumed' }], metaData: { total: 51 } });

    await connector.pullRecordFiles(tableSpec, collectBatch, { offset: 50 }, {} as never);

    // Resumes at the persisted offset rather than restarting at 0.
    expect(mockListDraftPosts.mock.calls[0][0]).toMatchObject({ paging: { offset: 50 } });
  });

  // DEV-11123: offset paging over Wix's default `EDITING_DATE_DESC` ordering silently SKIPS a record
  // when a post is edited mid-scan (the edited post jumps to the front and shifts every later row
  // down one). ASC moves it past the cursor instead, so the worst case is an idempotent re-read.
  it('requests ascending edit-date order so a mid-scan edit cannot skip a record', async () => {
    mockListDraftPosts.mockResolvedValueOnce({ draftPosts: [{ _id: 'p1' }] });

    await connector.pullRecordFiles(tableSpec, collectBatch, {}, {} as never);

    expect(mockListDraftPosts.mock.calls[0][0].sort).toBe('EDITING_DATE_ASC');
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
    expect(mockListDraftPosts).not.toHaveBeenCalled();
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
