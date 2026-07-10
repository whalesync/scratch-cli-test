import { IncrementalPullSupport, X_SCRATCH_READONLY } from '@spinner/shared-types';
import _ from 'lodash';
import { BaseJsonTableSpec, ConnectorFile, dotPath, PullRecordFilesOptions, TablePreview } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockSearch = jest.fn();
const mockListBlockChildren = jest.fn();
const mockCreatePage = jest.fn();
const mockUpdatePage = jest.fn();
const mockRetrievePage = jest.fn();

// Mock the api-client so the connector's `this.client` is the mock. Real error
// classes / constants are kept via requireActual (the connector imports them).
jest.mock('../notion-api-client', () => ({
  ...jest.requireActual<typeof import('../notion-api-client')>('../notion-api-client'),
  NotionApiClient: jest.fn().mockImplementation(() => ({
    search: mockSearch,
    listBlockChildren: mockListBlockChildren,
    createPage: mockCreatePage,
    updatePage: mockUpdatePage,
    retrievePage: mockRetrievePage,
  })),
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

import { NotionConnector } from '../notion-connector';
import {
  buildNotionStandalonePagesTableSpec,
  isDatabaseOwnedNotionPage,
  NOTION_STANDALONE_PAGES_TABLE_ID,
} from '../notion-standalone-pages';

function buildStandalonePagesTableSpec(): BaseJsonTableSpec {
  return buildNotionStandalonePagesTableSpec({
    wsId: NOTION_STANDALONE_PAGES_TABLE_ID,
    remoteId: [NOTION_STANDALONE_PAGES_TABLE_ID],
  });
}

function buildDatabaseTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'db', remoteId: ['db_123', 'ds_123'] },
    slug: 'db',
    name: 'db',
    idPath: dotPath('id'),
    schema: {} as BaseJsonTableSpec['schema'],
  };
}

/**
 * A full page object as the Search endpoint returns it, with the given parent.
 * An empty `titlePlainText` produces the empty title array Notion returns for
 * an untitled page.
 */
function searchResultPage(id: string, parent: Record<string, unknown>, titlePlainText = 'T'): Record<string, unknown> {
  return {
    object: 'page',
    id,
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: '2026-01-02T00:00:00.000Z',
    created_by: { object: 'user', id: 'user_1' },
    last_edited_by: { object: 'user', id: 'user_1' },
    cover: null,
    icon: null,
    parent,
    in_trash: false,
    properties: {
      title: {
        id: 'title',
        type: 'title',
        title: titlePlainText ? [{ type: 'text', text: { content: titlePlainText }, plain_text: titlePlainText }] : [],
      },
    },
    url: `https://www.notion.so/${id}`,
    public_url: null,
  };
}

const WORKSPACE_PARENT = { type: 'workspace', workspace: true };
const PAGE_PARENT = { type: 'page_id', page_id: 'p_root' };
const BLOCK_PARENT = { type: 'block_id', block_id: 'blk_1' };
const DATABASE_PARENT = { type: 'database_id', database_id: 'db_1' };
const DATA_SOURCE_PARENT = { type: 'data_source_id', data_source_id: 'ds_1' };

type PullCallbackBatch = { files: ConnectorFile[]; connectorProgress?: { nextCursor: string | undefined } };

/** Run a standalone-pages pull and collect every callback batch. */
async function runStandalonePagesPull(
  connector: NotionConnector,
  options: PullRecordFilesOptions,
  progress: { nextCursor: string | undefined } = { nextCursor: undefined },
): Promise<PullCallbackBatch[]> {
  const batches: PullCallbackBatch[] = [];
  await connector.pullRecordFiles(
    buildStandalonePagesTableSpec(),
    (batch) => {
      batches.push(batch as PullCallbackBatch);
      return Promise.resolve();
    },
    progress,
    options,
  );
  return batches;
}

/** Typed view of a jest mock's calls (each call's first argument). */
function firstArgOfEachCall(mock: jest.Mock): Record<string, unknown>[] {
  return (mock.mock.calls as [Record<string, unknown>][]).map((call) => call[0]);
}

const EXCLUDE_CONTENT_OPTIONS = { excludePageContent: true } as PullRecordFilesOptions;

describe('NotionConnector — standalone-pages backup table', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new NotionConnector('fake-key');
  });

  describe('pullRecordFiles', () => {
    it('enumerates via Search with the page filter and excludes database-owned pages', async () => {
      mockSearch.mockResolvedValueOnce({
        results: [
          searchResultPage('p_workspace', WORKSPACE_PARENT),
          searchResultPage('p_child', PAGE_PARENT),
          searchResultPage('p_block', BLOCK_PARENT),
          searchResultPage('row_db', DATABASE_PARENT),
          searchResultPage('row_ds', DATA_SOURCE_PARENT),
          { object: 'data_source', id: 'ds_9' }, // non-page search result is ignored
        ],
        has_more: false,
        next_cursor: null,
      });

      const batches = await runStandalonePagesPull(connector, EXCLUDE_CONTENT_OPTIONS);

      expect(mockSearch).toHaveBeenCalledTimes(1);
      expect(firstArgOfEachCall(mockSearch)[0]).toMatchObject({
        filter: { property: 'object', value: 'page' },
        page_size: 100,
      });
      const pulledPageIds = batches.flatMap((batch) => batch.files.map((file) => file.id));
      expect(pulledPageIds).toEqual(['p_workspace', 'p_child', 'p_block']);
    });

    it('stores the page object verbatim — no reshaping, no added keys', async () => {
      const page = searchResultPage('p_1', PAGE_PARENT);
      const pageSnapshotBeforePull = structuredClone(page);
      mockSearch.mockResolvedValueOnce({ results: [page], has_more: false, next_cursor: null });

      const batches = await runStandalonePagesPull(connector, EXCLUDE_CONTENT_OPTIONS);

      expect(batches).toHaveLength(1);
      expect(batches[0].files).toHaveLength(1);
      expect(batches[0].files[0]).toEqual(pageSnapshotBeforePull);
    });

    it('paginates with next_cursor, resumes from progress, and checkpoints each batch', async () => {
      mockSearch
        .mockResolvedValueOnce({
          results: [searchResultPage('p_1', WORKSPACE_PARENT)],
          has_more: true,
          next_cursor: 'cursor_2',
        })
        .mockResolvedValueOnce({
          results: [searchResultPage('p_2', WORKSPACE_PARENT)],
          has_more: false,
          next_cursor: null,
        });

      const batches = await runStandalonePagesPull(connector, EXCLUDE_CONTENT_OPTIONS, { nextCursor: 'cursor_1' });

      expect(mockSearch).toHaveBeenCalledTimes(2);
      const searchCallArgs = firstArgOfEachCall(mockSearch);
      expect(searchCallArgs[0]).toMatchObject({ start_cursor: 'cursor_1' });
      expect(searchCallArgs[1]).toMatchObject({ start_cursor: 'cursor_2' });
      expect(batches.map((batch) => batch.connectorProgress)).toEqual([
        { nextCursor: 'cursor_2' },
        { nextCursor: undefined },
      ]);
      expect(batches.flatMap((batch) => batch.files.map((file) => file.id))).toEqual(['p_1', 'p_2']);
    });

    it('fetches page content under page_content when not excluded', async () => {
      mockSearch.mockResolvedValueOnce({
        results: [searchResultPage('p_1', WORKSPACE_PARENT)],
        has_more: false,
        next_cursor: null,
      });
      const block = { object: 'block', id: 'blk_1', type: 'paragraph', has_children: false, paragraph: {} };
      mockListBlockChildren.mockResolvedValueOnce({ results: [block], has_more: false, next_cursor: null });

      const batches = await runStandalonePagesPull(connector, {} as PullRecordFilesOptions);

      expect(mockListBlockChildren).toHaveBeenCalledTimes(1);
      expect(firstArgOfEachCall(mockListBlockChildren)[0]).toMatchObject({ block_id: 'p_1' });
      expect(batches[0].files[0].page_content).toEqual([block]);
    });

    it('keeps the page (without page_content) when the content fetch fails', async () => {
      mockSearch.mockResolvedValueOnce({
        results: [searchResultPage('p_1', WORKSPACE_PARENT)],
        has_more: false,
        next_cursor: null,
      });
      mockListBlockChildren.mockRejectedValueOnce(new Error('boom'));

      const batches = await runStandalonePagesPull(connector, {} as PullRecordFilesOptions);

      expect(batches[0].files).toHaveLength(1);
      expect(batches[0].files[0].id).toBe('p_1');
      expect(batches[0].files[0]).not.toHaveProperty('page_content');
    });

    it('fails fast when a folder filter is configured (Search accepts no record filter)', async () => {
      await expect(
        runStandalonePagesPull(connector, { filter: '{"property":"Name"}' } as PullRecordFilesOptions),
      ).rejects.toThrow(/does not support folder filters/);
      expect(mockSearch).not.toHaveBeenCalled();
    });
  });

  describe('write operations', () => {
    it('createRecords creates the page under the record file’s own parent.page_id', async () => {
      const createdPage = searchResultPage('p_new', PAGE_PARENT, 'Brand New Page');
      mockCreatePage.mockResolvedValueOnce(createdPage);
      const newRecordFile = searchResultPage('', PAGE_PARENT, 'Brand New Page');

      const results = await connector.createRecords(buildStandalonePagesTableSpec(), [newRecordFile]);

      expect(mockCreatePage).toHaveBeenCalledTimes(1);
      expect(firstArgOfEachCall(mockCreatePage)[0]).toEqual({
        parent: { type: 'page_id', page_id: 'p_root' },
        // Read-format → write-format: the type/id envelope keys are stripped.
        properties: {
          title: {
            title: [{ type: 'text', text: { content: 'Brand New Page' }, plain_text: 'Brand New Page' }],
          },
        },
      });
      expect(results).toEqual([createdPage]);
    });

    it('createRecords fails fast for a file without a page_id parent (workspace-level creates are impossible)', async () => {
      const workspaceParentedFile = searchResultPage('', WORKSPACE_PARENT, 'Orphan');

      await expect(connector.createRecords(buildStandalonePagesTableSpec(), [workspaceParentedFile])).rejects.toThrow(
        /parent.*page_id/,
      );
      expect(mockCreatePage).not.toHaveBeenCalled();
    });

    it('updateRecords publishes a title edit and returns the refetched page', async () => {
      const fileOnDisk = searchResultPage('p_1', PAGE_PARENT, 'Old Title');
      const changedTitleProperty = (searchResultPage('p_1', PAGE_PARENT, 'New Title') as { properties: unknown })
        .properties;
      const refetchedPage = searchResultPage('p_1', PAGE_PARENT, 'New Title');
      mockUpdatePage.mockResolvedValueOnce(refetchedPage);
      mockRetrievePage.mockResolvedValueOnce(structuredClone(refetchedPage));
      mockListBlockChildren.mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null });

      const results = await connector.updateRecords(
        buildStandalonePagesTableSpec(),
        [fileOnDisk],
        [{ properties: changedTitleProperty }],
      );

      expect(mockUpdatePage).toHaveBeenCalledTimes(1);
      expect(firstArgOfEachCall(mockUpdatePage)[0]).toEqual({
        page_id: 'p_1',
        properties: {
          title: { title: [{ type: 'text', text: { content: 'New Title' }, plain_text: 'New Title' }] },
        },
      });
      // Post-write refetch keeps the committed blob byte-equal to a fresh pull.
      expect(mockRetrievePage).toHaveBeenCalledTimes(1);
      expect(results[0].id).toBe('p_1');
      expect(results[0].page_content).toEqual([]);
    });

    it('deleteRecords trashes standalone pages via in_trash', async () => {
      mockUpdatePage.mockResolvedValue(undefined);

      await connector.deleteRecords(buildStandalonePagesTableSpec(), [{ id: 'p_1' }, { id: 'p_2' }]);

      expect(mockUpdatePage).toHaveBeenCalledTimes(2);
      expect(firstArgOfEachCall(mockUpdatePage)).toEqual([
        { page_id: 'p_1', in_trash: true },
        { page_id: 'p_2', in_trash: true },
      ]);
    });
  });

  describe('table discovery', () => {
    it('listTables offers the fixed Pages table ahead of the searched databases', async () => {
      mockSearch.mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null });

      const tables = await connector.listTables();

      expect(tables[0]).toMatchObject({
        id: { wsId: NOTION_STANDALONE_PAGES_TABLE_ID, remoteId: [NOTION_STANDALONE_PAGES_TABLE_ID] },
        displayName: 'Page Tree',
      });
      // Explained in the picker via the generic info-note tooltip.
      expect(tables[0].infoNote).toMatch(/standalone page/);
      // Fully writable: no capability is disabled on the preview.
      expect(tables[0].disabledCreates).toBeUndefined();
      expect(tables[0].disabledUpdates).toBeUndefined();
      expect(tables[0].disabledDeletes).toBeUndefined();
    });

    it.each([
      ['', true],
      ['pag', true],
      ['TREE', true],
      ['marketing', false],
    ])('searchTables(%j) includes the Page Tree table: %s', async (searchTerm, shouldInclude) => {
      mockSearch.mockResolvedValueOnce({ results: [], has_more: false, next_cursor: null });

      const { tables } = await connector.searchTables(searchTerm);

      const pagesTableEntries = tables.filter(
        (table: TablePreview) => table.id.remoteId[0] === NOTION_STANDALONE_PAGES_TABLE_ID,
      );
      expect(pagesTableEntries).toHaveLength(shouldInclude ? 1 : 0);
    });
  });

  describe('table spec', () => {
    it('fetchJsonTableSpec builds the curated spec without any API call', async () => {
      const spec = await connector.fetchJsonTableSpec({
        wsId: NOTION_STANDALONE_PAGES_TABLE_ID,
        remoteId: [NOTION_STANDALONE_PAGES_TABLE_ID],
      });

      expect(mockSearch).not.toHaveBeenCalled();
      expect(spec.idPath).toBe('id');
      expect(spec.titlePath).toBe('properties.title');
      expect(spec.schema.$id).toBe(`notion/${NOTION_STANDALONE_PAGES_TABLE_ID}`);
      // The declared parent pointer is what lets the CLI/desktop derive a tree
      // view of the flat folder with no connector knowledge.
      expect(spec.recordTree).toEqual({
        parentIdPath: 'parent.page_id',
        parentKindPath: 'parent.type',
        recordUrlPath: 'url',
      });
      expect(spec.agentInstructions).toMatch(/scratchmd record-tree/);
    });

    it('keeps the title property writable while the parent pointer stays read-only', () => {
      const spec = buildStandalonePagesTableSpec();

      const titleReadonlyFlag: unknown = _.get(spec.schema, [
        'properties',
        'properties',
        'properties',
        'title',
        X_SCRATCH_READONLY,
      ]);
      expect(titleReadonlyFlag).toBeUndefined();
      const parentReadonlyFlag: unknown = _.get(spec.schema, ['properties', 'parent', X_SCRATCH_READONLY]);
      expect(parentReadonlyFlag).toBe(true);
    });

    it('surfaces the parent column (the page-tree edge) in the default view', () => {
      const spec = buildStandalonePagesTableSpec();

      const parentColumn = spec.defaultView?.cols.find((col) => col.kind === 'col' && col.path === 'parent');
      expect(parentColumn).toBeDefined();
      expect(parentColumn && 'hidden' in parentColumn ? parentColumn.hidden : true).toBeUndefined();
      expect(parentColumn && 'subfields' in parentColumn ? parentColumn.subfields : undefined).toEqual([
        { relativePath: 'type', name: 'Type', type: 'string' },
        { relativePath: 'page_id', name: 'Page Id', type: 'string' },
        { relativePath: 'block_id', name: 'Block Id', type: 'string' },
      ]);
    });
  });

  describe('framework hooks', () => {
    it('suggests title-based filenames like database tables (untitled pages fall back to the page id)', () => {
      const records: ConnectorFile[] = [
        searchResultPage('p_1', WORKSPACE_PARENT, 'Roadmap'),
        searchResultPage('p_2', PAGE_PARENT, 'Meeting Notes'),
        searchResultPage('p_3', PAGE_PARENT, ''),
      ];

      const suggestedFileNames = connector.getSuggestedRecordFileNames(records, buildStandalonePagesTableSpec());

      // The undefined suggestion makes the framework name the file by record id;
      // duplicate titles are deduplicated by the framework (title-<pageId>.json).
      expect(suggestedFileNames).toEqual(['Roadmap', 'Meeting Notes', undefined]);
    });

    it('reports incremental pull as unsupported for the Pages table, supported for databases', () => {
      const options = {} as PullRecordFilesOptions;
      expect(connector.incrementalPullSupport(options, buildStandalonePagesTableSpec())).toBe(
        IncrementalPullSupport.NOT_SUPPORTED,
      );
      expect(connector.incrementalPullSupport(options, buildDatabaseTableSpec())).toBe(
        IncrementalPullSupport.SUPPORTED,
      );
      expect(connector.incrementalPullSupport(options, null)).toBe(IncrementalPullSupport.SUPPORTED);
    });
  });

  describe('isDatabaseOwnedNotionPage', () => {
    it.each([
      [DATABASE_PARENT, true],
      [DATA_SOURCE_PARENT, true],
      [WORKSPACE_PARENT, false],
      [PAGE_PARENT, false],
      [BLOCK_PARENT, false],
    ])('parent %j → %s', (parent, expected) => {
      const page = searchResultPage('p_x', parent) as unknown as Parameters<typeof isDatabaseOwnedNotionPage>[0];
      expect(isDatabaseOwnedNotionPage(page)).toBe(expected);
    });
  });
});
