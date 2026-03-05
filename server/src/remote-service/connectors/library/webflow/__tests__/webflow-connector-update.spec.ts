import { Type } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { WebflowConnector } from '../webflow-connector';

// Mock display-names to break circular import chain (it imports all connectors)
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the webflow-api module
const mockUpdateItems = jest.fn().mockResolvedValue({});
jest.mock('webflow-api', () => ({
  WebflowClient: jest.fn().mockImplementation(() => ({
    collections: {
      items: {
        updateItems: mockUpdateItems,
      },
    },
  })),
  Webflow: {
    FieldType: {
      PlainText: 'PlainText',
      RichText: 'RichText',
    },
  },
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
  } as BaseJsonTableSpec;
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

  it('should send only changed fieldData when changedKeys is provided', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'New Name', slug: 'old-slug', body: '<p>old</p>' } } as ConnectorFile,
    ];
    const changedKeys: (string[] | undefined)[] = [['fieldData']];

    await connector.updateRecords(tableSpec, files, changedKeys);

    expect(mockUpdateItems).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'item1', fieldData: { name: 'New Name', slug: 'old-slug', body: 'minified:<p>old</p>' } }],
    });
  });

  it('should send full fieldData when changedKeys is undefined', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'Full Name', slug: 'full-slug' } } as ConnectorFile,
    ];

    await connector.updateRecords(tableSpec, files);

    expect(mockUpdateItems).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'item1', fieldData: { name: 'Full Name', slug: 'full-slug' } }],
    });
  });

  it('should fall back to full content when changedKeys[i] is undefined', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'Changed', slug: 'changed-slug' } } as ConnectorFile,
      { id: 'item2', fieldData: { name: 'Full Content', slug: 'full-slug' } } as ConnectorFile,
    ];
    const changedKeys: (string[] | undefined)[] = [['fieldData'], undefined];

    await connector.updateRecords(tableSpec, files, changedKeys);

    expect(mockUpdateItems).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [
        { id: 'item1', fieldData: { name: 'Changed', slug: 'changed-slug' } },
        { id: 'item2', fieldData: { name: 'Full Content', slug: 'full-slug' } },
      ],
    });
  });

  it('should minify RichText fields in partial update from changedKeys', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'Name', body: '<p>  new content  </p>' } } as ConnectorFile,
    ];
    const changedKeys: (string[] | undefined)[] = [['fieldData']];

    await connector.updateRecords(tableSpec, files, changedKeys);

    expect(mockedMinifyHtml).toHaveBeenCalledWith('<p>  new content  </p>');
    expect(mockUpdateItems).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'item1', fieldData: { name: 'Name', body: 'minified:<p>  new content  </p>' } }],
    });
  });

  it('should filter out fields not in schema from partial update', async () => {
    const files: ConnectorFile[] = [
      { id: 'item1', fieldData: { name: 'New Name', unknownField: 'should be filtered' } } as ConnectorFile,
    ];
    const changedKeys: (string[] | undefined)[] = [['fieldData']];

    await connector.updateRecords(tableSpec, files, changedKeys);

    expect(mockUpdateItems).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'item1', fieldData: { name: 'New Name' } }],
    });
  });

  it('should always use id from files, not changedKeys subset', async () => {
    const files: ConnectorFile[] = [{ id: 'correct-id', fieldData: { name: 'New Name' } } as ConnectorFile];
    const changedKeys: (string[] | undefined)[] = [['fieldData']];

    await connector.updateRecords(tableSpec, files, changedKeys);

    expect(mockUpdateItems).toHaveBeenCalledWith('col1', {
      skipInvalidFiles: false,
      items: [{ id: 'correct-id', fieldData: { name: 'New Name' } }],
    });
  });
});
