/**
 * Helpers for Shopify incremental pulls, and the access scopes each table needs.
 *
 * Shopify's modified-since mechanism is the `updated_at` term of a connection's search `query`
 * argument (`orders(query: "updated_at:>='2026-11-12T00:00:00.000Z'", sortKey: UPDATED_AT)`).
 * Customers and Orders support it, and so do the order child tables (line items, shipping lines),
 * because any change to a line item or shipping line updates its order's `updatedAt`. The other
 * tables always full-pull.
 */

import { IncrementalPullSupport } from '@spinner/shared-types';
import { EntityType } from './graphql';

/**
 * The tables that pull incrementally. The order child tables are pulled through their parent
 * orders, so their `updated_at` filter goes on the orders query.
 */
const SHOPIFY_INCREMENTAL_PULL_ENTITY_TYPES: ReadonlySet<string> = new Set<EntityType>([
  'customers',
  'orders',
  'order_line_items',
  'order_shipping_lines',
]);

/**
 * Overlap subtracted from the watermark before it becomes the `updated_at:>=` filter. `updatedAt` is
 * stamped by Shopify while the watermark comes from our clock, and Shopify's search index can lag
 * behind a write by a few seconds, so a record changed right before the previous pull started could
 * otherwise be missed. Re-pulling five minutes of changes is cheap; pull commits are idempotent.
 */
export const SHOPIFY_INCREMENTAL_CLOCK_SKEW_MS = 5 * 60_000;

/** Whether a Shopify table can pull only what changed since the last pull. */
export function shopifyIncrementalPullSupport(entityType: string): IncrementalPullSupport {
  return SHOPIFY_INCREMENTAL_PULL_ENTITY_TYPES.has(entityType)
    ? IncrementalPullSupport.SUPPORTED
    : IncrementalPullSupport.NOT_SUPPORTED;
}

/**
 * The Shopify search query that selects records updated since `since`, less the clock-skew overlap.
 * `>=` is inclusive, so a record updated exactly at the boundary is pulled again rather than missed.
 */
export function buildShopifyUpdatedAtSearchQuery(since: Date): string {
  const sinceWithClockSkewOverlap = new Date(since.getTime() - SHOPIFY_INCREMENTAL_CLOCK_SKEW_MS);
  return `updated_at:>='${sinceWithClockSkewOverlap.toISOString()}'`;
}

const READ_ORDERS_SCOPE = { scope: 'read_orders', reason: 'to read orders' };
const READ_ALL_ORDERS_SCOPE = { scope: 'read_all_orders', reason: 'to read orders older than 60 days' };
const READ_CUSTOMERS_SCOPE = { scope: 'read_customers', reason: 'to read customers' };
const READ_LOCATIONS_SCOPE = { scope: 'read_locations', reason: "to read each order's store location" };

/**
 * Access scopes a table's pull needs beyond what the rest of the connector uses. A token missing
 * one fails the pull up front with a message naming the scope, instead of Shopify's mid-pull
 * ACCESS_DENIED, or (for `read_all_orders`) a pull that quietly returns only the last 60 days of
 * orders. The Customers query also selects each customer's `lastOrder` (an Order, so `read_orders`),
 * and the Orders query selects each order's `customer` (so `read_customers`) and `retailLocation`
 * (a Location: every field but `id` needs `read_locations`). The order child tables list their
 * parent orders by id only, so they need neither `read_customers` nor `read_locations`.
 */
const SHOPIFY_REQUIRED_ACCESS_SCOPES_BY_ENTITY_TYPE: Partial<
  Record<EntityType, ReadonlyArray<{ scope: string; reason: string }>>
> = {
  customers: [READ_CUSTOMERS_SCOPE, READ_ORDERS_SCOPE],
  orders: [READ_ORDERS_SCOPE, READ_ALL_ORDERS_SCOPE, READ_CUSTOMERS_SCOPE, READ_LOCATIONS_SCOPE],
  order_line_items: [READ_ORDERS_SCOPE, READ_ALL_ORDERS_SCOPE],
  order_shipping_lines: [READ_ORDERS_SCOPE, READ_ALL_ORDERS_SCOPE],
};

/**
 * The scopes `entityType` needs that the token wasn't granted. A `write_<x>` grant counts as
 * `read_<x>`, since Shopify grants read access along with write access.
 */
export function findMissingShopifyAccessScopesForEntity(
  entityType: EntityType,
  grantedAccessScopeHandles: ReadonlySet<string>,
): Array<{ scope: string; reason: string }> {
  const requiredAccessScopes = SHOPIFY_REQUIRED_ACCESS_SCOPES_BY_ENTITY_TYPE[entityType] ?? [];
  return requiredAccessScopes.filter(({ scope }) => {
    if (grantedAccessScopeHandles.has(scope)) return false;
    const writeScopeThatImpliesThisReadScope = scope.startsWith('read_')
      ? `write_${scope.slice('read_'.length)}`
      : null;
    return !(writeScopeThatImpliesThisReadScope && grantedAccessScopeHandles.has(writeScopeThatImpliesThisReadScope));
  });
}

/** Whether pulling `entityType` needs a scope check before the first request. */
export function shopifyEntityRequiresAccessScopeCheck(entityType: EntityType): boolean {
  return entityType in SHOPIFY_REQUIRED_ACCESS_SCOPES_BY_ENTITY_TYPE;
}
