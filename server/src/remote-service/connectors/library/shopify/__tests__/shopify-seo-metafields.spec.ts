import { extractSeoMetafieldsFromVerbatimFields } from '../shopify-api-client';

describe('SEO metafield helpers', () => {
  describe('extractSeoMetafieldsFromVerbatimFields', () => {
    it('converts verbatim seoTitle/seoDescription into a metafields array', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seoTitle: { value: 'SEO Title' },
        seoDescription: { value: 'SEO Desc' },
      };

      extractSeoMetafieldsFromVerbatimFields(input);

      expect(input.seoTitle).toBeUndefined();
      expect(input.seoDescription).toBeUndefined();
      expect(input.metafields).toEqual([
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'SEO Title' },
        { namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: 'SEO Desc' },
      ]);
    });

    it('handles partial — only seoTitle present', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seoTitle: { value: 'SEO Title' },
      };

      extractSeoMetafieldsFromVerbatimFields(input);

      expect(input.seoTitle).toBeUndefined();
      expect(input.metafields).toEqual([
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'SEO Title' },
      ]);
    });

    it('handles partial — only seoDescription present', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seoDescription: { value: 'SEO Desc' },
      };

      extractSeoMetafieldsFromVerbatimFields(input);

      expect(input.seoDescription).toBeUndefined();
      expect(input.metafields).toEqual([
        { namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: 'SEO Desc' },
      ]);
    });

    it('emits no metafields when both fields are null', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seoTitle: null,
        seoDescription: null,
      };

      extractSeoMetafieldsFromVerbatimFields(input);

      expect(input.seoTitle).toBeUndefined();
      expect(input.seoDescription).toBeUndefined();
      expect(input.metafields).toBeUndefined();
    });

    it('emits no metafields when a field is present but its value is null', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seoTitle: { value: null },
        seoDescription: { value: null },
      };

      extractSeoMetafieldsFromVerbatimFields(input);

      expect(input.metafields).toBeUndefined();
    });

    it('is a no-op when both SEO fields are absent', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        body: 'content',
      };

      extractSeoMetafieldsFromVerbatimFields(input);

      expect(input.seoTitle).toBeUndefined();
      expect(input.seoDescription).toBeUndefined();
      expect(input.metafields).toBeUndefined();
      expect(input.title).toBe('My Page');
      expect(input.body).toBe('content');
    });

    it('merges with existing metafields', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seoTitle: { value: 'SEO Title' },
        metafields: [{ namespace: 'custom', key: 'foo', type: 'single_line_text_field', value: 'bar' }],
      };

      extractSeoMetafieldsFromVerbatimFields(input);

      expect(input.seoTitle).toBeUndefined();
      expect(input.metafields).toEqual([
        { namespace: 'custom', key: 'foo', type: 'single_line_text_field', value: 'bar' },
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'SEO Title' },
      ]);
    });
  });
});
