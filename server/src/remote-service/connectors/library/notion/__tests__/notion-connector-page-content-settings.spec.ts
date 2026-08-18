import { TSchema } from '@sinclair/typebox';
import type { DataFolderOptions } from '@spinner/shared-types';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockUpdatePage = jest.fn();
const mockRetrievePage = jest.fn();
const mockListBlockChildren = jest.fn();

// Mock the api-client so the connector's `this.client` is the mock. Real error
// classes / constants are kept via requireActual (the connector imports them).
jest.mock('../notion-api-client', () => ({
  ...jest.requireActual<typeof import('../notion-api-client')>('../notion-api-client'),
  NotionApiClient: jest.fn().mockImplementation(() => ({
    updatePage: mockUpdatePage,
    retrievePage: mockRetrievePage,
    listBlockChildren: mockListBlockChildren,
  })),
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

import { NotionConnector } from '../notion-connector';

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'db', remoteId: ['db_123', 'ds_456'] },
    slug: 'db',
    name: 'db',
    idPath: dotPath('id'),
    schema: {} as unknown as TSchema,
  };
}

/** A block tree one level deep: the page has one paragraph, which itself has one child paragraph. */
function mockNestedBlocks(): void {
  mockListBlockChildren.mockImplementation(({ block_id }: { block_id: string }) => {
    if (block_id.startsWith('page_')) {
      return Promise.resolve({
        results: [{ id: 'block_top', type: 'paragraph', has_children: true }],
        has_more: false,
        next_cursor: null,
      });
    }
    return Promise.resolve({
      results: [{ id: 'block_nested', type: 'paragraph', has_children: false }],
      has_more: false,
      next_cursor: null,
    });
  });
}

const collectFiles = async (
  connector: NotionConnector,
  ids: string[],
  options: DataFolderOptions | undefined,
): Promise<Record<string, unknown>[]> => {
  const files: Record<string, unknown>[] = [];
  await connector.pullRecordFilesByIds(
    buildTableSpec(),
    ids,
    ({ files: batch }) => {
      files.push(...(batch as Record<string, unknown>[]));
      return Promise.resolve();
    },
    options,
  );
  return files;
};

// DEV-11258: the folder's `excludePageContent` / `childContentMaxDepth` advanced
// settings used to reach only the full-table pull. The per-page paths — a
// targeted pull and the refetch `updateRecords` does after every write — always
// walked the whole block tree, so a sync that only writes properties still paid
// for every page's body on each publish. Both now take the folder options from
// their caller, like `pullRecordFiles` does.
describe('NotionConnector page-content settings on the per-page paths', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdatePage.mockResolvedValue(undefined);
    mockRetrievePage.mockImplementation(({ page_id }: { page_id: string }) =>
      Promise.resolve({ object: 'page', id: page_id, properties: {} }),
    );
    mockNestedBlocks();
    connector = new NotionConnector('fake-key');
  });

  describe('pullRecordFilesByIds', () => {
    it('skips the block walk when the folder excludes page content', async () => {
      const [file] = await collectFiles(connector, ['page_1'], { excludePageContent: true });

      expect(mockRetrievePage).toHaveBeenCalledWith({ page_id: 'page_1' });
      expect(mockListBlockChildren).not.toHaveBeenCalled();
      expect(file).not.toHaveProperty('page_content');
    });

    it('walks the block tree when the folder does not exclude page content', async () => {
      const [file] = await collectFiles(connector, ['page_1'], {});

      expect(mockListBlockChildren).toHaveBeenCalled();
      const pageContent = file.page_content as { id: string; children: { id: string }[] }[];
      expect(pageContent[0].id).toBe('block_top');
      expect(pageContent[0].children[0].id).toBe('block_nested');
    });

    it("honors the folder's childContentMaxDepth", async () => {
      const [file] = await collectFiles(connector, ['page_1'], { childContentMaxDepth: 1 });

      // Only the page's own children are listed; the nested paragraph is not descended into.
      expect(mockListBlockChildren).toHaveBeenCalledTimes(1);
      const pageContent = file.page_content as { id: string; children: unknown[] }[];
      expect(pageContent[0].id).toBe('block_top');
      expect(pageContent[0].children).toEqual([]);
    });

    it('fetches page content in full when the caller passes no folder options', async () => {
      const [file] = await collectFiles(connector, ['page_1'], undefined);

      expect(mockListBlockChildren).toHaveBeenCalledTimes(2);
      expect(file).toHaveProperty('page_content');
    });
  });

  describe('updateRecords refetch', () => {
    const files: ConnectorFile[] = [
      {
        id: 'page_1',
        properties: { Title: { id: 'pid_a', type: 'title', title: [{ plain_text: 'Old' }] } },
        // What a pull with page content would have written.
        page_content: [{ id: 'block_stale', type: 'paragraph' }],
      },
    ];
    const changedFields: Record<string, unknown>[] = [{ properties: { Title: { title: [{ plain_text: 'New' }] } } }];

    it('refetches the page without its block tree when the folder excludes page content', async () => {
      const [result] = await connector.updateRecords(buildTableSpec(), files, changedFields, {
        excludePageContent: true,
      });

      expect(mockUpdatePage).toHaveBeenCalledTimes(1);
      expect(mockRetrievePage).toHaveBeenCalledWith({ page_id: 'page_1' });
      expect(mockListBlockChildren).not.toHaveBeenCalled();
      // Byte-equal to a fresh pull of this folder, which carries no page_content either.
      expect(result).not.toHaveProperty('page_content');
    });

    it('still refetches the block tree when the folder does not exclude page content', async () => {
      const [result] = await connector.updateRecords(buildTableSpec(), files, changedFields, {});

      expect(mockListBlockChildren).toHaveBeenCalled();
      expect((result as { page_content?: { id: string }[] }).page_content?.[0]?.id).toBe('block_top');
    });

    it('refetches the block tree when the caller passes no folder options', async () => {
      const [result] = await connector.updateRecords(buildTableSpec(), files, changedFields);

      expect(mockListBlockChildren).toHaveBeenCalled();
      expect(result).toHaveProperty('page_content');
    });
  });
});
