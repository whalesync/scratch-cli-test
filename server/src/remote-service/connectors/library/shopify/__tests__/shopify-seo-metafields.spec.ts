import { extractSeoMetafields, normalizeSeoMetafields } from '../shopify-api-client';

describe('SEO metafield helpers', () => {
  describe('normalizeSeoMetafields', () => {
    it('reshapes seoTitle and seoDescription into seo object', () => {
      const node: Record<string, unknown> = {
        id: 'gid://shopify/Article/1',
        title: 'Test Article',
        seoTitle: { value: 'My SEO Title' },
        seoDescription: { value: 'My SEO Description' },
      };

      normalizeSeoMetafields(node);

      expect(node.seo).toEqual({ title: 'My SEO Title', description: 'My SEO Description' });
      expect(node.seoTitle).toBeUndefined();
      expect(node.seoDescription).toBeUndefined();
    });

    it('handles null metafield values', () => {
      const node: Record<string, unknown> = {
        id: 'gid://shopify/Page/1',
        seoTitle: null,
        seoDescription: null,
      };

      normalizeSeoMetafields(node);

      expect(node.seo).toBeNull();
      expect(node.seoTitle).toBeUndefined();
      expect(node.seoDescription).toBeUndefined();
    });

    it('handles missing metafield aliases', () => {
      const node: Record<string, unknown> = {
        id: 'gid://shopify/Blog/1',
      };

      normalizeSeoMetafields(node);

      expect(node.seo).toBeNull();
      expect(node.seoTitle).toBeUndefined();
      expect(node.seoDescription).toBeUndefined();
    });

    it('handles partial metafields — only title present', () => {
      const node: Record<string, unknown> = {
        id: 'gid://shopify/Page/2',
        seoTitle: { value: 'Page Title' },
        seoDescription: null,
      };

      normalizeSeoMetafields(node);

      expect(node.seo).toEqual({ title: 'Page Title', description: null });
    });

    it('handles partial metafields — only description present', () => {
      const node: Record<string, unknown> = {
        id: 'gid://shopify/Page/3',
        seoTitle: null,
        seoDescription: { value: 'Page Description' },
      };

      normalizeSeoMetafields(node);

      expect(node.seo).toEqual({ title: null, description: 'Page Description' });
    });
  });

  describe('extractSeoMetafields', () => {
    it('converts seo to metafields array', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seo: { title: 'SEO Title', description: 'SEO Desc' },
      };

      extractSeoMetafields(input);

      expect(input.seo).toBeUndefined();
      expect(input.metafields).toEqual([
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'SEO Title' },
        { namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: 'SEO Desc' },
      ]);
    });

    it('handles partial seo — only title', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seo: { title: 'SEO Title' },
      };

      extractSeoMetafields(input);

      expect(input.seo).toBeUndefined();
      expect(input.metafields).toEqual([
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'SEO Title' },
      ]);
    });

    it('handles partial seo — only description', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seo: { description: 'SEO Desc' },
      };

      extractSeoMetafields(input);

      expect(input.seo).toBeUndefined();
      expect(input.metafields).toEqual([
        { namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: 'SEO Desc' },
      ]);
    });

    it('is a no-op when seo is absent', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        body: 'content',
      };

      extractSeoMetafields(input);

      expect(input.seo).toBeUndefined();
      expect(input.metafields).toBeUndefined();
      expect(input.title).toBe('My Page');
      expect(input.body).toBe('content');
    });

    it('is a no-op when seo is null', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seo: null,
      };

      extractSeoMetafields(input);

      expect(input.seo).toBeUndefined();
      expect(input.metafields).toBeUndefined();
    });

    it('merges with existing metafields', () => {
      const input: Record<string, unknown> = {
        title: 'My Page',
        seo: { title: 'SEO Title' },
        metafields: [{ namespace: 'custom', key: 'foo', type: 'single_line_text_field', value: 'bar' }],
      };

      extractSeoMetafields(input);

      expect(input.seo).toBeUndefined();
      expect(input.metafields).toEqual([
        { namespace: 'custom', key: 'foo', type: 'single_line_text_field', value: 'bar' },
        { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'SEO Title' },
      ]);
    });
  });
});
