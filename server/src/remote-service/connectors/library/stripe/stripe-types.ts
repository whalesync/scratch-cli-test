/**
 * Types for the Stripe API.
 *
 * Stripe is a payment processing platform with resources like
 * customers, products, prices, subscriptions, invoices, payment intents, and charges.
 *
 * API Documentation: https://stripe.com/docs/api
 */

/**
 * Credentials for authenticating with the Stripe API.
 */
export interface StripeCredentials {
  /** Stripe secret API key (sk_live_... or sk_test_...) */
  apiKey: string;
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
  | 'charges';

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
 * Stripe Customer
 */
export interface StripeCustomer {
  id: string;
  object: 'customer';
  name: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
  address: StripeAddress | null;
  shipping: StripeShipping | null;
  metadata: Record<string, string>;
  currency: string | null;
  balance: number;
  delinquent: boolean;
  default_source: string | null;
  invoice_prefix: string | null;
  invoice_settings: StripeInvoiceSettings | null;
  tax_exempt: 'none' | 'exempt' | 'reverse' | null;
  created: number;
  livemode: boolean;
}

/**
 * Stripe Product
 */
export interface StripeProduct {
  id: string;
  object: 'product';
  name: string;
  description: string | null;
  active: boolean;
  default_price: string | null;
  images: string[];
  metadata: Record<string, string>;
  url: string | null;
  type: string;
  created: number;
  updated: number;
  livemode: boolean;
}

/**
 * Stripe Price
 */
export interface StripePrice {
  id: string;
  object: 'price';
  product: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  type: 'one_time' | 'recurring';
  recurring: StripeRecurring | null;
  billing_scheme: 'per_unit' | 'tiered';
  nickname: string | null;
  metadata: Record<string, string>;
  lookup_key: string | null;
  created: number;
  livemode: boolean;
}

/**
 * Stripe Subscription
 */
export interface StripeSubscription {
  id: string;
  object: 'subscription';
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  start_date: number;
  trial_start: number | null;
  trial_end: number | null;
  default_payment_method: string | null;
  latest_invoice: string | null;
  collection_method: 'charge_automatically' | 'send_invoice';
  currency: string;
  metadata: Record<string, string>;
  items: StripeListResponse<StripeSubscriptionItem>;
  created: number;
  livemode: boolean;
}

/**
 * Stripe Subscription Item
 */
export interface StripeSubscriptionItem {
  id: string;
  object: 'subscription_item';
  price: StripePrice;
  quantity: number;
  metadata: Record<string, string>;
  created: number;
  /** The billing period lives here, not on the parent subscription. */
  current_period_start?: number;
  current_period_end?: number;
}

/**
 * Stripe Invoice
 */
export interface StripeInvoice {
  id: string;
  object: 'invoice';
  customer: string | null;
  parent: StripeInvoiceParent | null;
  status: string | null;
  currency: string;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  subtotal: number;
  total: number;
  total_taxes: StripeInvoiceTotalTax[] | null;
  number: string | null;
  description: string | null;
  due_date: number | null;
  status_transitions: StripeInvoiceStatusTransitions | null;
  period_start: number;
  period_end: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  collection_method: 'charge_automatically' | 'send_invoice';
  metadata: Record<string, string>;
  created: number;
  livemode: boolean;
}

/**
 * Stripe PaymentIntent
 */
export interface StripePaymentIntent {
  id: string;
  object: 'payment_intent';
  customer: string | null;
  amount: number;
  amount_received: number;
  currency: string;
  status: string;
  description: string | null;
  payment_method: string | null;
  capture_method: string;
  confirmation_method: string;
  metadata: Record<string, string>;
  latest_charge: string | null;
  created: number;
  livemode: boolean;
}

/**
 * Stripe Charge
 */
export interface StripeCharge {
  id: string;
  object: 'charge';
  customer: string | null;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  currency: string;
  status: string;
  paid: boolean;
  captured: boolean;
  refunded: boolean;
  disputed: boolean;
  description: string | null;
  payment_intent: string | null;
  payment_method: string | null;
  receipt_email: string | null;
  receipt_url: string | null;
  failure_code: string | null;
  failure_message: string | null;
  billing_details: StripeBillingDetails | null;
  metadata: Record<string, string>;
  created: number;
  livemode: boolean;
}

// ============= Shared sub-types =============

export interface StripeAddress {
  city: string | null;
  country: string | null;
  line1: string | null;
  line2: string | null;
  postal_code: string | null;
  state: string | null;
}

export interface StripeShipping {
  name: string | null;
  phone: string | null;
  address: StripeAddress | null;
}

export interface StripeInvoiceSettings {
  default_payment_method: string | null;
  footer: string | null;
}

/** What generated an invoice — replaces the removed top-level `Invoice.subscription`. */
export interface StripeInvoiceParent {
  type: 'subscription_details' | 'quote_details';
  subscription_details: {
    subscription: string | null;
    subscription_proration_date: number | null;
    metadata: Record<string, string> | null;
  } | null;
  quote_details: { quote: string } | null;
}

/** Aggregate tax on an invoice — replaces the removed top-level `Invoice.tax`. */
export interface StripeInvoiceTotalTax {
  amount: number;
  tax_behavior: 'exclusive' | 'inclusive';
  taxability_reason: string | null;
  taxable_amount: number | null;
  type: string;
  tax_rate_details: { tax_rate: string } | null;
}

/** When an invoice moved through each status — `paid_at` replaces the removed `Invoice.paid`. */
export interface StripeInvoiceStatusTransitions {
  finalized_at: number | null;
  marked_uncollectible_at: number | null;
  paid_at: number | null;
  voided_at: number | null;
}

export interface StripeRecurring {
  interval: 'day' | 'week' | 'month' | 'year';
  interval_count: number;
  usage_type: 'metered' | 'licensed';
}

export interface StripeBillingDetails {
  name: string | null;
  email: string | null;
  phone: string | null;
  address: StripeAddress | null;
}

/**
 * Union type for all Stripe entities
 */
export type StripeEntity =
  | StripeCustomer
  | StripeProduct
  | StripePrice
  | StripeSubscription
  | StripeInvoice
  | StripePaymentIntent
  | StripeCharge;
