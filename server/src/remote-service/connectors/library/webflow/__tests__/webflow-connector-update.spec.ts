import { Type } from '@sinclair/typebox';
import { X_SCRATCH_ASSET_FIELD } from '@spinner/shared-types';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { WebflowConnector } from '../webflow-connector';

// Mock display-names to break circular import chain (it imports all connectors)
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the WebflowApiClient so the connector's internal `this.client` is the
// mock — we need its live and staged batch-update methods here.
const mockUpdateItemsLive = jest.fn().mockResolvedValue({});
const mockUpdateItemsStaged = jest.fn().mockResolvedValue({});
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({
    updateItemsLive: mockUpdateItemsLive,
    updateItemsStaged: mockUpdateItemsStaged,
  })),
  WebflowError: class WebflowError extends Error {},
}));

/**
 * Build an axios-shaped Error that {@link isWebflowNeverPublishedError} matches:
 * a 409 whose body message contains "Live PATCH updates". `axios.isAxiosError`
 * only checks `isAxiosError === true`, so attaching that flag + `response` to a
 * real Error is enough (and keeps `prefer-promise-reject-errors` happy).
 */
function neverPublishedError(): Error {
  return Object.assign(new Error('Webflow 409'), {
    isAxiosError: true,
    response: {
      status: 409,
      data: {
        message:
          "Conflict with server data: Live PATCH updates can't be applied to items that have never been published",
      },
    },
  });
}

// Mock html-minify
jest.mock('src/wrappers/html-minify', () => ({
  minifyHtml: jest.fn((input: string) => Promise.resolve(`minified:${input}`)),
}));

import { minifyHtml } from 'src/wrappers/html-minify';

const mockedMinifyHtml = minifyHtml as jest.MockedFunction<typeof minifyHtml>;

function buildTableSpec(fieldProperties: Record<string, unknown>): BaseJsonTableSpec {
  return {
    id: {
      wsId: 'site1::col1',
      remoteId: ['site1', 'col1'],
    },
    displayName: 'Test Collection',
    schema: Type.Object({
      id: Type.String(),
      fieldData: Type.Object(
        Object.fromEntries(
          Object.entries(fieldProperties).map(([key, schema]) => [key, schema as ReturnType<typeof Type.String>]),
        ),
      ),
    }),
  } as unknown as BaseJsonTableSpec;
}

describe('WebflowConnector.updateRecords', () => {
  let connector: WebflowConnector;

  const tableSpec = buildTableSpec({
    name: Type.String({ description: 'Name' }),
    slug: Type.String({ description: 'Slug' }),
    body: Type.String({ description: 'Body', contentMediaType: 'text/html' }),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WebflowConnector('test-token');
  });

  it('should send only changed fieldData when changedFields is provided', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'New Name', slug: 'old-slug', body: '<p>old</p>' } } as ConnectorFile,
    ];
    // Deep changedFields: only name changed within fieldData
    const changedFields: (Record<string, unknown> | undefined)[] = [{ fieldData: { name: 'New Name' } }];

    await connector.updateRecords(tableSpec, files, changedFields);

    expect(mockUpdateItemsLive).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'item1', fieldData: { name: 'New Name' } }],
    });
  });

  it('should send full fieldData when changedFields is undefined', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'Full Name', slug: 'full-slug' } } as ConnectorFile,
    ];

    await connector.updateRecords(tableSpec, files);

    expect(mockUpdateItemsLive).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'item1', fieldData: { name: 'Full Name', slug: 'full-slug' } }],
    });
  });

  it('should fall back to full content when changedFields[i] is undefined', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'Changed', slug: 'changed-slug' } } as ConnectorFile,
      { id: 'item2', fieldData: { name: 'Full Content', slug: 'full-slug' } } as ConnectorFile,
    ];
    const changedFields: (Record<string, unknown> | undefined)[] = [{ fieldData: { name: 'Changed' } }, undefined];

    await connector.updateRecords(tableSpec, files, changedFields);

    expect(mockUpdateItemsLive).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [
        { id: 'item1', fieldData: { name: 'Changed' } },
        { id: 'item2', fieldData: { name: 'Full Content', slug: 'full-slug' } },
      ],
    });
  });

  it('should minify RichText fields in partial update from changedFields', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'Name', body: '<p>  new content  </p>' } } as ConnectorFile,
    ];
    const changedFields: (Record<string, unknown> | undefined)[] = [
      { fieldData: { name: 'Name', body: '<p>  new content  </p>' } },
    ];

    await connector.updateRecords(tableSpec, files, changedFields);

    expect(mockedMinifyHtml).toHaveBeenCalledWith('<p>  new content  </p>');
    expect(mockUpdateItemsLive).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'item1', fieldData: { name: 'Name', body: 'minified:<p>  new content  </p>' } }],
    });
  });

  it('should filter out fields not in schema from partial update', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'New Name', unknownField: 'should be filtered' } } as ConnectorFile,
    ];
    const changedFields: (Record<string, unknown> | undefined)[] = [
      { fieldData: { name: 'New Name', unknownField: 'should be filtered' } },
    ];

    await connector.updateRecords(tableSpec, files, changedFields);

    expect(mockUpdateItemsLive).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'item1', fieldData: { name: 'New Name' } }],
    });
  });

  it('should send the full asset object for an alt-only image edit (DEV-10755)', async () => {
    // An image field is atomic: Webflow rejects a partial `{ alt }` with no url/fileId.
    // The publish diff now re-expands a changed subfield to the whole object, so the
    // connector receives — and must forward — the full `{ fileId, url, alt }` value.
    const imageTableSpec = buildTableSpec({
      name: Type.String({ description: 'Name' }),
      image: Type.Object(
        { fileId: Type.String(), url: Type.String(), alt: Type.String() },
        { description: 'Image', [X_SCRATCH_ASSET_FIELD]: { idPath: 'fileId', urlExpires: false } },
      ),
    });
    const fullImage = { fileId: 'file123', url: 'https://cdn/x.png', alt: 'new alt' };
    const files: ConnectorFile[] = [{ id: 'item1', fieldData: { name: 'Same', image: fullImage } } as ConnectorFile];
    const changedFields: (Record<string, unknown> | undefined)[] = [{ fieldData: { image: fullImage } }];

    await connector.updateRecords(imageTableSpec, files, changedFields);

    expect(mockUpdateItemsLive).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'item1', fieldData: { image: fullImage } }],
    });
  });

  it('should always use id from files, not changedFields subset', async () => {
    const files: ConnectorFile[] = [{ id: 'correct-id', fieldData: { name: 'New Name' } } as ConnectorFile];
    const changedFields: (Record<string, unknown> | undefined)[] = [{ fieldData: { name: 'New Name' } }];

    await connector.updateRecords(tableSpec, files, changedFields);

    expect(mockUpdateItemsLive).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'correct-id', fieldData: { name: 'New Name' } }],
    });
  });

  describe('never-published fallback (DEV-10642)', () => {
    const files: ConnectorFile[] = [
      { id: 'published', fieldData: { name: 'Live One' } } as ConnectorFile,
      { id: 'never-published', fieldData: { name: 'Draft One' } } as ConnectorFile,
    ];

    it('falls back per-record and routes only the never-published item to the staged endpoint', async () => {
      // Batch live PATCH rejects (atomic: one never-published item sinks it).
      // Per-item: the published item succeeds live; the never-published one
      // rejects live and is retried on the staged endpoint.
      mockUpdateItemsLive.mockReset();
      mockUpdateItemsLive.mockImplementation((_collectionId: string, req: { items: { id: string }[] }) => {
        if (req.items.length > 1) return Promise.reject(neverPublishedError());
        if (req.items[0].id === 'never-published') return Promise.reject(neverPublishedError());
        return Promise.resolve({ items: req.items });
      });
      mockUpdateItemsStaged.mockReset();
      mockUpdateItemsStaged.mockImplementation((_collectionId: string, req: { items: unknown[] }) =>
        Promise.resolve({ items: req.items }),
      );

      const result = await connector.updateRecords(tableSpec, files);

      // First call is the optimistic batch of both items.
      expect(mockUpdateItemsLive).toHaveBeenNthCalledWith(1, 'col1', {
        skipInvalidFiles: false,
        items: [
          { id: 'published', fieldData: { name: 'Live One' } },
          { id: 'never-published', fieldData: { name: 'Draft One' } },
        ],
      });
      // Then each item is retried on its own against the live endpoint.
      expect(mockUpdateItemsLive).toHaveBeenNthCalledWith(2, 'col1', {
        skipInvalidFiles: false,
        items: [{ id: 'published', fieldData: { name: 'Live One' } }],
      });
      expect(mockUpdateItemsLive).toHaveBeenNthCalledWith(3, 'col1', {
        skipInvalidFiles: false,
        items: [{ id: 'never-published', fieldData: { name: 'Draft One' } }],
      });
      // Only the never-published item falls through to the staged endpoint, and
      // its body is byte-for-byte the live body (Connector Prime Directive).
      expect(mockUpdateItemsStaged).toHaveBeenCalledTimes(1);
      expect(mockUpdateItemsStaged).toHaveBeenCalledWith('col1', {
        skipInvalidFiles: false,
        items: [{ id: 'never-published', fieldData: { name: 'Draft One' } }],
      });
      // Both records come back (published via live, draft via staged).
      expect(result.map((f) => f.id).sort()).toEqual(['never-published', 'published']);
    });

    it('propagates non-never-published errors without any staged fallback', async () => {
      mockUpdateItemsLive.mockReset();
      mockUpdateItemsLive.mockRejectedValue(
        Object.assign(new Error('Webflow 400'), {
          isAxiosError: true,
          response: { status: 400, data: { message: 'Validation error: slug is required' } },
        }),
      );
      mockUpdateItemsStaged.mockReset();

      await expect(connector.updateRecords(tableSpec, files)).rejects.toMatchObject({
        response: { status: 400 },
      });
      expect(mockUpdateItemsStaged).not.toHaveBeenCalled();
    });
  });
});
