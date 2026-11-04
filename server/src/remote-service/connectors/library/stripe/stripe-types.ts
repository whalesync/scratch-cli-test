/**
 * Types for the Stripe connector.
 *
 * The shape of each Stripe object is not typed here: the record schemas are generated from Stripe's
 * OpenAPI spec (`stripe-object-schemas.generated.ts`), and records are handled as the plain JSON
 * Stripe returns.
 *
 * API Documentation: https://stripe.com/docs/api
 */

import type { ConnectorAuthTokenOrProvider } from '../../connector-auth-token';

/**
 * Credentials for authenticating with the Stripe API.
 */
export interface StripeCredentials {
  /**
   * What every request sends as its Bearer token: either a pasted secret key (`sk_live_…` / `sk_test_…`), or the OAuth
   * access token of Whalesync's Stripe app installed in the account. The OAuth token comes as a provider, re-read on
   * each request, so a refresh during a long pull is picked up.
   */
  secretKeyOrOAuthAccessToken: ConnectorAuthTokenOrProvider;
}

/**
 * Entity types supported by the Stripe connector.
 */
export type StripeEntityType =
  | 'customers'
  | 'products'
  | 'prices'
  | 'subscriptions'
  | 'invoices'
  | 'payment_intents'
  | 'charges'
  | 'refunds'
  | 'disputes'
  | 'credit_notes'
  | 'coupons'
  | 'promotion_codes'
  | 'balance_transactions'
  | 'subscription_schedules'
  | 'events';

/**
 * Stripe list response envelope.
 * All Stripe list endpoints return this shape.
 */
export interface StripeListResponse<T> {
  object: 'list';
  url: string;
  has_more: boolean;
  data: T[];
}

/**
 * `x-scratch-connector-data-type` marking a field Stripe reports as a Unix-epoch timestamp in
 * SECONDS (`created`, `start_date`, `canceled_at`, `due_date`, `paid_at`, …). Stripe has no ISO
 * date type — every time it reports is a bare integer — so this is a faithful fact about the
 * field, not a display opinion, and it is the only signal that distinguishes `created` from a
 * genuine number like `balance`. The default view reads it to build a real date column backed by
 * an `epoch_to_iso` codec; without it every timestamp exports as a raw number (DEV-11145).
 */
export const STRIPE_UNIX_TIMESTAMP_DATA_TYPE = 'unix-timestamp-seconds';
