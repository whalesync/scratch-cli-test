import { NotionFileUrlOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { notionFileUrlTransformer } from '../implementations/notion-file-url.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options?: NotionFileUrlOptions): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { value: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.NOTION,
    destinationFieldPath: 'value',
    destinationTableSpec: null,
    destinationService: Service.WEBFLOW,
    lookupTools: createNullLookupTools(),
    options: options ?? {},
    phase: 'DATA',
  };
}

describe('notionFileUrlTransformer', () => {
  it('should have correct type', () => {
    expect(notionFileUrlTransformer.type).toBe('notion_file_url');
  });

  it('should return null for null input', async () => {
    const result = await notionFileUrlTransformer.transform(createContext(null));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should return null for undefined input', async () => {
    const result = await notionFileUrlTransformer.transform(createContext(undefined));
    expect(result).toEqual({ success: true, value: null });
  });

  describe('Notion property wrapper input', () => {
    it('should unwrap files array from property wrapper and extract hosted file URL', async () => {
      const input = {
        id: 'gh%3FQ',
        type: 'files',
        files: [
          {
            name: 'yesno.jpg',
            type: 'file',
            file: {
              url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/3fd80bcf/yesno.jpg?X-Amz-Signature=abc123',
              expiry_time: '2026-03-11T21:04:26.289Z',
            },
          },
        ],
      };
      const result = await notionFileUrlTransformer.transform(createContext(input));
      expect(result).toEqual({
        success: true,
        value: ['https://prod-files-secure.s3.us-west-2.amazonaws.com/3fd80bcf/yesno.jpg'],
      });
    });

    it('should unwrap files array from property wrapper and extract external URL', async () => {
      const input = {
        id: 'abc',
        type: 'files',
        files: [
          {
            name: 'photo.jpg',
            type: 'external',
            external: { url: 'https://example.com/photo.jpg?token=abc' },
          },
        ],
      };
      const result = await notionFileUrlTransformer.transform(createContext(input));
      expect(result).toEqual({ success: true, value: ['https://example.com/photo.jpg'] });
    });

    it('should handle mixed external and hosted files in property wrapper', async () => {
      const input = {
        id: 'mix',
        type: 'files',
        files: [
          { name: 'ext.png', type: 'external', external: { url: 'https://example.com/ext.png' } },
          {
            name: 'hosted.jpg',
            type: 'file',
            file: { url: 'https://s3.amazonaws.com/hosted.jpg?sig=abc', expiry_time: '2026-01-01T00:00:00Z' },
          },
        ],
      };
      const result = await notionFileUrlTransformer.transform(createContext(input));
      expect(result).toEqual({
        success: true,
        value: ['https://example.com/ext.png', 'https://s3.amazonaws.com/hosted.jpg'],
      });
    });

    it('should return null for property wrapper with empty files array', async () => {
      const input = { id: 'empty', type: 'files', files: [] };
      const result = await notionFileUrlTransformer.transform(createContext(input));
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe('bare array input', () => {
    it('should handle a bare array of file items', async () => {
      const input = [{ name: 'a.png', type: 'external', external: { url: 'https://example.com/a.png?v=1' } }];
      const result = await notionFileUrlTransformer.transform(createContext(input));
      expect(result).toEqual({ success: true, value: ['https://example.com/a.png'] });
    });

    it('should return null for empty bare array', async () => {
      const result = await notionFileUrlTransformer.transform(createContext([]));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should skip items without extractable URLs', async () => {
      const input = [
        { name: 'broken', type: 'unknown' },
        { name: 'ok.png', type: 'external', external: { url: 'https://example.com/ok.png' } },
      ];
      const result = await notionFileUrlTransformer.transform(createContext(input));
      expect(result).toEqual({ success: true, value: ['https://example.com/ok.png'] });
    });
  });

  describe('arrayHandling option', () => {
    it('should return first URL when arrayHandling is "first"', async () => {
      const input = {
        id: 'multi',
        type: 'files',
        files: [
          { name: 'a.png', type: 'external', external: { url: 'https://example.com/a.png' } },
          { name: 'b.png', type: 'external', external: { url: 'https://example.com/b.png' } },
        ],
      };
      const result = await notionFileUrlTransformer.transform(createContext(input, { arrayHandling: 'first' }));
      expect(result).toEqual({ success: true, value: 'https://example.com/a.png' });
    });

    it('should return array by default', async () => {
      const input = {
        id: 'multi',
        type: 'files',
        files: [{ name: 'a.png', type: 'external', external: { url: 'https://example.com/a.png' } }],
      };
      const result = await notionFileUrlTransformer.transform(createContext(input));
      expect(result).toEqual({ success: true, value: ['https://example.com/a.png'] });
    });
  });

  describe('edge cases', () => {
    it('should handle a single file item object (not in array or wrapper)', async () => {
      const input = { name: 'solo.png', type: 'external', external: { url: 'https://example.com/solo.png?v=1' } };
      const result = await notionFileUrlTransformer.transform(createContext(input));
      expect(result).toEqual({ success: true, value: ['https://example.com/solo.png'] });
    });

    it('should handle item with direct url property', async () => {
      const input = { id: 'x', type: 'files', files: [{ url: 'https://example.com/direct.png?q=1' }] };
      const result = await notionFileUrlTransformer.transform(createContext(input));
      expect(result).toEqual({ success: true, value: ['https://example.com/direct.png'] });
    });
  });
});
