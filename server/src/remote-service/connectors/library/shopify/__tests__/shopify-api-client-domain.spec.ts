import { ConnectorAuthError } from '../../../error';
import { SHOPIFY_SHOP_DOMAIN_NOT_A_MYSHOPIFY_DOMAIN_MESSAGE, ShopifyApiClient } from '../shopify-api-client';

describe('ShopifyApiClient shop domain (DEV-12723)', () => {
  it.each(['acme', 'acme.myshopify.com', 'https://Acme.myshopify.com/', 'my-store-2.myshopify.com'])(
    'accepts %p',
    (shopDomain) => {
      expect(() => new ShopifyApiClient({ shopDomain, accessToken: 'access-token' })).not.toThrow();
    },
  );

  // Each of these passes the old `.includes('.myshopify.com')` normalization but would send the token elsewhere.
  it.each([
    'evil.example/.myshopify.com',
    'acme.myshopify.com.evil.example',
    'acme.myshopify.com@evil.example',
    'evil.example#',
    'evil.example?.myshopify.com',
    'shop.example.com',
  ])('refuses %p before building the client', (shopDomain) => {
    expect(() => new ShopifyApiClient({ shopDomain, accessToken: 'access-token' })).toThrow(ConnectorAuthError);
  });

  it('explains what to enter', () => {
    expect(() => new ShopifyApiClient({ shopDomain: 'evil.example/.myshopify.com', accessToken: 'token' })).toThrow(
      SHOPIFY_SHOP_DOMAIN_NOT_A_MYSHOPIFY_DOMAIN_MESSAGE,
    );
  });
});
