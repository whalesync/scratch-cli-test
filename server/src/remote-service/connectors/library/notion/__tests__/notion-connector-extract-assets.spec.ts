import { ConnectorAssetExtractionInput } from 'src/asset/asset.types';
import { stripQueryParams } from '../../../asset-extraction-helpers';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'MockService'),
}));

jest.mock('@notionhq/client', () => ({
  Client: jest.fn().mockImplementation(() => ({})),
  APIResponseError: class extends Error {},
  RequestTimeoutError: { isRequestTimeoutError: jest.fn(() => false) },
  APIErrorCode: {},
  isFullDatabase: jest.fn(() => true),
  isFullDataSource: jest.fn(() => true),
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

import { NotionConnector } from '../notion-connector';
import notionPage from './testdata/notion-page-with-assets.json';

const notion = new NotionConnector('fake-key');

// Schema matching the real Notion table spec for this page
const notionSchema: Record<string, unknown> = {
  properties: {
    id: { type: 'string' },
    cover: {
      anyOf: [{ type: 'object' }, { type: 'null' }],
      'x-scratch-asset-field': { idPath: null, urlExpires: true },
    },
    icon: {
      anyOf: [{ type: 'object' }, { type: 'null' }],
      'x-scratch-asset-field': { idPath: null, urlExpires: true },
    },
    properties: {
      type: 'object',
      properties: {
        'Files & media': {
          type: 'array',
          'x-scratch-asset-field': { idPath: null, urlExpires: true },
          anyOf: [
            { type: 'object', properties: { type: { const: 'external' } } },
            { type: 'object', properties: { type: { const: 'file' } } },
          ],
        },
        'Webflow Status': {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
        Title: { type: 'string' },
      },
    },
    page_content: { type: 'array', items: { type: 'object' } },
  },
};

describe('NotionConnector.extractAssets (real page data)', () => {
  const input: ConnectorAssetExtractionInput = {
    recordContent: notionPage as unknown as Record<string, unknown>,
    schema: notionSchema,
    recordRemoteId: notionPage.id,
  };

  let results: ReturnType<typeof notion.extractAssets>;

  beforeAll(() => {
    results = notion.extractAssets(input);
  });

  it('should extract exactly 2 assets (1 property file + 1 content block image)', () => {
    expect(results).toHaveLength(2);
  });

  it('should extract the hosted file from the Files & media property', () => {
    const yesno = results.find((r) => r.filename === 'yesno.jpg');
    expect(yesno).toBeDefined();
    expect(yesno).toMatchObject({
      filename: 'yesno.jpg',
      url: notionPage.properties['Files & media'].files[0].file.url,
      mediaType: 'image',
    });
  });

  it('should use stripped URL (no query string) as remoteAssetId for the property file', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const yesno = results.find((r) => r.filename === 'yesno.jpg')!;
    const expectedId = stripQueryParams(notionPage.properties['Files & media'].files[0].file.url);
    expect(yesno.remoteAssetId).toBe(expectedId);
  });

  it('should parse the expiry_time from the property file', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const yesno = results.find((r) => r.filename === 'yesno.jpg')!;
    expect(yesno.urlExpiresAt).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(yesno.urlExpiresAt!.toISOString()).toBe('2026-03-11T19:14:12.210Z');
  });

  it('should extract the image from page_content blocks', () => {
    const blockImage = results.find((r) => r.url?.includes('sample-08.png'));
    expect(blockImage).toBeDefined();
    expect(blockImage).toMatchObject({
      mediaType: 'image',
    });
  });

  it('should use stripped URL (no query string) as remoteAssetId for the content block image', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const blockImage = results.find((r) => r.url?.includes('sample-08.png'))!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const expectedId = stripQueryParams(notionPage.page_content[0].image!.file.url);
    expect(blockImage.remoteAssetId).toBe(expectedId);
  });

  it('should parse the expiry_time from the content block image', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const blockImage = results.find((r) => r.url?.includes('sample-08.png'))!;
    expect(blockImage.urlExpiresAt).toBeInstanceOf(Date);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(blockImage.urlExpiresAt!.toISOString()).toBe('2026-03-11T19:14:12.393Z');
  });

  it('should not extract assets from null cover or icon', () => {
    const coverOrIcon = results.filter((r) => r.url?.includes('cover') || r.url?.includes('icon'));
    expect(coverOrIcon).toHaveLength(0);
  });

  it('should not extract assets from non-media blocks (paragraph)', () => {
    // The page_content has a paragraph block — it should be skipped
    expect(results.every((r) => r.mediaType !== undefined)).toBe(true);
    expect(results).toHaveLength(2); // Only the image block, not the paragraph
  });
});
