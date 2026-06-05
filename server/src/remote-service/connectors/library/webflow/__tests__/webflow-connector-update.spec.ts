import { Type } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { WebflowConnector } from '../webflow-connector';

// Mock display-names to break circular import chain (it imports all connectors)
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the WebflowApiClient so the connector's internal `this.client` is the
// mock — we only need its flat `updateItemsLive` method here.
const mockUpdateItemsLive = jest.fn().mockResolvedValue({});
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({
    updateItemsLive: mockUpdateItemsLive,
  })),
  WebflowError: class WebflowError extends Error {},
}));

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

  it('should always use id from files, not changedFields subset', async () => {
    const files: ConnectorFile[] = [{ id: 'correct-id', fieldData: { name: 'New Name' } } as ConnectorFile];
    const changedFields: (Record<string, unknown> | undefined)[] = [{ fieldData: { name: 'New Name' } }];

    await connector.updateRecords(tableSpec, files, changedFields);

    expect(mockUpdateItemsLive).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'correct-id', fieldData: { name: 'New Name' } }],
    });
  });
});
