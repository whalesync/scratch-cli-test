import * as generatedShopifyMutations from '../graphql/mutations';
import {
  COLLECTIONS_DELETE_MUTATION,
  COLLECTIONS_UPDATE_MUTATION,
  PRODUCTS_CREATE_MUTATION,
  PRODUCTS_DELETE_MUTATION,
} from '../graphql/mutations';

/**
 * Every generated mutation string, keyed by its export name, so a new mutation added by a future
 * `yarn codegen:shopify` run is covered by the sweeps below without touching this file.
 */
const generated_mutation_strings_by_export_name: [string, string][] = Object.entries(
  generatedShopifyMutations as Record<string, unknown>,
).filter((entry): entry is [string, string] => entry[0].endsWith('_MUTATION') && typeof entry[1] === 'string');

describe('generated Shopify mutations', () => {
  it('exports every entity mutation the sweeps below rely on', () => {
    // Guards against the sweeps silently passing over an empty set if the generated index moves.
    expect(generated_mutation_strings_by_export_name.length).toBeGreaterThanOrEqual(15);
  });

  // DEV-10683: the mutation payloads carry a `shop: Shop!` field nothing in the client reads.
  // Selecting it pulls in `Shop.analyticsToken`, which needs an API scope many store tokens lack;
  // Shopify then answers with a field-level access-denied error *alongside* a payload whose
  // product was really created, and `executeQuery` discards the whole response — so a successful
  // create is reported as a failure and the new product is orphaned in the store.
  describe('do not select the unused, scope-gated shop payload field', () => {
    it.each(generated_mutation_strings_by_export_name)('%s selects no analyticsToken', (_name, mutation) => {
      expect(mutation).not.toMatch(/analyticsToken/);
    });

    it.each(generated_mutation_strings_by_export_name)('%s selects no shop payload block', (_name, mutation) => {
      expect(mutation).not.toMatch(/\bshop\s*\{/);
    });
  });

  describe('still select the payload fields the API client reads', () => {
    it('PRODUCTS_CREATE_MUTATION returns the created product and its userErrors', () => {
      expect(PRODUCTS_CREATE_MUTATION).toContain('productCreate(product: $product) {');
      expect(PRODUCTS_CREATE_MUTATION).toContain('product {');
      expect(PRODUCTS_CREATE_MUTATION).toContain('userErrors {');
    });

    it('PRODUCTS_DELETE_MUTATION keeps deletedProductId and userErrors', () => {
      expect(PRODUCTS_DELETE_MUTATION).toContain('deletedProductId');
      expect(PRODUCTS_DELETE_MUTATION).toContain('userErrors {');
    });

    it('COLLECTIONS_DELETE_MUTATION keeps deletedCollectionId and userErrors', () => {
      expect(COLLECTIONS_DELETE_MUTATION).toContain('deletedCollectionId');
      expect(COLLECTIONS_DELETE_MUTATION).toContain('userErrors {');
    });

    it('COLLECTIONS_UPDATE_MUTATION is untouched by the shop-field skip', () => {
      // Not a payload the skip is configured for — proves the filter is scoped, not blanket.
      expect(COLLECTIONS_UPDATE_MUTATION).toContain('collection {');
      expect(COLLECTIONS_UPDATE_MUTATION).toContain('job {');
    });
  });

  it('every mutation is balanced GraphQL after the shop block was dropped', () => {
    for (const [exportName, mutation] of generated_mutation_strings_by_export_name) {
      const open_brace_count = (mutation.match(/\{/g) ?? []).length;
      const close_brace_count = (mutation.match(/\}/g) ?? []).length;
      expect([exportName, open_brace_count]).toEqual([exportName, close_brace_count]);
    }
  });
});
