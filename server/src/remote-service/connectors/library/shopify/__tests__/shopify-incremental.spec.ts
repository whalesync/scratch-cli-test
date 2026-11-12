import { IncrementalPullSupport } from '@spinner/shared-types';
import {
  buildShopifyUpdatedAtSearchQuery,
  findMissingShopifyAccessScopesForEntity,
  SHOPIFY_INCREMENTAL_CLOCK_SKEW_MS,
  shopifyEntityRequiresAccessScopeCheck,
  shopifyIncrementalPullSupport,
} from '../shopify-incremental';

describe('shopifyIncrementalPullSupport', () => {
  it.each(['customers', 'orders', 'order_line_items', 'order_shipping_lines'])('supports %s', (entityType) => {
    expect(shopifyIncrementalPullSupport(entityType)).toBe(IncrementalPullSupport.SUPPORTED);
  });

  it.each(['products', 'product_variants', 'product_media', 'collections', 'pages', 'blogs', 'articles', 'files'])(
    'full-pulls %s',
    (entityType) => {
      expect(shopifyIncrementalPullSupport(entityType)).toBe(IncrementalPullSupport.NOT_SUPPORTED);
    },
  );
});

describe('buildShopifyUpdatedAtSearchQuery', () => {
  it('builds an inclusive updated_at filter from the watermark less the clock-skew overlap', () => {
    expect(SHOPIFY_INCREMENTAL_CLOCK_SKEW_MS).toBe(5 * 60_000);
    expect(buildShopifyUpdatedAtSearchQuery(new Date('2026-11-12T10:00:00.000Z'))).toBe(
      "updated_at:>='2026-11-12T09:55:00.000Z'",
    );
  });
});

describe('findMissingShopifyAccessScopesForEntity', () => {
  const everyScopeTheSetupGuideGrants = new Set(['read_customers', 'read_orders', 'read_all_orders', 'read_products']);

  it('finds nothing missing for a token from the current setup guide', () => {
    for (const entityType of ['customers', 'orders', 'order_line_items', 'order_shipping_lines'] as const) {
      expect(findMissingShopifyAccessScopesForEntity(entityType, everyScopeTheSetupGuideGrants)).toEqual([]);
    }
  });

  it('names every scope the Orders table needs that the token lacks', () => {
    const missing = findMissingShopifyAccessScopesForEntity('orders', new Set(['read_orders', 'read_products']));
    expect(missing.map(({ scope }) => scope)).toEqual(['read_all_orders', 'read_customers']);
  });

  it('needs read_orders for Customers, whose lastOrder is an Order', () => {
    const missing = findMissingShopifyAccessScopesForEntity('customers', new Set(['read_customers']));
    expect(missing.map(({ scope }) => scope)).toEqual(['read_orders']);
  });

  it("doesn't need read_customers for order child tables, which list their orders by id only", () => {
    const missing = findMissingShopifyAccessScopesForEntity(
      'order_line_items',
      new Set(['read_orders', 'read_all_orders']),
    );
    expect(missing).toEqual([]);
  });

  it('counts a write scope as its read scope', () => {
    const missing = findMissingShopifyAccessScopesForEntity(
      'orders',
      new Set(['write_orders', 'write_customers', 'read_all_orders']),
    );
    expect(missing).toEqual([]);
  });

  it('only checks scopes for Customers and the order tables', () => {
    expect(shopifyEntityRequiresAccessScopeCheck('customers')).toBe(true);
    expect(shopifyEntityRequiresAccessScopeCheck('order_shipping_lines')).toBe(true);
    expect(shopifyEntityRequiresAccessScopeCheck('products')).toBe(false);
    expect(findMissingShopifyAccessScopesForEntity('products', new Set())).toEqual([]);
  });
});
