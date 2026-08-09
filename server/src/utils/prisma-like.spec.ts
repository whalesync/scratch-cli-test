import { escapeLikeWildcards } from './prisma-like';

describe('escapeLikeWildcards', () => {
  it('escapes underscore, percent, and backslash', () => {
    expect(escapeLikeWildcards('product_variants')).toBe('product\\_variants');
    expect(escapeLikeWildcards('a%b')).toBe('a\\%b');
    expect(escapeLikeWildcards('a\\b')).toBe('a\\\\b');
  });

  it('escapes every wildcard in a value with several', () => {
    expect(escapeLikeWildcards('a_b%c_d')).toBe('a\\_b\\%c\\_d');
  });

  it('leaves non-wildcard characters (including / space :) untouched', () => {
    expect(escapeLikeWildcards('Product Variants/gid://shopify/ProductVariant')).toBe(
      'Product Variants/gid://shopify/ProductVariant',
    );
  });

  it('returns an empty string unchanged', () => {
    expect(escapeLikeWildcards('')).toBe('');
  });
});
