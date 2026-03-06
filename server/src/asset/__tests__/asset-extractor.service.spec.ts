import { Service } from '@spinner/shared-types';
import { AssetExtractorService } from '../asset-extractor.service';
import { AssetExtractionInput } from '../asset.types';

describe('AssetExtractorService', () => {
  let service: AssetExtractorService;

  beforeEach(() => {
    service = new AssetExtractorService();
  });

  const baseInput = {
    workbookId: 'wb_1',
    recordFilePath: 'folder/record.json',
    recordRemoteId: 'rec_123',
  };

  describe('Airtable attachments', () => {
    it('should extract assets from MULTIPLE_ATTACHMENTS field', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.AIRTABLE,
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

      const result = service.extractAssets(input);
      expect(result).toHaveLength(2);

      expect(result[0]).toMatchObject({
        workbookId: 'wb_1',
        service: Service.AIRTABLE,
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

      // Airtable URLs expire — urlExpiresAt should be set (~2 hours from now)
      for (const entry of result) {
        expect(entry.urlExpiresAt).toBeInstanceOf(Date);
        const diffMs = entry.urlExpiresAt!.getTime() - Date.now();
        expect(diffMs).toBeGreaterThan(1.5 * 60 * 60 * 1000); // > 1.5h
        expect(diffMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000); // <= 2h
      }
    });
  });

  describe('Notion files', () => {
    it('should extract assets from files property', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.NOTION,
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
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(2);

      // Notion hosted file: should hash URL path (before query params)
      expect(result[0]).toMatchObject({
        service: Service.NOTION,
        filename: 'image.png',
        url: 'https://prod-files.notion.so/image.png?X-Amz-Signature=abc',
      });
      // The remoteAssetId should be a hash of the path, not the full URL
      expect(result[0].remoteAssetId).toBe(
        service.hashUrlPath('https://prod-files.notion.so/image.png?X-Amz-Signature=abc'),
      );

      // External file: should hash full URL
      expect(result[1]).toMatchObject({
        filename: 'external.jpg',
        url: 'https://example.com/external.jpg',
      });
    });

    it('should extract cover image', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.NOTION,
        recordContent: {
          id: 'page_1',
          cover: {
            type: 'external',
            external: { url: 'https://images.unsplash.com/cover.jpg' },
          },
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
      };

      const result = service.extractAssets(input);
      expect(result.length).toBeGreaterThanOrEqual(1);

      const coverEntry = result.find((e) => e.url === 'https://images.unsplash.com/cover.jpg');
      expect(coverEntry).toBeDefined();
      expect(coverEntry).toMatchObject({
        url: 'https://images.unsplash.com/cover.jpg',
        mediaType: 'image',
      });
    });

    it('should extract assets from Notion property wrapper format (real API shape)', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.NOTION,
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
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        service: Service.NOTION,
        filename: 'yesno.jpg',
        url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/3fd80bcf/yesno.jpg?X-Amz-Signature=abc',
      });
      expect(result[0].remoteAssetId).toBe(
        service.hashUrlPath(
          'https://prod-files-secure.s3.us-west-2.amazonaws.com/3fd80bcf/yesno.jpg?X-Amz-Signature=abc',
        ),
      );
    });

    it('should extract images from page_content blocks', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.NOTION,
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
      };

      const result = service.extractAssets(input);
      const imageEntry = result.find((e) => e.url === 'https://prod-files.notion.so/block-image.png?sig=xyz');
      expect(imageEntry).toBeDefined();
      expect(imageEntry).toMatchObject({
        mediaType: 'image',
        altText: 'A caption',
        url: 'https://prod-files.notion.so/block-image.png?sig=xyz',
      });
    });
  });

  describe('Webflow images', () => {
    it('should extract assets from Image/MultiImage fields', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.WEBFLOW,
        recordContent: {
          id: 'item_1',
          fieldData: {
            'main-image': {
              url: 'https://uploads-ssl.webflow.com/image.jpg',
              alt: 'Main image',
            },
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
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(3);

      expect(result[0]).toMatchObject({
        url: 'https://uploads-ssl.webflow.com/image.jpg',
        altText: 'Main image',
      });
      expect(result[1]).toMatchObject({
        url: 'https://uploads-ssl.webflow.com/g1.jpg',
        altText: 'Gallery 1',
      });
      expect(result[2]).toMatchObject({
        url: 'https://uploads-ssl.webflow.com/g2.jpg',
        altText: 'Gallery 2',
      });
    });
  });

  describe('Wix Blog hero image', () => {
    it('should extract heroImage as RECORD_PROPERTY', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.WIX_BLOG,
        recordContent: {
          _id: 'post_1',
          heroImage: {
            url: 'https://static.wixstatic.com/media/hero.jpg',
            width: 1200,
            height: 630,
            altText: 'Hero alt',
          },
        },
        schema: {
          properties: {
            _id: { type: 'string' },
            heroImage: {
              type: 'object',
              properties: { url: { type: 'string' } },
              'x-scratch-asset-field': { idPath: null, urlExpires: false },
            },
          },
        },
      };

      const result = service.extractAssets(input);
      const heroEntry = result.find((e) => e.url === 'https://static.wixstatic.com/media/hero.jpg');
      expect(heroEntry).toBeDefined();
      expect(heroEntry).toMatchObject({
        url: 'https://static.wixstatic.com/media/hero.jpg',
        width: 1200,
        height: 630,
        altText: 'Hero alt',
        mediaType: 'image',
      });
    });

    it('should extract images from richContent nodes', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.WIX_BLOG,
        recordContent: {
          _id: 'post_1',
          richContent: {
            nodes: [
              { type: 'PARAGRAPH', paragraphData: {} },
              {
                type: 'IMAGE',
                imageData: {
                  src: { id: 'wix_media_123', url: 'https://static.wixstatic.com/media/inline.jpg' },
                  altText: 'Inline image',
                  width: 800,
                  height: 600,
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
      };

      const result = service.extractAssets(input);
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
  });

  describe('empty/missing data', () => {
    it('should return empty array when no assets found', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.AIRTABLE,
        recordContent: {
          id: 'rec_123',
          fields: { Name: 'Test' },
        },
        schema: {
          properties: {
            id: { type: 'string' },
            fields: {
              type: 'object',
              properties: {
                Name: { type: 'string' },
              },
            },
          },
        },
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(0);
    });

    it('should handle null field values gracefully', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.AIRTABLE,
        recordContent: {
          id: 'rec_123',
          fields: { Photos: null },
        },
        schema: {
          properties: {
            id: { type: 'string' },
            fields: {
              type: 'object',
              properties: {
                Photos: {
                  type: 'array',
                  'x-scratch-asset-field': { idPath: 'id', urlExpires: true },
                },
              },
            },
          },
        },
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(0);
    });
  });

  describe('Standalone entity (ASSET_TABLE)', () => {
    it('should extract WordPress media record as STANDALONE_ENTITY', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.WORDPRESS,
        recordContent: {
          id: 42,
          source_url: 'https://example.com/wp-content/uploads/photo.jpg',
          title: { rendered: 'My Photo' },
          mime_type: 'image/jpeg',
          alt_text: 'A nice photo',
          media_details: {
            filesize: 204800,
            width: 1920,
            height: 1080,
          },
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
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        workbookId: 'wb_1',
        service: Service.WORDPRESS,
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

    it('should extract real WordPress media record (full API response)', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        recordRemoteId: '1057',
        service: Service.WORDPRESS,
        recordContent: {
          id: 1057,
          date: '2026-01-23T15:02:37',
          date_gmt: '2026-01-23T15:02:37',
          guid: {
            rendered: 'https://mpe.nmc.mybluehost.me/wp-content/uploads/2026/01/banner-03.jpg',
            raw: 'https://mpe.nmc.mybluehost.me/wp-content/uploads/2026/01/banner-03.jpg',
          },
          modified: '2026-01-23T15:02:37',
          modified_gmt: '2026-01-23T15:02:37',
          slug: 'banner-03-jpg',
          status: 'inherit',
          type: 'attachment',
          link: 'https://mpe.nmc.mybluehost.me/banner-03-jpg/',
          title: { raw: 'banner-03.jpg', rendered: 'banner-03.jpg' },
          author: 3,
          featured_media: 0,
          comment_status: 'open',
          ping_status: 'closed',
          template: '',
          meta: { _acf_changed: false },
          alt_text: '',
          media_type: 'image',
          mime_type: 'image/jpeg',
          media_details: {
            width: 1920,
            height: 1100,
            file: '2026/01/banner-03.jpg',
            filesize: 242200,
          },
          source_url: 'https://mpe.nmc.mybluehost.me/wp-content/uploads/2026/01/banner-03.jpg',
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
            source_url: { type: 'string', format: 'uri' },
            title: {
              type: 'object',
              properties: { rendered: { type: 'string' }, raw: { type: 'string' } },
            },
            mime_type: { type: 'string' },
            alt_text: { type: 'string' },
            media_details: {
              type: 'object',
              properties: {
                width: { type: 'integer' },
                height: { type: 'integer' },
                filesize: { type: 'integer' },
              },
            },
          },
        },
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        workbookId: 'wb_1',
        service: Service.WORDPRESS,
        remoteAssetId: '1057',
        url: 'https://mpe.nmc.mybluehost.me/wp-content/uploads/2026/01/banner-03.jpg',
        filename: 'banner-03.jpg',
        mimeType: 'image/jpeg',
        size: 242200,
        width: 1920,
        height: 1100,
        mediaType: 'image',
      });
    });

    it('should extract Webflow asset record as STANDALONE_ENTITY', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.WEBFLOW,
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
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        service: Service.WEBFLOW,
        remoteAssetId: 'rec_123',
        url: 'https://uploads-ssl.webflow.com/logo.png',
        filename: 'logo-original.png',
        mimeType: 'image/png',
        size: 51200,
        altText: 'Company logo',
        mediaType: 'image',
      });
      expect(result[0].width).toBeUndefined();
      expect(result[0].height).toBeUndefined();
    });

    it('should skip Phase 1 and Phase 2 when ASSET_TABLE is present', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.WORDPRESS,
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
      };

      const result = service.extractAssets(input);
      // Should only have the standalone entry, not an extra entry from source_url
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe('https://example.com/wp-content/uploads/photo.jpg');
    });

    it('should fall back to URL hash when recordRemoteId is missing', () => {
      const input: AssetExtractionInput = {
        workbookId: 'wb_1',
        service: Service.WORDPRESS,
        recordFilePath: 'folder/record.json',
        // no recordRemoteId
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
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(1);
      expect(result[0].remoteAssetId).toBe(service.hashUrl('https://example.com/photo.jpg'));
    });

    it('should return empty when URL path resolves to nothing', () => {
      const input: AssetExtractionInput = {
        ...baseInput,
        service: Service.WORDPRESS,
        recordContent: {
          id: 42,
          // no source_url
        },
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
      };

      const result = service.extractAssets(input);
      expect(result).toHaveLength(0);
    });
  });

  describe('hash functions', () => {
    it('should produce consistent hashes for the same URL', () => {
      const hash1 = service.hashUrl('https://example.com/file.jpg');
      const hash2 = service.hashUrl('https://example.com/file.jpg');
      expect(hash1).toBe(hash2);
    });

    it('should hash only the path for expiring URLs', () => {
      const hash1 = service.hashUrlPath('https://example.com/file.jpg?token=abc');
      const hash2 = service.hashUrlPath('https://example.com/file.jpg?token=xyz');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different URLs', () => {
      const hash1 = service.hashUrl('https://example.com/file1.jpg');
      const hash2 = service.hashUrl('https://example.com/file2.jpg');
      expect(hash1).not.toBe(hash2);
    });
  });
});
