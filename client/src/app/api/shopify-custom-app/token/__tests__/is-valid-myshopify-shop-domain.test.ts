import { isValidMyshopifyShopDomain } from '../is-valid-myshopify-shop-domain';

describe('isValidMyshopifyShopDomain', () => {
  it.each(['rha8jq-r1.myshopify.com', 'Whalesync.myshopify.com'])('accepts %s', (shopDomainCandidate) => {
    expect(isValidMyshopifyShopDomain(shopDomainCandidate)).toBe(true);
  });

  it.each([
    'evil.com',
    'evil.com/x?',
    'evil.com/x?.myshopify.com',
    'x.myshopify.com.evil.com',
    'x.myshopify.com/admin',
    'user@x.myshopify.com',
    'x.myshopify.com:443',
    'sub.x.myshopify.com',
    '-x.myshopify.com',
    'x.myshopify.com\n',
    '',
  ])('rejects %j', (shopDomainCandidate) => {
    expect(isValidMyshopifyShopDomain(shopDomainCandidate)).toBe(false);
  });
});
