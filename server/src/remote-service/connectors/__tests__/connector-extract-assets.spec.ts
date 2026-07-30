import { ConnectorAssetExtractionInput } from 'src/asset/asset.types';
import { hashUrl, stripQueryParams } from '../asset-extraction-helpers';

// Mock display-names to break circular import chain (it imports all connectors)
jest.mock('../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'MockService'),
}));

// Mock external SDK dependencies used in connector constructors
jest.mock('@notionhq/client', () => ({
  Client: jest.fn().mockImplementation(() => ({})),
  APIResponseError: class extends Error {},
  RequestTimeoutError: { isRequestTimeoutError: jest.fn(() => false) },
  APIErrorCode: {},
  isFullDatabase: jest.fn(() => true),
  isFullDataSource: jest.fn(() => true),
}));

jest.mock('../library/webflow/webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({})),
  WebflowError: class extends Error {},
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

jest.mock('@wix/sdk', () => ({
  createClient: jest.fn(() => ({})),
  OAuthStrategy: jest.fn(() => ({})),
  TokenRole: { VISITOR: 'visitor' },
}));
jest.mock('@wix/blog', () => ({ draftPosts: {} }));
jest.mock('@wix/members', () => ({ members: {} }));

jest.mock('src/wrappers/html-minify', () => ({
  minifyHtml: jest.fn((html: string) => html),
}));

import { AirtableConnector } from '../library/airtable/airtable-connector';
import { NotionConnector } from '../library/notion/notion-connector';
import { WebflowConnector } from '../library/webflow/webflow-connector';
import { WixBlogConnector } from '../library/wix/wix-blog/wix-blog-connector';
import { WordPressConnector } from '../library/wordpress/wordpress-connector';

// Connectors instantiated with dummy credentials (extractAssets doesn't call APIs)
const airtable = new AirtableConnector('fake-key');
const notion = new NotionConnector('fake-key');
const webflow = new WebflowConnector('fake-token');
const wordpress = new WordPressConnector('user', 'pass', 'https://example.com');
const wixBlog = new WixBlogConnector('fake-token');

describe('Connector.extractAssets', () => {
  describe('AirtableConnector', () => {
    it('should extract assets from MULTIPLE_ATTACHMENTS field', () => {
      const input: ConnectorAssetExtractionInput = {
        recordContent: {
          id: 'rec_123',
          fields: {
            Photos: [
              {
                id: 'att_1',
                url: 'https://dl.airtable.com/photo1.jpg',
                filename: 'photo1.jpg',
                size: 1024,
                type: 'image/jpeg',
              },
              {
                id: 'att_2',
                url: 'https://dl.airtable.com/doc.pdf',
                filename: 'doc.pdf',
                size: 2048,
                type: 'application/pdf',
              },
            ],
          },
        },
        schema: {
          properties: {
            id: { type: 'string' },
            fields: {
              type: 'object',
              properties: {
                Photos: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      url: { type: 'string' },
                    },
                  },
                  'x-scratch-asset-field': { idPath: 'id', urlExpires: true },
                },
              },
            },
          },
        },
      };

      const result = airtable.extractAssets(input);
      expect(result).toHaveLength(2);

      expect(result[0]).toMatchObject({
        remoteAssetId: 'att_1',
        url: 'https://dl.airtable.com/photo1.jpg',
        filename: 'photo1.jpg',
        size: 1024,
        mimeType: 'image/jpeg',
        mediaType: 'image',
      });

      expect(result[1]).toMatchObject({
        remoteAssetId: 'att_2',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        mediaType: 'document',
      });

      for (const entry of result) {
        expect(entry.urlExpiresAt).toBeInstanceOf(Date);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const diffMs = entry.urlExpiresAt!.getTime() - Date.now();
        expect(diffMs).toBeGreaterThan(1.5 * 60 * 60 * 1000);
        expect(diffMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
      }
    });

    it('should return empty for no asset fields', () => {
      const result = airtable.extractAssets({
        recordContent: { id: 'rec_1', fields: { Name: 'Test' } },
        schema: {
          properties: {
            id: { type: 'string' },
            fields: { type: 'object', properties: { Name: { type: 'string' } } },
          },
        },
      });
      expect(result).toHaveLength(0);
    });

    it('should handle null field values gracefully', () => {
      const result = airtable.extractAssets({
        recordContent: { id: 'rec_1', fields: { Photos: null } },
        schema: {
          properties: {
            id: { type: 'string' },
            fields: {
              type: 'object',
              properties: {
                Photos: { type: 'array', 'x-scratch-asset-field': { idPath: 'id', urlExpires: true } },
              },
            },
          },
        },
      });
      expect(result).toHaveLength(0);
    });
  });

  describe('NotionConnector', () => {
    it('should extract assets from files property', () => {
      const result = notion.extractAssets({
        recordContent: {
          id: 'page_1',
          properties: {
            Attachments: [
              {
                name: 'image.png',
                type: 'file',
                file: {
                  url: 'https://prod-files.notion.so/image.png?X-Amz-Signature=abc',
                  expiry_time: '2026-03-02T12:00:00.000Z',
                },
              },
              {
                name: 'external.jpg',
                type: 'external',
                external: { url: 'https://example.com/external.jpg' },
              },
            ],
          },
        },
        schema: {
          properties: {
            id: { type: 'string' },
            properties: {
              type: 'object',
              properties: {
                Attachments: {
                  type: 'array',
                  'x-scratch-asset-field': { idPath: null, urlExpires: true },
                  anyOf: [
                    { type: 'object', properties: { type: { const: 'external' } } },
                    { type: 'object', properties: { type: { const: 'file' } } },
                  ],
                },
              },
            },
          },
        },
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        filename: 'image.png',
        url: 'https://prod-files.notion.so/image.png?X-Amz-Signature=abc',
      });
      expect(result[0].remoteAssetId).toBe('https://prod-files.notion.so/image.png');
      expect(result[1]).toMatchObject({
        filename: 'external.jpg',
        url: 'https://example.com/external.jpg',
      });
    });

    it('should extract cover image', () => {
      const result = notion.extractAssets({
        recordContent: {
          id: 'page_1',
          cover: { type: 'external', external: { url: 'https://images.unsplash.com/cover.jpg' } },
          properties: {},
        },
        schema: {
          properties: {
            id: { type: 'string' },
            cover: {
              anyOf: [{ type: 'object' }, { type: 'null' }],
              'x-scratch-asset-field': { idPath: null, urlExpires: true },
            },
            properties: { type: 'object', properties: {} },
          },
        },
      });

      expect(result.length).toBeGreaterThanOrEqual(1);
      const cover = result.find((e) => e.url === 'https://images.unsplash.com/cover.jpg');
      expect(cover).toBeDefined();
      expect(cover).toMatchObject({ url: 'https://images.unsplash.com/cover.jpg', mediaType: 'image' });
    });

    it('should extract assets from Notion property wrapper format', () => {
      const result = notion.extractAssets({
        recordContent: {
          id: 'page_1',
          properties: {
            'Files & media': {
              id: 'gh%3FQ',
              type: 'files',
              files: [
                {
                  name: 'yesno.jpg',
                  type: 'file',
                  file: {
                    url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/3fd80bcf/yesno.jpg?X-Amz-Signature=abc',
                    expiry_time: '2026-03-03T21:04:28.566Z',
                  },
                },
              ],
            },
          },
        },
        schema: {
          properties: {
            id: { type: 'string' },
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
              },
            },
          },
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        filename: 'yesno.jpg',
        url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/3fd80bcf/yesno.jpg?X-Amz-Signature=abc',
      });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result[0].remoteAssetId).toBe(stripQueryParams(result[0].url!));
    });

    it('should extract images from page_content blocks', () => {
      const result = notion.extractAssets({
        recordContent: {
          id: 'page_1',
          page_content: [
            { type: 'paragraph', paragraph: { text: 'hello' } },
            {
              type: 'image',
              image: {
                type: 'file',
                file: {
                  url: 'https://prod-files.notion.so/block-image.png?sig=xyz',
                  expiry_time: '2026-03-02T14:00:00.000Z',
                },
                caption: [{ plain_text: 'A caption' }],
              },
            },
          ],
          properties: {},
        },
        schema: {
          properties: {
            id: { type: 'string' },
            page_content: { type: 'array', items: { type: 'object' } },
            properties: { type: 'object', properties: {} },
          },
        },
      });

      const imageEntry = result.find((e) => e.url === 'https://prod-files.notion.so/block-image.png?sig=xyz');
      expect(imageEntry).toBeDefined();
      expect(imageEntry).toMatchObject({
        mediaType: 'image',
        altText: 'A caption',
        url: 'https://prod-files.notion.so/block-image.png?sig=xyz',
      });
    });
  });

  describe('WebflowConnector', () => {
    it('should extract assets from Image/MultiImage fields', () => {
      const result = webflow.extractAssets({
        recordContent: {
          id: 'item_1',
          fieldData: {
            'main-image': { url: 'https://uploads-ssl.webflow.com/image.jpg', alt: 'Main image' },
            gallery: [
              { url: 'https://uploads-ssl.webflow.com/g1.jpg', alt: 'Gallery 1' },
              { url: 'https://uploads-ssl.webflow.com/g2.jpg', alt: 'Gallery 2' },
            ],
          },
        },
        schema: {
          properties: {
            id: { type: 'string' },
            fieldData: {
              type: 'object',
              properties: {
                'main-image': {
                  type: 'object',
                  properties: { url: { type: 'string' }, alt: { type: 'string' } },
                  'x-scratch-asset-field': { idPath: null, urlExpires: false },
                },
                gallery: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { url: { type: 'string' }, alt: { type: 'string' } },
                  },
                  'x-scratch-asset-field': { idPath: null, urlExpires: false },
                },
              },
            },
          },
        },
      });

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ url: 'https://uploads-ssl.webflow.com/image.jpg', altText: 'Main image' });
      expect(result[1]).toMatchObject({ url: 'https://uploads-ssl.webflow.com/g1.jpg', altText: 'Gallery 1' });
      expect(result[2]).toMatchObject({ url: 'https://uploads-ssl.webflow.com/g2.jpg', altText: 'Gallery 2' });
    });

    it('should extract Webflow asset record as standalone entity', () => {
      const result = webflow.extractAssets({
        recordRemoteId: 'rec_123',
        recordContent: {
          id: 'asset_abc',
          displayName: 'logo.png',
          hostedUrl: 'https://uploads-ssl.webflow.com/logo.png',
          originalFileName: 'logo-original.png',
          contentType: 'image/png',
          size: 51200,
          altText: 'Company logo',
        },
        schema: {
          'x-scratch-asset-table': {
            urlPath: 'hostedUrl',
            filenamePath: 'originalFileName',
            mimeTypePath: 'contentType',
            sizePath: 'size',
            widthPath: null,
            heightPath: null,
            altTextPath: 'altText',
            urlExpires: false,
          },
          properties: {
            id: { type: 'string' },
            hostedUrl: { type: 'string' },
          },
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        remoteAssetId: 'rec_123',
        url: 'https://uploads-ssl.webflow.com/logo.png',
        filename: 'logo-original.png',
        mimeType: 'image/png',
        size: 51200,
        altText: 'Company logo',
        mediaType: 'image',
      });
    });
  });

  describe('WordPressConnector', () => {
    it('should extract WordPress media record as standalone entity', () => {
      const result = wordpress.extractAssets({
        recordRemoteId: 'rec_123',
        recordContent: {
          id: 42,
          source_url: 'https://example.com/wp-content/uploads/photo.jpg',
          title: { rendered: 'My Photo' },
          mime_type: 'image/jpeg',
          alt_text: 'A nice photo',
          media_details: { filesize: 204800, width: 1920, height: 1080 },
        },
        schema: {
          'x-scratch-asset-table': {
            urlPath: 'source_url',
            filenamePath: 'title.rendered',
            mimeTypePath: 'mime_type',
            sizePath: 'media_details.filesize',
            widthPath: 'media_details.width',
            heightPath: 'media_details.height',
            altTextPath: 'alt_text',
            urlExpires: false,
          },
          properties: {
            id: { type: 'integer' },
            source_url: { type: 'string' },
          },
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        remoteAssetId: 'rec_123',
        url: 'https://example.com/wp-content/uploads/photo.jpg',
        filename: 'My Photo',
        mimeType: 'image/jpeg',
        size: 204800,
        width: 1920,
        height: 1080,
        altText: 'A nice photo',
        mediaType: 'image',
      });
    });

    it('should skip Phase 1 when ASSET_TABLE is present', () => {
      const result = wordpress.extractAssets({
        recordRemoteId: 'rec_123',
        recordContent: {
          id: 42,
          source_url: 'https://example.com/wp-content/uploads/photo.jpg',
          mime_type: 'image/jpeg',
          title: { rendered: 'Photo' },
          alt_text: '',
          media_details: { width: 100, height: 100 },
        },
        schema: {
          'x-scratch-asset-table': {
            urlPath: 'source_url',
            filenamePath: 'title.rendered',
            mimeTypePath: 'mime_type',
            sizePath: null,
            widthPath: 'media_details.width',
            heightPath: 'media_details.height',
            altTextPath: 'alt_text',
            urlExpires: false,
          },
          properties: {
            id: { type: 'integer' },
            source_url: {
              type: 'string',
              'x-scratch-asset-field': { idPath: null, urlExpires: false },
            },
          },
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0].url).toBe('https://example.com/wp-content/uploads/photo.jpg');
    });

    it('should fall back to URL hash when recordRemoteId is missing', () => {
      const result = wordpress.extractAssets({
        recordContent: {
          id: 42,
          source_url: 'https://example.com/photo.jpg',
          mime_type: 'image/jpeg',
          title: { rendered: 'Photo' },
          alt_text: '',
          media_details: {},
        },
        schema: {
          'x-scratch-asset-table': {
            urlPath: 'source_url',
            filenamePath: 'title.rendered',
            mimeTypePath: 'mime_type',
            sizePath: null,
            widthPath: null,
            heightPath: null,
            altTextPath: null,
            urlExpires: false,
          },
          properties: {},
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0].remoteAssetId).toBe(hashUrl('https://example.com/photo.jpg'));
    });

    it('should return empty when URL path resolves to nothing', () => {
      const result = wordpress.extractAssets({
        recordRemoteId: 'rec_123',
        recordContent: { id: 42 },
        schema: {
          'x-scratch-asset-table': {
            urlPath: 'source_url',
            filenamePath: null,
            mimeTypePath: null,
            sizePath: null,
            widthPath: null,
            heightPath: null,
            altTextPath: null,
            urlExpires: false,
          },
          properties: {},
        },
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('WixBlogConnector', () => {
    // These fixtures use the shapes the `@wix/blog` SDK ACTUALLY returns. The previous versions used
    // a synthetic `heroImage` object and a flattened `imageData.src`, neither of which Wix ever
    // emits, so both phases of extractAssets passed their tests while extracting nothing from live
    // data (DEV-11117 / DEV-11122).
    it('should extract the cover image from the Wix media URI', () => {
      const result = wixBlog.extractAssets({
        recordContent: {
          _id: 'post_1',
          media: {
            wixMedia: {
              image:
                'wix:image://v1/9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg/Whales.jpg#originWidth=1024&originHeight=1024',
            },
            displayed: true,
            custom: true,
          },
        },
        schema: {
          properties: {
            _id: { type: 'string' },
            media: { type: 'object', properties: { wixMedia: { type: 'object' } } },
          },
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        remoteAssetId: '9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg',
        url: 'https://static.wixstatic.com/media/9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg',
        mediaType: 'image',
      });
    });

    it('should extract a cover image whose URI has no filename segment', () => {
      const result = wixBlog.extractAssets({
        recordContent: {
          _id: 'post_1',
          media: { wixMedia: { image: 'wix:image://v1/abc_123~mv2.jpg#originWidth=1200&originHeight=800' } },
        },
        schema: { properties: { _id: { type: 'string' }, media: { type: 'object' } } },
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        remoteAssetId: 'abc_123~mv2.jpg',
        url: 'https://static.wixstatic.com/media/abc_123~mv2.jpg',
      });
    });

    it('should extract nothing when the post has no cover media', () => {
      const result = wixBlog.extractAssets({
        recordContent: { _id: 'post_1', media: { displayed: true, custom: false } },
        schema: { properties: { _id: { type: 'string' }, media: { type: 'object' } } },
      });

      expect(result).toHaveLength(0);
    });

    it('should extract images from richContent nodes', () => {
      const result = wixBlog.extractAssets({
        recordContent: {
          _id: 'post_1',
          richContent: {
            nodes: [
              { type: 'PARAGRAPH', paragraphData: {} },
              {
                type: 'IMAGE',
                imageData: {
                  // The real Wix nesting: src/width/height live under `imageData.image`, matching
                  // rich-content/types.ts and the HTML converter.
                  image: {
                    src: { id: 'wix_media_123', url: 'https://static.wixstatic.com/media/inline.jpg' },
                    width: 800,
                    height: 600,
                  },
                  altText: 'Inline image',
                },
              },
            ],
          },
        },
        schema: {
          properties: {
            _id: { type: 'string' },
            richContent: {
              type: 'object',
              properties: { nodes: { type: 'array' } },
            },
          },
        },
      });

      const imageEntry = result.find((e) => e.remoteAssetId === 'wix_media_123');
      expect(imageEntry).toBeDefined();
      expect(imageEntry).toMatchObject({
        remoteAssetId: 'wix_media_123',
        url: 'https://static.wixstatic.com/media/inline.jpg',
        altText: 'Inline image',
        width: 800,
        height: 600,
        mediaType: 'image',
      });
    });

    it('should fall back to the media id when a Ricos image carries no URL', () => {
      const result = wixBlog.extractAssets({
        recordContent: {
          _id: 'post_1',
          richContent: {
            nodes: [{ type: 'IMAGE', imageData: { image: { src: { id: 'only_id~mv2.png' } } } }],
          },
        },
        schema: { properties: { _id: { type: 'string' }, richContent: { type: 'object' } } },
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        remoteAssetId: 'only_id~mv2.png',
        url: 'https://static.wixstatic.com/media/only_id~mv2.png',
      });
    });
  });
});
