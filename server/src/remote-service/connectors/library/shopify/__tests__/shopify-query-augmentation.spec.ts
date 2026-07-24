import { COLLECTIONS_QUERY_FIELDS } from '../graphql/schemas/collections.schema';
import { PRODUCTS_QUERY_FIELDS } from '../graphql/schemas/products.schema';
import { augmentNestedSelection, getQueryFieldsForEntity } from '../shopify-api-client';

describe('Shopify query-field augmentation (DEV-11019 / DEV-11020)', () => {
  describe('augmentNestedSelection', () => {
    it('rewrites the matched nested selection in place', () => {
      const result = augmentNestedSelection('a { x } b { y }', 'a { x }', 'a { x z }');
      expect(result).toBe('a { x z } b { y }');
    });

    it('throws loudly when the generated selection is absent (codegen drift guard)', () => {
      expect(() => augmentNestedSelection('a { x }', 'ruleSet { appliedDisjunctively }', 'whatever')).toThrow(
        /Shopify query augmentation failed/,
      );
    });
  });

  describe('collections: smart-collection rules (DEV-11019)', () => {
    it('the generated query still only requests appliedDisjunctively (augmentation precondition)', () => {
      expect(COLLECTIONS_QUERY_FIELDS).toContain('ruleSet { appliedDisjunctively }');
      expect(COLLECTIONS_QUERY_FIELDS).not.toContain('rules { column relation condition }');
    });

    it('the effective collections query pulls the rules array', () => {
      const query = getQueryFieldsForEntity('collections');
      expect(query).toContain('ruleSet { appliedDisjunctively rules { column relation condition } }');
    });
  });

  describe('products: featuredImage url/altText (DEV-11020)', () => {
    it('the generated query still requests featuredImage as a bare reference (augmentation precondition)', () => {
      expect(PRODUCTS_QUERY_FIELDS).toContain('featuredImage { id }');
    });

    it('the effective products query pulls featuredImage url and altText', () => {
      const query = getQueryFieldsForEntity('products');
      expect(query).toContain('featuredImage { id altText url }');
    });
  });
});
