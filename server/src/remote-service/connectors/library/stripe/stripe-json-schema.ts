import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { StripeEntityType } from './stripe-types';

/**
 * Display names for Stripe entity types
 */
const ENTITY_DISPLAY_NAMES: Record<StripeEntityType, string> = {
  customers: 'Customers',
  products: 'Products',
  prices: 'Prices',
  subscriptions: 'Subscriptions',
  invoices: 'Invoices',
  payment_intents: 'Payment Intents',
  charges: 'Charges',
};

/**
 * Path under the Stripe dashboard for each entity type's list view. Most match
 * the entity name, but payment intents and charges both live under /payments.
 */
const STRIPE_DASHBOARD_PATHS: Record<StripeEntityType, string> = {
  customers: 'customers',
  products: 'products',
  prices: 'prices',
  subscriptions: 'subscriptions',
  invoices: 'invoices',
  payment_intents: 'payments',
  charges: 'payments',
};

/**
 * Get the title column remote ID for an entity type.
 */
function getTitleColumnRemoteId(entityType: StripeEntityType): string[] {
  switch (entityType) {
    case 'customers':
      return ['name'];
    case 'products':
      return ['name'];
    case 'prices':
      return ['nickname'];
    case 'subscriptions':
      return ['id'];
    case 'invoices':
      return ['number'];
    case 'payment_intents':
      return ['id'];
    case 'charges':
      return ['id'];
  }
}

/**
 * Get the slug field path for auto-generated filenames.
 * Falls back to 'id' for entity types without a good human-readable field.
 */
function getSlugFieldPath(entityType: StripeEntityType): string {
  switch (entityType) {
    case 'customers':
      return 'name';
    case 'products':
      return 'name';
    case 'prices':
      return 'nickname';
    case 'invoices':
      return 'number';
    case 'subscriptions':
    case 'payment_intents':
    case 'charges':
      return 'id';
  }
}

// ============= Shared sub-schemas =============

function addressSchema(description: string): TSchema {
  return Type.Optional(
    Type.Union(
      [
        Type.Object({
          city: Type.Union([Type.String(), Type.Null()]),
          country: Type.Union([Type.String(), Type.Null()]),
          line1: Type.Union([Type.String(), Type.Null()]),
          line2: Type.Union([Type.String(), Type.Null()]),
          postal_code: Type.Union([Type.String(), Type.Null()]),
          state: Type.Union([Type.String(), Type.Null()]),
        }),
        Type.Null(),
      ],
      { description, [X_SCRATCH_READONLY]: true },
    ),
  );
}

function metadataSchema(): TSchema {
  return Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Key-value metadata',
      [X_SCRATCH_READONLY]: true,
    }),
  );
}

// ============= Entity schemas =============

function buildCustomerSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [X_SCRATCH_READONLY]: true }),
      object: Type.String({ description: 'Object type', [X_SCRATCH_READONLY]: true }),
      name: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Customer name' })),
      email: Type.Optional(
        Type.Union([Type.String({ format: 'email' }), Type.Null()], { description: 'Email address' }),
      ),
      phone: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Phone number' })),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Description' })),
      address: addressSchema('Customer address'),
      shipping: Type.Optional(
        Type.Union(
          [
            Type.Object({
              name: Type.Union([Type.String(), Type.Null()]),
              phone: Type.Union([Type.String(), Type.Null()]),
              address: Type.Optional(
                Type.Union([
                  Type.Object({
                    city: Type.Union([Type.String(), Type.Null()]),
                    country: Type.Union([Type.String(), Type.Null()]),
                    line1: Type.Union([Type.String(), Type.Null()]),
                    line2: Type.Union([Type.String(), Type.Null()]),
                    postal_code: Type.Union([Type.String(), Type.Null()]),
                    state: Type.Union([Type.String(), Type.Null()]),
                  }),
                  Type.Null(),
                ]),
              ),
            }),
            Type.Null(),
          ],
          { description: 'Shipping information', [X_SCRATCH_READONLY]: true },
        ),
      ),
      metadata: metadataSchema(),
      currency: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Default currency', [X_SCRATCH_READONLY]: true }),
      ),
      balance: Type.Optional(Type.Number({ description: 'Account balance in cents', [X_SCRATCH_READONLY]: true })),
      delinquent: Type.Optional(Type.Boolean({ description: 'Has unpaid invoices', [X_SCRATCH_READONLY]: true })),
      default_source: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Default payment source ID',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      invoice_prefix: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Invoice prefix', [X_SCRATCH_READONLY]: true }),
      ),
      invoice_settings: Type.Optional(
        Type.Union(
          [
            Type.Object({
              default_payment_method: Type.Union([Type.String(), Type.Null()]),
              footer: Type.Union([Type.String(), Type.Null()]),
            }),
            Type.Null(),
          ],
          { description: 'Invoice settings', [X_SCRATCH_READONLY]: true },
        ),
      ),
      tax_exempt: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Tax exemption status', [X_SCRATCH_READONLY]: true }),
      ),
      created: Type.Number({ description: 'Created timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'stripe/customers', title: 'Customers' },
  );
}

// FIXTURE NOTE: edits here change the generated schema.json checked in under
// `__fixtures__/view-codec/stripe-products` — see `buildStripeJsonTableSpec` for how to refresh it.
function buildProductSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [X_SCRATCH_READONLY]: true }),
      object: Type.String({ description: 'Object type', [X_SCRATCH_READONLY]: true }),
      name: Type.String({ description: 'Product name' }),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Product description' })),
      active: Type.Boolean({ description: 'Whether the product is available for purchase' }),
      default_price: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Default price ID',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'prices', linkedTableRemoteId: ['prices'] },
        }),
      ),
      images: Type.Optional(
        Type.Array(Type.String(), { description: 'Product image URLs', [X_SCRATCH_READONLY]: true }),
      ),
      metadata: metadataSchema(),
      url: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Product URL' })),
      type: Type.Optional(Type.String({ description: 'Product type', [X_SCRATCH_READONLY]: true })),
      created: Type.Number({ description: 'Created timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
      updated: Type.Number({ description: 'Updated timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'stripe/products', title: 'Products' },
  );
}

function buildPriceSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [X_SCRATCH_READONLY]: true }),
      object: Type.String({ description: 'Object type', [X_SCRATCH_READONLY]: true }),
      product: Type.String({
        description: 'Product ID',
        [X_SCRATCH_READONLY]: true,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'products', linkedTableRemoteId: ['products'] },
      }),
      active: Type.Boolean({ description: 'Whether the price is active' }),
      currency: Type.String({ description: 'Three-letter ISO currency code' }),
      unit_amount: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Price in cents', [X_SCRATCH_READONLY]: true }),
      ),
      unit_amount_decimal: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Price in cents as decimal string',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      type: Type.String({ description: 'Price type (one_time or recurring)', [X_SCRATCH_READONLY]: true }),
      recurring: Type.Optional(
        Type.Union(
          [
            Type.Object({
              interval: Type.String({ description: 'Billing interval (day, week, month, year)' }),
              interval_count: Type.Number({ description: 'Number of intervals between billings' }),
              usage_type: Type.String({ description: 'Usage type (metered or licensed)' }),
            }),
            Type.Null(),
          ],
          { description: 'Recurring pricing details', [X_SCRATCH_READONLY]: true },
        ),
      ),
      billing_scheme: Type.Optional(Type.String({ description: 'Billing scheme', [X_SCRATCH_READONLY]: true })),
      nickname: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Price nickname' })),
      metadata: metadataSchema(),
      lookup_key: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Lookup key', [X_SCRATCH_READONLY]: true }),
      ),
      created: Type.Number({ description: 'Created timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'stripe/prices', title: 'Prices' },
  );
}

function buildSubscriptionSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [X_SCRATCH_READONLY]: true }),
      object: Type.String({ description: 'Object type', [X_SCRATCH_READONLY]: true }),
      customer: Type.String({
        description: 'Customer ID',
        [X_SCRATCH_READONLY]: true,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customers', linkedTableRemoteId: ['customers'] },
      }),
      status: Type.String({
        description:
          'Subscription status (active, past_due, unpaid, canceled, incomplete, incomplete_expired, trialing, paused)',
        [X_SCRATCH_READONLY]: true,
      }),
      cancel_at_period_end: Type.Boolean({
        description: 'Will cancel at end of period',
        [X_SCRATCH_READONLY]: true,
      }),
      canceled_at: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], {
          description: 'Cancellation timestamp (Unix)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      ended_at: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], {
          description: 'End timestamp (Unix)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      start_date: Type.Number({ description: 'Start date (Unix)', [X_SCRATCH_READONLY]: true }),
      trial_start: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Trial start (Unix)', [X_SCRATCH_READONLY]: true }),
      ),
      trial_end: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Trial end (Unix)', [X_SCRATCH_READONLY]: true }),
      ),
      default_payment_method: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Default payment method ID',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      latest_invoice: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Latest invoice ID',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'invoices', linkedTableRemoteId: ['invoices'] },
        }),
      ),
      collection_method: Type.Optional(Type.String({ description: 'Collection method', [X_SCRATCH_READONLY]: true })),
      currency: Type.String({ description: 'Currency code', [X_SCRATCH_READONLY]: true }),
      metadata: metadataSchema(),
      items: Type.Optional(
        Type.Object(
          {
            object: Type.Optional(Type.String()),
            data: Type.Array(
              Type.Object({
                id: Type.String(),
                object: Type.Optional(Type.String()),
                price: Type.Object({
                  id: Type.String(),
                  product: Type.String(),
                  currency: Type.String(),
                  unit_amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                  type: Type.String(),
                  recurring: Type.Optional(
                    Type.Union([
                      Type.Object({
                        interval: Type.String(),
                        interval_count: Type.Number(),
                        usage_type: Type.String(),
                      }),
                      Type.Null(),
                    ]),
                  ),
                }),
                quantity: Type.Optional(Type.Number()),
                metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
                created: Type.Optional(Type.Number()),
                // The billing period lives on the line item, not the subscription: an item's period
                // is what Stripe removed from the subscription top level. Declared optional because
                // items spliced in by `hydrateTruncatedSubscriptionItems` come from a different
                // endpoint, so we never assume the field is there.
                current_period_start: Type.Optional(
                  Type.Number({ description: "Start of this item's current billing period (Unix)" }),
                ),
                current_period_end: Type.Optional(
                  Type.Number({ description: "End of this item's current billing period (Unix)" }),
                ),
              }),
            ),
            has_more: Type.Optional(Type.Boolean()),
            url: Type.Optional(Type.String()),
          },
          { description: 'Subscription line items', [X_SCRATCH_READONLY]: true },
        ),
      ),
      created: Type.Number({ description: 'Created timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'stripe/subscriptions', title: 'Subscriptions' },
  );
}

/**
 * Invoices no longer carry a `charge` or `payment_intent` link, and the reverse links (`charge.invoice`,
 * `payment_intent.invoice`) were removed with them — an invoice can now be settled by several partial
 * payments, so the relation moved to the invoice's `payments` list. That list is `expand`-only and its
 * links sit inside an array (`payments.data[].payment.payment_intent`), which the foreign-key extractor
 * does not walk, so it is deliberately not modelled here. Invoice ↔ payment relations are therefore
 * unavailable until both the expand and array-nested foreign keys are supported (DEV-11144).
 */
function buildInvoiceSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [X_SCRATCH_READONLY]: true }),
      object: Type.String({ description: 'Object type', [X_SCRATCH_READONLY]: true }),
      customer: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Customer ID',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customers', linkedTableRemoteId: ['customers'] },
        }),
      ),
      // Replaces the removed top-level `subscription`: Stripe now reports what generated an invoice
      // through `parent`, whose shape is selected by `parent.type`. The link to the subscription is
      // annotated where it actually lives rather than hoisted back to the top level.
      parent: Type.Optional(
        Type.Union(
          [
            Type.Object({
              type: Type.String({
                description: 'Which detail hash is populated (subscription_details, quote_details)',
              }),
              subscription_details: Type.Optional(
                Type.Union([
                  Type.Object({
                    subscription: Type.Optional(
                      Type.Union([Type.String(), Type.Null()], {
                        description: 'Subscription ID',
                        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                          linkedTableId: 'subscriptions',
                          linkedTableRemoteId: ['subscriptions'],
                        },
                      }),
                    ),
                    subscription_proration_date: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                    metadata: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              quote_details: Type.Optional(
                Type.Union([Type.Object({ quote: Type.Optional(Type.String()) }), Type.Null()]),
              ),
            }),
            Type.Null(),
          ],
          { description: 'What generated this invoice (subscription or quote)', [X_SCRATCH_READONLY]: true },
        ),
      ),
      status: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Invoice status (draft, open, paid, uncollectible, void)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      currency: Type.String({ description: 'Currency code', [X_SCRATCH_READONLY]: true }),
      amount_due: Type.Number({ description: 'Amount due in cents', [X_SCRATCH_READONLY]: true }),
      amount_paid: Type.Number({ description: 'Amount paid in cents', [X_SCRATCH_READONLY]: true }),
      amount_remaining: Type.Number({ description: 'Amount remaining in cents', [X_SCRATCH_READONLY]: true }),
      subtotal: Type.Number({ description: 'Subtotal in cents', [X_SCRATCH_READONLY]: true }),
      total: Type.Number({ description: 'Total in cents', [X_SCRATCH_READONLY]: true }),
      // Replaces the removed top-level `tax`, which Stripe unified into per-tax-object aggregates.
      total_taxes: Type.Optional(
        Type.Union(
          [
            Type.Array(
              Type.Object({
                amount: Type.Number(),
                tax_behavior: Type.Optional(Type.String()),
                taxability_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                taxable_amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                type: Type.Optional(Type.String()),
                tax_rate_details: Type.Optional(
                  Type.Union([Type.Object({ tax_rate: Type.Optional(Type.String()) }), Type.Null()]),
                ),
              }),
            ),
            Type.Null(),
          ],
          { description: 'Aggregate tax amounts across all line items', [X_SCRATCH_READONLY]: true },
        ),
      ),
      number: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Invoice number', [X_SCRATCH_READONLY]: true }),
      ),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Invoice description' })),
      due_date: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Due date (Unix)', [X_SCRATCH_READONLY]: true }),
      ),
      // Replaces the removed top-level `paid` — whether an invoice is paid is now read from `status`,
      // and when it was paid from `status_transitions.paid_at`.
      status_transitions: Type.Optional(
        Type.Union(
          [
            Type.Object({
              finalized_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              marked_uncollectible_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              paid_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              voided_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
            }),
            Type.Null(),
          ],
          { description: 'Timestamps for each status the invoice has moved through', [X_SCRATCH_READONLY]: true },
        ),
      ),
      period_start: Type.Number({ description: 'Period start (Unix)', [X_SCRATCH_READONLY]: true }),
      period_end: Type.Number({ description: 'Period end (Unix)', [X_SCRATCH_READONLY]: true }),
      hosted_invoice_url: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Hosted invoice page URL',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      invoice_pdf: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Invoice PDF URL', [X_SCRATCH_READONLY]: true }),
      ),
      collection_method: Type.Optional(Type.String({ description: 'Collection method', [X_SCRATCH_READONLY]: true })),
      metadata: metadataSchema(),
      created: Type.Number({ description: 'Created timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'stripe/invoices', title: 'Invoices' },
  );
}

function buildPaymentIntentSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [X_SCRATCH_READONLY]: true }),
      object: Type.String({ description: 'Object type', [X_SCRATCH_READONLY]: true }),
      customer: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Customer ID',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customers', linkedTableRemoteId: ['customers'] },
        }),
      ),
      amount: Type.Number({ description: 'Amount in cents', [X_SCRATCH_READONLY]: true }),
      amount_received: Type.Number({ description: 'Amount received in cents', [X_SCRATCH_READONLY]: true }),
      currency: Type.String({ description: 'Currency code', [X_SCRATCH_READONLY]: true }),
      status: Type.String({
        description: 'Payment intent status',
        [X_SCRATCH_READONLY]: true,
      }),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Description' })),
      payment_method: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Payment method ID',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      capture_method: Type.Optional(Type.String({ description: 'Capture method', [X_SCRATCH_READONLY]: true })),
      confirmation_method: Type.Optional(
        Type.String({ description: 'Confirmation method', [X_SCRATCH_READONLY]: true }),
      ),
      metadata: metadataSchema(),
      latest_charge: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Latest charge ID',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'charges', linkedTableRemoteId: ['charges'] },
        }),
      ),
      created: Type.Number({ description: 'Created timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'stripe/payment_intents', title: 'Payment Intents' },
  );
}

function buildChargeSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [X_SCRATCH_READONLY]: true }),
      object: Type.String({ description: 'Object type', [X_SCRATCH_READONLY]: true }),
      customer: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Customer ID',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customers', linkedTableRemoteId: ['customers'] },
        }),
      ),
      amount: Type.Number({ description: 'Amount in cents', [X_SCRATCH_READONLY]: true }),
      amount_captured: Type.Number({ description: 'Amount captured in cents', [X_SCRATCH_READONLY]: true }),
      amount_refunded: Type.Number({ description: 'Amount refunded in cents', [X_SCRATCH_READONLY]: true }),
      currency: Type.String({ description: 'Currency code', [X_SCRATCH_READONLY]: true }),
      status: Type.String({ description: 'Charge status (succeeded, pending, failed)', [X_SCRATCH_READONLY]: true }),
      paid: Type.Boolean({ description: 'Whether the charge was paid', [X_SCRATCH_READONLY]: true }),
      captured: Type.Boolean({ description: 'Whether the charge was captured', [X_SCRATCH_READONLY]: true }),
      refunded: Type.Boolean({ description: 'Whether the charge was refunded', [X_SCRATCH_READONLY]: true }),
      disputed: Type.Boolean({ description: 'Whether the charge is disputed', [X_SCRATCH_READONLY]: true }),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Charge description' })),
      payment_intent: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Payment intent ID',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
            linkedTableId: 'payment_intents',
            linkedTableRemoteId: ['payment_intents'],
          },
        }),
      ),
      payment_method: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Payment method ID',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      receipt_email: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Receipt email', [X_SCRATCH_READONLY]: true }),
      ),
      receipt_url: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Receipt URL', [X_SCRATCH_READONLY]: true }),
      ),
      failure_code: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Failure code', [X_SCRATCH_READONLY]: true }),
      ),
      failure_message: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Failure message', [X_SCRATCH_READONLY]: true }),
      ),
      billing_details: Type.Optional(
        Type.Union(
          [
            Type.Object({
              name: Type.Union([Type.String(), Type.Null()]),
              email: Type.Union([Type.String(), Type.Null()]),
              phone: Type.Union([Type.String(), Type.Null()]),
              address: Type.Optional(
                Type.Union([
                  Type.Object({
                    city: Type.Union([Type.String(), Type.Null()]),
                    country: Type.Union([Type.String(), Type.Null()]),
                    line1: Type.Union([Type.String(), Type.Null()]),
                    line2: Type.Union([Type.String(), Type.Null()]),
                    postal_code: Type.Union([Type.String(), Type.Null()]),
                    state: Type.Union([Type.String(), Type.Null()]),
                  }),
                  Type.Null(),
                ]),
              ),
            }),
            Type.Null(),
          ],
          { description: 'Billing details', [X_SCRATCH_READONLY]: true },
        ),
      ),
      metadata: metadataSchema(),
      created: Type.Number({ description: 'Created timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'stripe/charges', title: 'Charges' },
  );
}

/**
 * Build the TypeBox schema for a Stripe entity type.
 */
function buildSchema(entityType: StripeEntityType): TSchema {
  switch (entityType) {
    case 'customers':
      return buildCustomerSchema();
    case 'products':
      return buildProductSchema();
    case 'prices':
      return buildPriceSchema();
    case 'subscriptions':
      return buildSubscriptionSchema();
    case 'invoices':
      return buildInvoiceSchema();
    case 'payment_intents':
      return buildPaymentIntentSchema();
    case 'charges':
      return buildChargeSchema();
  }
}

/**
 * Build the JSON Table Spec for a Stripe entity type.
 *
 * FIXTURE NOTE: real `schema.json` output of this generator is checked in as a codec-test input
 * under `server/src/sync/__fixtures__/view-codec/stripe-*`. Those fixtures are captured inputs,
 * NOT snapshots — there is no automated regeneration. Stripe schemas are hand-maintained here
 * (see the per-entity `build*Schema` helpers), so if you change one, update the matching fixture
 * `schema.json` to match and re-run `jest -u server/src/sync/view-codec-snapshots.spec.ts`, or the
 * view-codec guardrail keeps exercising the old shape.
 */
export function buildStripeJsonTableSpec(id: EntityId, entityType: StripeEntityType): BaseJsonTableSpec {
  const schema = buildSchema(entityType);

  return {
    id,
    slug: id.wsId,
    name: ENTITY_DISPLAY_NAMES[entityType],
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath(getTitleColumnRemoteId(entityType).join('.')),
    slugPath: dotPath(getSlugFieldPath(entityType)),
    basePath: [],
    // Deep link to this entity's list view in the Stripe dashboard, e.g.
    // https://dashboard.stripe.com/customers (live mode).
    remoteWebUrl: `https://dashboard.stripe.com/${STRIPE_DASHBOARD_PATHS[entityType]}`,
    generatedAt: new Date().toISOString(),
  };
}
