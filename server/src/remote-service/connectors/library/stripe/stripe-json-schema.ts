import { Type, type TSchema } from '@sinclair/typebox';
import { FOREIGN_KEY_OPTIONS, READONLY_FLAG } from '../../json-schema';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
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
      { description, [READONLY_FLAG]: true },
    ),
  );
}

function metadataSchema(): TSchema {
  return Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Key-value metadata',
      [READONLY_FLAG]: true,
    }),
  );
}

// ============= Entity schemas =============

function buildCustomerSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [READONLY_FLAG]: true }),
      object: Type.String({ description: 'Object type', [READONLY_FLAG]: true }),
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
          { description: 'Shipping information', [READONLY_FLAG]: true },
        ),
      ),
      metadata: metadataSchema(),
      currency: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Default currency', [READONLY_FLAG]: true }),
      ),
      balance: Type.Optional(Type.Number({ description: 'Account balance in cents', [READONLY_FLAG]: true })),
      delinquent: Type.Optional(Type.Boolean({ description: 'Has unpaid invoices', [READONLY_FLAG]: true })),
      default_source: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Default payment source ID', [READONLY_FLAG]: true }),
      ),
      invoice_prefix: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Invoice prefix', [READONLY_FLAG]: true }),
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
          { description: 'Invoice settings', [READONLY_FLAG]: true },
        ),
      ),
      tax_exempt: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Tax exemption status', [READONLY_FLAG]: true }),
      ),
      created: Type.Number({ description: 'Created timestamp (Unix)', [READONLY_FLAG]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [READONLY_FLAG]: true }),
    },
    { $id: 'stripe/customers', title: 'Customers' },
  );
}

function buildProductSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [READONLY_FLAG]: true }),
      object: Type.String({ description: 'Object type', [READONLY_FLAG]: true }),
      name: Type.String({ description: 'Product name' }),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Product description' })),
      active: Type.Boolean({ description: 'Whether the product is available for purchase' }),
      default_price: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Default price ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'prices' },
        }),
      ),
      images: Type.Optional(Type.Array(Type.String(), { description: 'Product image URLs', [READONLY_FLAG]: true })),
      metadata: metadataSchema(),
      url: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Product URL' })),
      type: Type.Optional(Type.String({ description: 'Product type', [READONLY_FLAG]: true })),
      created: Type.Number({ description: 'Created timestamp (Unix)', [READONLY_FLAG]: true }),
      updated: Type.Number({ description: 'Updated timestamp (Unix)', [READONLY_FLAG]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [READONLY_FLAG]: true }),
    },
    { $id: 'stripe/products', title: 'Products' },
  );
}

function buildPriceSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [READONLY_FLAG]: true }),
      object: Type.String({ description: 'Object type', [READONLY_FLAG]: true }),
      product: Type.String({
        description: 'Product ID',
        [READONLY_FLAG]: true,
        [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'products' },
      }),
      active: Type.Boolean({ description: 'Whether the price is active' }),
      currency: Type.String({ description: 'Three-letter ISO currency code' }),
      unit_amount: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Price in cents', [READONLY_FLAG]: true }),
      ),
      unit_amount_decimal: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Price in cents as decimal string',
          [READONLY_FLAG]: true,
        }),
      ),
      type: Type.String({ description: 'Price type (one_time or recurring)', [READONLY_FLAG]: true }),
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
          { description: 'Recurring pricing details', [READONLY_FLAG]: true },
        ),
      ),
      billing_scheme: Type.Optional(Type.String({ description: 'Billing scheme', [READONLY_FLAG]: true })),
      nickname: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Price nickname' })),
      metadata: metadataSchema(),
      lookup_key: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Lookup key', [READONLY_FLAG]: true }),
      ),
      created: Type.Number({ description: 'Created timestamp (Unix)', [READONLY_FLAG]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [READONLY_FLAG]: true }),
    },
    { $id: 'stripe/prices', title: 'Prices' },
  );
}

function buildSubscriptionSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [READONLY_FLAG]: true }),
      object: Type.String({ description: 'Object type', [READONLY_FLAG]: true }),
      customer: Type.String({
        description: 'Customer ID',
        [READONLY_FLAG]: true,
        [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customers' },
      }),
      status: Type.String({
        description:
          'Subscription status (active, past_due, unpaid, canceled, incomplete, incomplete_expired, trialing, paused)',
        [READONLY_FLAG]: true,
      }),
      current_period_start: Type.Number({
        description: 'Current period start (Unix)',
        [READONLY_FLAG]: true,
      }),
      current_period_end: Type.Number({
        description: 'Current period end (Unix)',
        [READONLY_FLAG]: true,
      }),
      cancel_at_period_end: Type.Boolean({
        description: 'Will cancel at end of period',
        [READONLY_FLAG]: true,
      }),
      canceled_at: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], {
          description: 'Cancellation timestamp (Unix)',
          [READONLY_FLAG]: true,
        }),
      ),
      ended_at: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], {
          description: 'End timestamp (Unix)',
          [READONLY_FLAG]: true,
        }),
      ),
      start_date: Type.Number({ description: 'Start date (Unix)', [READONLY_FLAG]: true }),
      trial_start: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Trial start (Unix)', [READONLY_FLAG]: true }),
      ),
      trial_end: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Trial end (Unix)', [READONLY_FLAG]: true }),
      ),
      default_payment_method: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Default payment method ID',
          [READONLY_FLAG]: true,
        }),
      ),
      latest_invoice: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Latest invoice ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'invoices' },
        }),
      ),
      collection_method: Type.Optional(Type.String({ description: 'Collection method', [READONLY_FLAG]: true })),
      currency: Type.String({ description: 'Currency code', [READONLY_FLAG]: true }),
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
              }),
            ),
            has_more: Type.Optional(Type.Boolean()),
            url: Type.Optional(Type.String()),
          },
          { description: 'Subscription line items', [READONLY_FLAG]: true },
        ),
      ),
      created: Type.Number({ description: 'Created timestamp (Unix)', [READONLY_FLAG]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [READONLY_FLAG]: true }),
    },
    { $id: 'stripe/subscriptions', title: 'Subscriptions' },
  );
}

function buildInvoiceSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [READONLY_FLAG]: true }),
      object: Type.String({ description: 'Object type', [READONLY_FLAG]: true }),
      customer: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Customer ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customers' },
        }),
      ),
      subscription: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Subscription ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'subscriptions' },
        }),
      ),
      status: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Invoice status (draft, open, paid, uncollectible, void)',
          [READONLY_FLAG]: true,
        }),
      ),
      currency: Type.String({ description: 'Currency code', [READONLY_FLAG]: true }),
      amount_due: Type.Number({ description: 'Amount due in cents', [READONLY_FLAG]: true }),
      amount_paid: Type.Number({ description: 'Amount paid in cents', [READONLY_FLAG]: true }),
      amount_remaining: Type.Number({ description: 'Amount remaining in cents', [READONLY_FLAG]: true }),
      subtotal: Type.Number({ description: 'Subtotal in cents', [READONLY_FLAG]: true }),
      total: Type.Number({ description: 'Total in cents', [READONLY_FLAG]: true }),
      tax: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Tax amount in cents', [READONLY_FLAG]: true }),
      ),
      number: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Invoice number', [READONLY_FLAG]: true }),
      ),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Invoice description' })),
      due_date: Type.Optional(
        Type.Union([Type.Number(), Type.Null()], { description: 'Due date (Unix)', [READONLY_FLAG]: true }),
      ),
      paid: Type.Boolean({ description: 'Whether the invoice is paid', [READONLY_FLAG]: true }),
      period_start: Type.Number({ description: 'Period start (Unix)', [READONLY_FLAG]: true }),
      period_end: Type.Number({ description: 'Period end (Unix)', [READONLY_FLAG]: true }),
      hosted_invoice_url: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Hosted invoice page URL',
          [READONLY_FLAG]: true,
        }),
      ),
      invoice_pdf: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Invoice PDF URL', [READONLY_FLAG]: true }),
      ),
      collection_method: Type.Optional(Type.String({ description: 'Collection method', [READONLY_FLAG]: true })),
      metadata: metadataSchema(),
      created: Type.Number({ description: 'Created timestamp (Unix)', [READONLY_FLAG]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [READONLY_FLAG]: true }),
    },
    { $id: 'stripe/invoices', title: 'Invoices' },
  );
}

function buildPaymentIntentSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [READONLY_FLAG]: true }),
      object: Type.String({ description: 'Object type', [READONLY_FLAG]: true }),
      customer: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Customer ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customers' },
        }),
      ),
      amount: Type.Number({ description: 'Amount in cents', [READONLY_FLAG]: true }),
      amount_received: Type.Number({ description: 'Amount received in cents', [READONLY_FLAG]: true }),
      currency: Type.String({ description: 'Currency code', [READONLY_FLAG]: true }),
      status: Type.String({
        description: 'Payment intent status',
        [READONLY_FLAG]: true,
      }),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Description' })),
      payment_method: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Payment method ID',
          [READONLY_FLAG]: true,
        }),
      ),
      invoice: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Invoice ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'invoices' },
        }),
      ),
      capture_method: Type.Optional(Type.String({ description: 'Capture method', [READONLY_FLAG]: true })),
      confirmation_method: Type.Optional(Type.String({ description: 'Confirmation method', [READONLY_FLAG]: true })),
      metadata: metadataSchema(),
      latest_charge: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Latest charge ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'charges' },
        }),
      ),
      created: Type.Number({ description: 'Created timestamp (Unix)', [READONLY_FLAG]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [READONLY_FLAG]: true }),
    },
    { $id: 'stripe/payment_intents', title: 'Payment Intents' },
  );
}

function buildChargeSchema(): TSchema {
  return Type.Object(
    {
      id: Type.String({ description: 'Unique identifier', [READONLY_FLAG]: true }),
      object: Type.String({ description: 'Object type', [READONLY_FLAG]: true }),
      customer: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Customer ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customers' },
        }),
      ),
      amount: Type.Number({ description: 'Amount in cents', [READONLY_FLAG]: true }),
      amount_captured: Type.Number({ description: 'Amount captured in cents', [READONLY_FLAG]: true }),
      amount_refunded: Type.Number({ description: 'Amount refunded in cents', [READONLY_FLAG]: true }),
      currency: Type.String({ description: 'Currency code', [READONLY_FLAG]: true }),
      status: Type.String({ description: 'Charge status (succeeded, pending, failed)', [READONLY_FLAG]: true }),
      paid: Type.Boolean({ description: 'Whether the charge was paid', [READONLY_FLAG]: true }),
      captured: Type.Boolean({ description: 'Whether the charge was captured', [READONLY_FLAG]: true }),
      refunded: Type.Boolean({ description: 'Whether the charge was refunded', [READONLY_FLAG]: true }),
      disputed: Type.Boolean({ description: 'Whether the charge is disputed', [READONLY_FLAG]: true }),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Charge description' })),
      payment_intent: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Payment intent ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'payment_intents' },
        }),
      ),
      payment_method: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Payment method ID',
          [READONLY_FLAG]: true,
        }),
      ),
      invoice: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Invoice ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'invoices' },
        }),
      ),
      receipt_email: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Receipt email', [READONLY_FLAG]: true }),
      ),
      receipt_url: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Receipt URL', [READONLY_FLAG]: true }),
      ),
      failure_code: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Failure code', [READONLY_FLAG]: true }),
      ),
      failure_message: Type.Optional(
        Type.Union([Type.String(), Type.Null()], { description: 'Failure message', [READONLY_FLAG]: true }),
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
          { description: 'Billing details', [READONLY_FLAG]: true },
        ),
      ),
      metadata: metadataSchema(),
      created: Type.Number({ description: 'Created timestamp (Unix)', [READONLY_FLAG]: true }),
      livemode: Type.Boolean({ description: 'Live mode flag', [READONLY_FLAG]: true }),
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
 */
export function buildStripeJsonTableSpec(id: EntityId, entityType: StripeEntityType): BaseJsonTableSpec {
  const schema = buildSchema(entityType);

  return {
    id,
    slug: id.wsId,
    name: ENTITY_DISPLAY_NAMES[entityType],
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: getTitleColumnRemoteId(entityType),
    slugFieldPath: getSlugFieldPath(entityType),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
