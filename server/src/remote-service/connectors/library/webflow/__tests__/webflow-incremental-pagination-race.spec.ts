import { BaseJsonTableSpec, ConnectorFile, PullRecordFilesOptions } from '../../../types';

// Mock display-names to break the connector-registry circular import chain (it
// imports every connector), matching the other webflow connector specs.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Unlike webflow-connector-incremental.spec.ts (which mocks the whole
// WebflowApiClient), this suite drives the REAL WebflowApiClient so the actual
// `sortOrder` it sends reaches the server model below. We mock only the HTTP
// layer (create-api-client), which is where the client's sort/offset/gte query
// params land — the exact surface DEV-10791's fix lives on.
const mockHttpGet = jest.fn();
jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockHttpGet,
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  })),
}));

import { WebflowConnector } from '../webflow-connector';

const COLLECTION_ID = 'col-1';
const COLLECTION_ITEMS_URL = `/collections/${COLLECTION_ID}/items`;

function collectionSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'ws', remoteId: ['site-1', COLLECTION_ID] },
    slug: 's',
    name: 'n',
    schema: {},
  } as unknown as BaseJsonTableSpec;
}

/**
 * DEV-10791: incremental pull must never permanently skip an *unmodified* item
 * when a neighbor is edited mid-pull. This is the property the descending sort
 * buys us; an ascending sort violates it.
 *
 * We stand up a faithful model of Webflow's List Collection Items endpoint: it
 * applies the `lastUpdated[gte]` filter, sorts by whatever `sortOrder` the
 * client actually sent, and returns the requested `[offset, offset+limit)`
 * slice. A content editor re-saves an already-read page-1 item between the two
 * page fetches (its `lastUpdated` jumps to "now"). We then assert every original
 * item is still delivered.
 *
 * Under `sortOrder=desc` (the fix) the re-saved item moves to the HEAD — inside
 * already-read offsets — so the page boundary at offset 100 is undisturbed and
 * nothing is dropped. If the source is reverted to `sortOrder=asc`, the re-saved
 * item migrates to the TAIL, every later item shifts down one offset slot, and
 * the unmodified item that was sitting at the page boundary slides into
 * already-read territory and is skipped — failing this test.
 */
describe('WebflowConnector incremental pull — mid-pull edit pagination race (DEV-10791)', () => {
  // WEBFLOW_DEFAULT_BATCH_SIZE is 100, so 150 items forces a two-page pull.
  const TOTAL_ITEMS = 150;
  // A distinct, strictly-decreasing timestamp per item so there are never ties:
  // item-0 is newest, item-149 oldest.
  const BASE_MILLIS = Date.parse('2026-05-14T12:00:00.000Z');
  // The already-read page-1 item a content editor re-saves between page fetches.
  const RESAVED_ITEM_ID = 'item-50';

  let serverItemsById: Map<string, { id: string; lastUpdatedMillis: number }>;
  let httpGetCallCount: number;

  beforeEach(() => {
    jest.clearAllMocks();

    serverItemsById = new Map();
    for (let itemIndex = 0; itemIndex < TOTAL_ITEMS; itemIndex++) {
      const id = `item-${itemIndex}`;
      serverItemsById.set(id, { id, lastUpdatedMillis: BASE_MILLIS - itemIndex * 1000 });
    }
    httpGetCallCount = 0;

    mockHttpGet.mockImplementation((url: string, config?: { params?: Record<string, string | number> }) => {
      if (url !== COLLECTION_ITEMS_URL) {
        throw new Error(`unexpected GET ${url}`);
      }
      httpGetCallCount++;

      // A content editor re-saves an already-read page-1 item after the first
      // page has been fetched but before the second — its lastUpdated jumps to
      // "now" (newer than every other item).
      if (httpGetCallCount === 2) {
        const resaved = serverItemsById.get(RESAVED_ITEM_ID);
        if (!resaved) {
          throw new Error(`re-saved item ${RESAVED_ITEM_ID} missing from server model`);
        }
        resaved.lastUpdatedMillis = BASE_MILLIS + 60_000;
      }

      const params = config?.params ?? {};
      const offset = Number(params.offset);
      const limit = Number(params.limit);
      const lastUpdatedGteMillis =
        params['lastUpdated[gte]'] !== undefined ? Date.parse(String(params['lastUpdated[gte]'])) : undefined;
      const sortOrder = params.sortOrder;

      let itemsMatchingFilter = [...serverItemsById.values()].filter(
        (item) => lastUpdatedGteMillis === undefined || item.lastUpdatedMillis >= lastUpdatedGteMillis,
      );
      // Honor the sort direction the client sent (timestamps are unique, so no
      // tie-break is needed). Full pulls send no sortOrder and stay unsorted.
      if (sortOrder === 'desc') {
        itemsMatchingFilter = itemsMatchingFilter.sort((a, b) => b.lastUpdatedMillis - a.lastUpdatedMillis);
      } else if (sortOrder === 'asc') {
        itemsMatchingFilter = itemsMatchingFilter.sort((a, b) => a.lastUpdatedMillis - b.lastUpdatedMillis);
      }

      const pageOfItems = itemsMatchingFilter.slice(offset, offset + limit);
      return {
        data: {
          items: pageOfItems.map((item) => ({
            id: item.id,
            lastUpdated: new Date(item.lastUpdatedMillis).toISOString(),
          })),
          pagination: { total: itemsMatchingFilter.length, offset, limit },
        },
      };
    });
  });

  it('delivers every unmodified item even when an already-read item is re-saved mid-pull', async () => {
    const connector = new WebflowConnector('test-token');
    const deliveredItemIds = new Set<string>();
    const collectFilesCallback = jest.fn(({ files }: { files: ConnectorFile[] }) => {
      for (const file of files) {
        deliveredItemIds.add((file as unknown as { id: string }).id);
      }
      return Promise.resolve();
    });

    await connector.pullRecordFiles(collectionSpec(), collectFilesCallback, {}, {
      pullMode: 'incremental',
      // Far before every item's lastUpdated, so the gte filter matches all of them.
      since: new Date('2026-05-01T00:00:00.000Z'),
    } as PullRecordFilesOptions);

    // The mid-pull edit must have landed between the two page fetches.
    expect(httpGetCallCount).toBeGreaterThanOrEqual(2);

    // Every original item — most importantly the unmodified neighbor that sits
    // at the page-100 boundary — is delivered. An ascending sort would drop it.
    for (let itemIndex = 0; itemIndex < TOTAL_ITEMS; itemIndex++) {
      expect(deliveredItemIds).toContain(`item-${itemIndex}`);
    }
    expect(deliveredItemIds.size).toBe(TOTAL_ITEMS);
  });
});
