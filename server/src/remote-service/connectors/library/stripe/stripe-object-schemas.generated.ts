// GENERATED FILE — do not edit by hand. Regenerate with server/scripts/generate-stripe-object-schemas.mjs
// from https://github.com/stripe/openapi (openapi/spec3.json).

/** The Stripe API version these shapes were generated from. Must equal STRIPE_CONNECTOR_API_VERSION. */
export const STRIPE_OBJECT_SCHEMAS_API_VERSION = '2026-07-29.dahlia';

/** The Stripe objects whose schemas this file carries — Stripe's own object names. */
export type StripeObjectName =
  | 'customer'
  | 'product'
  | 'price'
  | 'subscription'
  | 'invoice'
  | 'payment_intent'
  | 'charge'
  | 'refund'
  | 'dispute'
  | 'credit_note'
  | 'coupon'
  | 'promotion_code'
  | 'balance_transaction'
  | 'subscription_schedule'
  | 'event';

/**
 * One self-contained JSON Schema per Stripe object, keyed by Stripe's own object name. Deliberately
 * typed loosely (not `as const`): literal-typing this much JSON only slows the compiler down, and
 * consumers walk it as plain JSON Schema anyway.
 */
export const STRIPE_OBJECT_SCHEMAS_BY_STRIPE_OBJECT_NAME: Record<StripeObjectName, Record<string, unknown>> = {
  customer: {
    type: 'object',
    properties: {
      address: {
        anyOf: [
          {
            type: 'object',
            properties: {
              city: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'City, district, suburb, town, or village.',
              },
              country: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Two-letter country code (ISO 3166-1 alpha-2).',
              },
              line1: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Address line 1, such as the street, PO Box, or company name.',
              },
              line2: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Address line 2, such as the apartment, suite, unit, or building.',
              },
              postal_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'ZIP or postal code.',
              },
              state: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'State, county, province, or region (ISO 3166-2).',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's address.",
      },
      balance: {
        type: 'integer',
        description: "The current balance, if any, that's stored on the customer in their default currency.",
      },
      business_name: {
        type: 'string',
        description: "The customer's business name.",
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Three-letter ISO code for the currency the customer can be charged in for recurring billing purposes.',
      },
      customer_account: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The ID of an Account representing a customer.',
      },
      default_source: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['bank_account', 'card', 'source'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the default payment source for the customer.',
      },
      delinquent: {
        anyOf: [
          {
            type: 'boolean',
          },
          {
            type: 'null',
          },
        ],
        description: 'Tracks the most recent state change on any invoice belonging to the customer.',
      },
      description: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'An arbitrary string attached to the object.',
      },
      discount: {
        anyOf: [
          {
            type: 'object',
            properties: {
              checkout_session: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The Checkout session that this coupon is applied to, if it is applied to a particular session in payment mode.',
              },
              customer: {
                anyOf: [
                  {
                    type: 'string',
                    'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the customer associated with this discount.',
              },
              customer_account: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the account representing the customer associated with this discount.',
              },
              end: {
                anyOf: [
                  {
                    type: 'integer',
                    format: 'unix-time',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'If the coupon has a duration of `repeating`, the date that this discount will end.',
              },
              id: {
                type: 'string',
                description: 'The ID of the discount object.',
              },
              invoice: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "The invoice that the discount's coupon was applied to, if it was applied directly to a particular invoice.",
              },
              invoice_item: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "The invoice item `id` (or invoice line item `id` for invoice line items of type='subscription') that the discount's coupon was applied to, if it was applied directly to a particular invoice item or i…",
              },
              object: {
                type: 'string',
                description: "String representing the object's type. One of: discount.",
              },
              promotion_code: {
                anyOf: [
                  {
                    type: 'string',
                    'x-stripe-expandable-resources': ['promotion_code'],
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The promotion code applied to create this discount.',
              },
              source: {
                type: 'object',
                properties: {
                  coupon: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['coupon'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The coupon that was redeemed to create this discount.',
                  },
                  type: {
                    type: 'string',
                    description: 'The source type of the discount. One of: coupon.',
                  },
                },
              },
              start: {
                type: 'integer',
                format: 'unix-time',
                description: 'Date that the coupon was applied.',
              },
              subscription: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The subscription that this coupon is applied to, if it is applied to a particular subscription.',
              },
              subscription_item: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The subscription item that this coupon is applied to, if it is applied to a particular subscription item.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Describes the current discount active on the customer, if there is one.',
      },
      email: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's email address.",
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      individual_name: {
        type: 'string',
        description: "The customer's individual name.",
      },
      invoice_prefix: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The prefix for the customer used to generate unique invoice numbers.',
      },
      invoice_settings: {
        type: 'object',
        properties: {
          custom_fields: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description: 'The name of the custom field.',
                    },
                    value: {
                      type: 'string',
                      description: 'The value of the custom field.',
                    },
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Default custom fields to be displayed on invoices for this customer.',
          },
          default_payment_method: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['payment_method'],
              },
              {
                type: 'null',
              },
            ],
            description:
              "ID of a payment method that's attached to the customer, to be used as the customer's default payment method for subscriptions and invoices.",
          },
          footer: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Default footer to be displayed on invoices for this customer.',
          },
          rendering_options: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount_tax_display: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'How line-item prices and amounts will be displayed with respect to tax on invoice PDFs.',
                  },
                  template: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "ID of the invoice rendering template to be used for this customer's invoices.",
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Default options for invoice PDF rendering for this customer.',
          },
        },
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      metadata: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's full name or business name.",
      },
      next_invoice_sequence: {
        type: 'integer',
        description: "The suffix of the customer's next invoice number (for example, 0001).",
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: customer.",
      },
      phone: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's phone number.",
      },
      preferred_locales: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's preferred locales (languages), ordered by preference.",
      },
      shipping: {
        anyOf: [
          {
            type: 'object',
            properties: {
              address: {
                type: 'object',
                properties: {
                  city: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'City, district, suburb, town, or village.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter country code (ISO 3166-1 alpha-2).',
                  },
                  line1: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 1, such as the street, PO Box, or company name.',
                  },
                  line2: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 2, such as the apartment, suite, unit, or building.',
                  },
                  postal_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ZIP or postal code.',
                  },
                  state: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'State, county, province, or region (ISO 3166-2).',
                  },
                },
              },
              carrier: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The delivery service that shipped a physical product, such as Fedex, UPS, USPS, etc.',
              },
              name: {
                type: 'string',
                description: 'Recipient name.',
              },
              phone: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Recipient phone (including extension).',
              },
              tracking_number: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The tracking number for a physical product, obtained from the delivery service.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Mailing and shipping address for the customer.',
      },
      tax_exempt: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          "Describes the customer's tax exemption status, which is `none`, `exempt`, or `reverse`. One of: exempt, none, reverse.",
      },
      test_clock: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['test_helpers.test_clock'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the test clock that this customer belongs to.',
      },
    },
    description: 'This object represents a customer of your business.',
  },
  product: {
    type: 'object',
    properties: {
      active: {
        type: 'boolean',
        description: 'Whether the product is currently available for purchase.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      default_price: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['price'],
          },
          {
            type: 'null',
          },
        ],
        description: 'The ID of the Price object that is the default price for this product.',
      },
      description: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The product's description, meant to be displayable to the customer.",
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      images: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'A list of up to 8 URLs of images for this product, meant to be displayable to the customer.',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      marketing_features: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The marketing feature name.',
            },
          },
        },
        description: 'A list of up to 15 marketing features for this product.',
      },
      metadata: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      name: {
        type: 'string',
        description: "The product's name, meant to be displayable to the customer.",
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: product.",
      },
      package_dimensions: {
        anyOf: [
          {
            type: 'object',
            properties: {
              height: {
                type: 'number',
                description: 'Height, in inches.',
              },
              length: {
                type: 'number',
                description: 'Length, in inches.',
              },
              weight: {
                type: 'number',
                description: 'Weight, in ounces.',
              },
              width: {
                type: 'number',
                description: 'Width, in inches.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The dimensions of this product for shipping purposes.',
      },
      shippable: {
        anyOf: [
          {
            type: 'boolean',
          },
          {
            type: 'null',
          },
        ],
        description: 'Whether this product is shipped (i.e., physical goods).',
      },
      statement_descriptor: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "Extra information about a product which will appear on your customer's credit card statement.",
      },
      tax_code: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['tax_code'],
          },
          {
            type: 'null',
          },
        ],
        description: 'A tax code ID.',
      },
      unit_label: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A label that represents units of this product.',
      },
      updated: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was last updated.',
      },
      url: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A URL of a publicly-accessible webpage for this product.',
      },
      type: {
        type: 'string',
        description: 'Whether the product is a good or a service. One of: good, service.',
      },
    },
    description: 'Products describe the specific goods or services you offer to your customers.',
  },
  price: {
    type: 'object',
    properties: {
      active: {
        type: 'boolean',
        description: 'Whether the price can be used for new purchases.',
      },
      billing_scheme: {
        type: 'string',
        description: 'Describes how to compute the price per period. One of: per_unit, tiered.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code, in lowercase.',
      },
      custom_unit_amount: {
        anyOf: [
          {
            type: 'object',
            properties: {
              maximum: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The maximum unit amount the customer can specify for this item.',
              },
              minimum: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The minimum unit amount the customer can specify for this item.',
              },
              preset: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The starting unit amount which can be updated by the customer.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'When set, provides configuration for the amount to be adjusted by the customer during Checkout Sessions and Payment Links.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      lookup_key: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A lookup key used to retrieve prices dynamically from a static string.',
      },
      metadata: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      nickname: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A brief description of the price, hidden from customers.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: price.",
      },
      product: {
        type: 'string',
        'x-stripe-expandable-resources': ['product', 'deleted_product'],
        description: 'The ID of the product this price is associated with.',
      },
      recurring: {
        anyOf: [
          {
            type: 'object',
            properties: {
              interval: {
                type: 'string',
                description: 'The frequency at which a subscription is billed. One of: day, month, week, year.',
              },
              interval_count: {
                type: 'integer',
                description:
                  'The number of intervals (specified in the `interval` attribute) between subscription billings.',
              },
              meter: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The meter tracking the usage of a metered price',
              },
              usage_type: {
                type: 'string',
                description: 'Configures how the quantity per period should be determined. One of: licensed, metered.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The recurring components of a price such as `interval` and `usage_type`.',
      },
      tax_behavior: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Only required if a default tax behavior) was not provided in the Stripe Tax settings. One of: exclusive, inclusive, unspecified.',
      },
      tiers_mode: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Defines if the tiering price should be `graduated` or `volume` based. One of: graduated, volume.',
      },
      transform_quantity: {
        anyOf: [
          {
            type: 'object',
            properties: {
              divide_by: {
                type: 'integer',
                description: 'Divide usage by this number.',
              },
              round: {
                type: 'string',
                description: 'After division, either round the result `up` or `down`. One of: down, up.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Apply a transformation to the reported usage or set quantity before computing the amount billed.',
      },
      type: {
        type: 'string',
        description:
          'One of `one_time` or `recurring` depending on whether the price is for a one-time purchase or a recurring (subscription) purchase. One of: one_time, recurring.',
      },
      unit_amount: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The unit amount in cents (or local equivalent) to be charged, represented as a whole integer if possible.',
      },
      unit_amount_decimal: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The unit amount in cents (or local equivalent) to be charged, represented as a decimal string with at most 12 decimal places.',
      },
    },
    description:
      'Prices define the unit cost, currency, and (optional) billing cycle for both recurring and one-time purchases of products.',
  },
  subscription: {
    type: 'object',
    properties: {
      application: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['application', 'deleted_application'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the Connect Application that created the subscription.',
      },
      application_fee_percent: {
        anyOf: [
          {
            type: 'number',
          },
          {
            type: 'null',
          },
        ],
        description: 'A non-negative decimal between 0 and 100, with at most two decimal places.',
      },
      automatic_tax: {
        type: 'object',
        properties: {
          disabled_reason: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'If Stripe disabled automatic tax, this enum describes why. One of: requires_location_inputs.',
          },
          enabled: {
            type: 'boolean',
            description: 'Whether Stripe automatically computes tax on this subscription.',
          },
          liability: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  account: {
                    type: 'string',
                    'x-stripe-expandable-resources': ['account'],
                    description: 'The connected account being referenced when `type` is `account`.',
                  },
                  type: {
                    type: 'string',
                    description: 'Type of the account referenced. One of: account, self.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: "The account that's liable for tax.",
          },
        },
      },
      billing_cycle_anchor: {
        type: 'integer',
        format: 'unix-time',
        description: 'The reference point that aligns future billing cycle dates.',
      },
      billing_cycle_anchor_config: {
        anyOf: [
          {
            type: 'object',
            properties: {
              day_of_month: {
                type: 'integer',
                description: 'The day of the month of the billing_cycle_anchor.',
              },
              hour: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The hour of the day of the billing_cycle_anchor.',
              },
              minute: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The minute of the hour of the billing_cycle_anchor.',
              },
              month: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The month to start full cycle billing periods.',
              },
              second: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The second of the minute of the billing_cycle_anchor.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The fixed values used to calculate the `billing_cycle_anchor`.',
      },
      billing_mode: {
        type: 'object',
        properties: {
          flexible: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  proration_discounts: {
                    type: 'string',
                    description:
                      'Controls how invoices and invoice items display proration amounts and discount amounts. One of: included, itemized.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Configure behavior for flexible billing mode',
          },
          type: {
            type: 'string',
            description:
              'Controls how prorations and invoices for subscriptions are calculated and orchestrated. One of: classic, flexible.',
          },
          updated_at: {
            type: 'integer',
            format: 'unix-time',
            description: 'Details on when the current billing_mode was adopted.',
          },
        },
        description: 'The billing mode of the subscription.',
      },
      billing_schedules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            applies_to: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      price: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['price'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The billing schedule will apply to the subscription item with the given price ID.',
                      },
                      type: {
                        type: 'string',
                        description:
                          'Controls which subscription items the billing schedule applies to. One of: price.',
                      },
                    },
                    description: 'Represents the entities that the billing schedule applies to.',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'Specifies which subscription items the billing schedule applies to.',
            },
            bill_until: {
              type: 'object',
              properties: {
                computed_timestamp: {
                  type: 'integer',
                  format: 'unix-time',
                  description: 'The timestamp the billing schedule will apply until.',
                },
                duration: {
                  anyOf: [
                    {
                      type: 'object',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Specifies the billing period.',
                },
                timestamp: {
                  anyOf: [
                    {
                      type: 'integer',
                      format: 'unix-time',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'If specified, the billing schedule will apply until the specified timestamp.',
                },
                type: {
                  type: 'string',
                  description:
                    'Describes how the billing schedule will determine the end date. One of: duration, timestamp.',
                },
              },
              description: 'Specifies the end of billing period.',
            },
            key: {
              type: 'string',
              description: 'Unique identifier for the billing schedule.',
            },
          },
          description: 'Sets the billing schedule for the subscription.',
        },
        description: 'Billing schedules for this subscription.',
      },
      billing_thresholds: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount_gte: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Monetary threshold that triggers the subscription to create an invoice',
              },
              reset_billing_cycle_anchor: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates if the `billing_cycle_anchor` should be reset when a threshold is reached.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Define thresholds at which an invoice will be sent, and the subscription advanced to a new billing period',
      },
      cancel_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'A date in the future at which the subscription will automatically get canceled',
      },
      cancel_at_period_end: {
        type: 'boolean',
        description:
          'Whether this subscription will (if `status=active`) or did (if `status=canceled`) cancel at the end of the current billing period.',
      },
      canceled_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'If the subscription has been canceled, the date of that cancellation.',
      },
      cancellation_details: {
        anyOf: [
          {
            type: 'object',
            properties: {
              comment: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Additional comments about why the user canceled the subscription, if the subscription was canceled explicitly by the user.',
              },
              feedback: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The customer submitted reason for why they canceled, if the subscription was canceled explicitly by the user. One of: customer_service, low_quality, missing_features, other, switched_service, too_complex, too_expensive, unused.',
              },
              reason: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Why this subscription was canceled. One of: canceled_by_retention_policy, cancellation_requested, payment_disputed, payment_failed.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Details about why this subscription was cancelled',
      },
      collection_method: {
        type: 'string',
        description: 'Either `charge_automatically`, or `send_invoice`. One of: charge_automatically, send_invoice.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code, in lowercase.',
      },
      customer: {
        type: 'string',
        'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
        description: 'ID of the customer who owns the subscription.',
      },
      customer_account: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the account representing the customer who owns the subscription.',
      },
      days_until_due: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description: 'Number of days a customer has to pay invoices generated by this subscription.',
      },
      default_payment_method: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['payment_method'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the default payment method for the subscription.',
      },
      default_source: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['bank_account', 'card', 'source'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the default payment source for the subscription.',
      },
      default_tax_rates: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                active: {
                  type: 'boolean',
                  description: 'Defaults to `true`.',
                },
                country: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Two-letter country code (ISO 3166-1 alpha-2).',
                },
                created: {
                  type: 'integer',
                  format: 'unix-time',
                  description: 'Time at which the object was created.',
                },
                description: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'An arbitrary string attached to the tax rate for your internal use only.',
                },
                display_name: {
                  type: 'string',
                  description:
                    'The display name of the tax rates as it will appear to your customer on their receipt email, PDF, and the hosted invoice page.',
                },
                effective_percentage: {
                  anyOf: [
                    {
                      type: 'number',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Actual/effective tax rate percentage out of 100.',
                },
                flat_amount: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        amount: {
                          type: 'integer',
                          description: 'Amount of the tax when the `rate_type` is `flat_amount`.',
                        },
                        currency: {
                          type: 'string',
                          description: 'Three-letter ISO currency code, in lowercase.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The amount of the tax rate when the `rate_type` is `flat_amount`.',
                },
                id: {
                  type: 'string',
                  description: 'Unique identifier for the object.',
                },
                inclusive: {
                  type: 'boolean',
                  description: 'This specifies if the tax rate is inclusive or exclusive.',
                },
                jurisdiction: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The jurisdiction for the tax rate.',
                },
                jurisdiction_level: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'The level of the jurisdiction that imposes this tax rate. One of: city, country, county, district, multiple, state.',
                },
                livemode: {
                  type: 'boolean',
                  description: 'If the object exists in live mode, the value is `true`.',
                },
                metadata: {
                  anyOf: [
                    {
                      type: 'object',
                      additionalProperties: {
                        type: 'string',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Set of key-value pairs that you can attach to an object.',
                },
                object: {
                  type: 'string',
                  description: "String representing the object's type. One of: tax_rate.",
                },
                percentage: {
                  type: 'number',
                  description: 'Tax rate percentage out of 100.',
                },
                rate_type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'Indicates the type of tax rate applied to the taxable amount. One of: flat_amount, percentage.',
                },
                state: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'ISO 3166-2 subdivision code, without country prefix.',
                },
                tax_type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The high-level tax type, such as `vat` or `sales_tax`.',
                },
              },
              description: 'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The tax rates that will apply to any subscription item that does not have `tax_rates` set.',
      },
      description: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The subscription's description, meant to be displayable to the customer.",
      },
      discounts: {
        type: 'array',
        items: {
          type: 'string',
          'x-stripe-expandable-resources': ['discount'],
        },
        description: 'The discounts applied to the subscription.',
      },
      ended_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'If the subscription has ended, the date the subscription ended.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      invoice_settings: {
        type: 'object',
        properties: {
          account_tax_ids: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'string',
                  'x-stripe-expandable-resources': ['tax_id', 'deleted_tax_id'],
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The account tax IDs associated with the subscription.',
          },
          custom_fields: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description: 'The name of the custom field.',
                    },
                    value: {
                      type: 'string',
                      description: 'The value of the custom field.',
                    },
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'A list of up to 4 custom fields to be displayed on the invoice.',
          },
          description: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'An arbitrary string attached to the object.',
          },
          footer: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Footer to be displayed on the invoice.',
          },
          issuer: {
            type: 'object',
            properties: {
              account: {
                type: 'string',
                'x-stripe-expandable-resources': ['account'],
                description: 'The connected account being referenced when `type` is `account`.',
              },
              type: {
                type: 'string',
                description: 'Type of the account referenced. One of: account, self.',
              },
            },
          },
        },
      },
      items: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                billed_until: {
                  type: 'integer',
                  format: 'unix-time',
                  description: 'The time period the subscription item has been billed for.',
                },
                billing_thresholds: {
                  anyOf: [
                    {
                      type: 'object',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'Define thresholds at which an invoice will be sent, and the related subscription advanced to a new billing period',
                },
                created: {
                  type: 'integer',
                  description: 'Time at which the object was created.',
                },
                current_period_end: {
                  type: 'integer',
                  format: 'unix-time',
                  description: "The end time of this subscription item's current billing period.",
                },
                current_period_start: {
                  type: 'integer',
                  format: 'unix-time',
                  description: "The start time of this subscription item's current billing period.",
                },
                discounts: {
                  type: 'array',
                  items: {
                    type: 'string',
                    'x-stripe-expandable-resources': ['discount'],
                  },
                  description: 'The discounts applied to the subscription item.',
                },
                id: {
                  type: 'string',
                  description: 'Unique identifier for the object.',
                },
                metadata: {
                  type: 'object',
                  description: 'Set of key-value pairs that you can attach to an object.',
                },
                object: {
                  type: 'string',
                  description: "String representing the object's type. One of: subscription_item.",
                },
                price: {
                  type: 'object',
                  description:
                    'Prices define the unit cost, currency, and (optional) billing cycle for both recurring and one-time purchases of products.',
                },
                quantity: {
                  type: 'integer',
                  description: 'The quantity of the plan to which the customer should be subscribed.',
                },
                subscription: {
                  type: 'string',
                  description: 'The `subscription` this `subscription_item` belongs to.',
                },
                tax_rates: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        description:
                          'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The tax rates which apply to this `subscription_item`.',
                },
              },
              description:
                'Subscription items allow you to create customer subscriptions with more than one plan, making it easy to represent complex billing relationships.',
            },
            description: 'Details about each object.',
          },
          has_more: {
            type: 'boolean',
            description: 'True if this list has another page of items after this one that can be fetched.',
          },
          object: {
            type: 'string',
            description: "String representing the object's type. One of: list.",
          },
          url: {
            type: 'string',
            description: 'The URL where this list can be accessed.',
          },
        },
        description: 'List of subscription items, each with an attached price.',
      },
      latest_invoice: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['invoice'],
          },
          {
            type: 'null',
          },
        ],
        description:
          'The most recent invoice this subscription has generated over its lifecycle (for example, when it cycles or is updated).',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      managed_payments: {
        anyOf: [
          {
            type: 'object',
            properties: {
              enabled: {
                type: 'boolean',
                description:
                  "Set to `true` to enable Managed Payments, Stripe's merchant of record solution, for this session.",
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Settings for Managed Payments for this Subscription and resulting Invoices and PaymentIntents.',
      },
      metadata: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      next_pending_invoice_item_invoice: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Specifies the approximate timestamp on which any pending invoice items will be billed according to the schedule provided at `pending_invoice_item_interval`.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: subscription.",
      },
      on_behalf_of: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['account'],
          },
          {
            type: 'null',
          },
        ],
        description:
          'The account (if any) the charge was made on behalf of for charges associated with this subscription.',
      },
      pause_collection: {
        anyOf: [
          {
            type: 'object',
            properties: {
              behavior: {
                type: 'string',
                description:
                  'The payment collection behavior for this subscription while paused. One of: keep_as_draft, mark_uncollectible, void.',
              },
              resumes_at: {
                anyOf: [
                  {
                    type: 'integer',
                    format: 'unix-time',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The time after which the subscription will resume collecting payments.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'If specified, payment collection for this subscription will be paused.',
      },
      payment_settings: {
        anyOf: [
          {
            type: 'object',
            properties: {
              payment_method_options: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      acss_debit: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the Canadian pre-authorized debit payment method options to pass to invoices created by the subscription.',
                      },
                      bancontact: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the Bancontact payment method options to pass to invoices created by the subscription.',
                      },
                      card: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the Card payment method options to pass to invoices created by the subscription.',
                      },
                      customer_balance: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the Bank transfer payment method options to pass to invoices created by the subscription.',
                      },
                      konbini: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the Konbini payment method options to pass to invoices created by the subscription.',
                      },
                      payto: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the PayTo payment method options to pass to invoices created by the subscription.',
                      },
                      pix: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the Pix payment method options to pass to invoices created by the subscription.',
                      },
                      sepa_debit: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the SEPA Direct Debit payment method options to pass to invoices created by the subscription.',
                      },
                      upi: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the UPI payment method options to pass to invoices created by the subscription.',
                      },
                      us_bank_account: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This sub-hash contains details about the ACH direct debit payment method options to pass to invoices created by the subscription.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Payment-method-specific configuration to provide to invoices created by the subscription.',
              },
              payment_method_types: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The list of payment method types to provide to every invoice created by the subscription.',
              },
              save_default_payment_method: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Configure whether Stripe updates `subscription.default_payment_method` when payment succeeds. One of: off, on_subscription.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Payment settings passed on to invoices created by the subscription.',
      },
      pending_invoice_item_interval: {
        anyOf: [
          {
            type: 'object',
            properties: {
              interval: {
                type: 'string',
                description: 'Specifies invoicing frequency. One of: day, month, week, year.',
              },
              interval_count: {
                type: 'integer',
                description: 'The number of intervals between invoices.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Specifies an interval for how often to bill for any pending invoice items.',
      },
      pending_setup_intent: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['setup_intent'],
          },
          {
            type: 'null',
          },
        ],
        description:
          "You can use this SetupIntent to collect user authentication when creating a subscription without immediate payment or updating a subscription's payment method, allowing you to optimize for off-sessio…",
      },
      pending_update: {
        anyOf: [
          {
            type: 'object',
            properties: {
              billing_cycle_anchor: {
                anyOf: [
                  {
                    type: 'integer',
                    format: 'unix-time',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If the update is applied, determines the date of the first full invoice, and, for plans with `month` or `year` intervals, the day of the month for subsequent invoices.',
              },
              discount: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      checkout_session: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The Checkout session that this coupon is applied to, if it is applied to a particular session in payment mode.',
                      },
                      customer: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The ID of the customer associated with this discount.',
                      },
                      customer_account: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The ID of the account representing the customer associated with this discount.',
                      },
                      end: {
                        anyOf: [
                          {
                            type: 'integer',
                            format: 'unix-time',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'If the coupon has a duration of `repeating`, the date that this discount will end.',
                      },
                      id: {
                        type: 'string',
                        description: 'The ID of the discount object.',
                      },
                      invoice: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          "The invoice that the discount's coupon was applied to, if it was applied directly to a particular invoice.",
                      },
                      invoice_item: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          "The invoice item `id` (or invoice line item `id` for invoice line items of type='subscription') that the discount's coupon was applied to, if it was applied directly to a particular invoice item or i…",
                      },
                      object: {
                        type: 'string',
                        description: "String representing the object's type. One of: discount.",
                      },
                      promotion_code: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['promotion_code'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The promotion code applied to create this discount.',
                      },
                      source: {
                        type: 'object',
                      },
                      start: {
                        type: 'integer',
                        format: 'unix-time',
                        description: 'Date that the coupon was applied.',
                      },
                      subscription: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The subscription that this coupon is applied to, if it is applied to a particular subscription.',
                      },
                      subscription_item: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The subscription item that this coupon is applied to, if it is applied to a particular subscription item.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The pending subscription-level discount that will be applied when the pending update is applied.',
              },
              discounts: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                      'x-stripe-expandable-resources': ['discount'],
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The discounts that will be applied to the subscription when the pending update is applied.',
              },
              expires_at: {
                type: 'integer',
                format: 'unix-time',
                description:
                  'The point after which the changes reflected by this update will be discarded and no longer applied.',
              },
              metadata: {
                anyOf: [
                  {
                    type: 'object',
                    additionalProperties: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Set of key-value pairs that you can attach to an object.',
              },
              subscription_items: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        billed_until: {
                          type: 'integer',
                          format: 'unix-time',
                          description: 'The time period the subscription item has been billed for.',
                        },
                        billing_thresholds: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Define thresholds at which an invoice will be sent, and the related subscription advanced to a new billing period',
                        },
                        created: {
                          type: 'integer',
                          description: 'Time at which the object was created.',
                        },
                        current_period_end: {
                          type: 'integer',
                          format: 'unix-time',
                          description: "The end time of this subscription item's current billing period.",
                        },
                        current_period_start: {
                          type: 'integer',
                          format: 'unix-time',
                          description: "The start time of this subscription item's current billing period.",
                        },
                        discounts: {
                          type: 'array',
                          items: {
                            type: 'string',
                            'x-stripe-expandable-resources': ['discount'],
                          },
                          description: 'The discounts applied to the subscription item.',
                        },
                        id: {
                          type: 'string',
                          description: 'Unique identifier for the object.',
                        },
                        metadata: {
                          type: 'object',
                          description: 'Set of key-value pairs that you can attach to an object.',
                        },
                        object: {
                          type: 'string',
                          description: "String representing the object's type. One of: subscription_item.",
                        },
                        price: {
                          type: 'object',
                          description:
                            'Prices define the unit cost, currency, and (optional) billing cycle for both recurring and one-time purchases of products.',
                        },
                        quantity: {
                          type: 'integer',
                          description: 'The quantity of the plan to which the customer should be subscribed.',
                        },
                        subscription: {
                          type: 'string',
                          description: 'The `subscription` this `subscription_item` belongs to.',
                        },
                        tax_rates: {
                          anyOf: [
                            {
                              type: 'array',
                              items: {
                                type: 'object',
                                description:
                                  'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
                              },
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The tax rates which apply to this `subscription_item`.',
                        },
                      },
                      description:
                        'Subscription items allow you to create customer subscriptions with more than one plan, making it easy to represent complex billing relationships.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'List of subscription items, each with an attached plan, that will be set if the update is applied.',
              },
              trial_end: {
                anyOf: [
                  {
                    type: 'integer',
                    format: 'unix-time',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Unix timestamp representing the end of the trial period the customer will get before being charged for the first time, if the update is applied.',
              },
              trial_from_plan: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "Indicates if a plan's `trial_period_days` should be applied to the subscription.",
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'If specified, pending updates that will be applied to the subscription once the `latest_invoice` has been paid.',
      },
      presentment_details: {
        type: 'object',
        properties: {
          presentment_currency: {
            type: 'string',
            description: 'Currency used for customer payments.',
          },
        },
      },
      schedule: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['subscription_schedule'],
          },
          {
            type: 'null',
          },
        ],
        description: 'The schedule attached to the subscription',
      },
      start_date: {
        type: 'integer',
        format: 'unix-time',
        description: 'Date when the subscription was first created.',
      },
      status: {
        type: 'string',
        description:
          'Possible values are `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, or `paused`. One of: active, canceled, incomplete, incomplete_expired, past_due, paused, trialing, unpaid.',
      },
      test_clock: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['test_helpers.test_clock'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the test clock this subscription belongs to.',
      },
      transfer_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount_percent: {
                anyOf: [
                  {
                    type: 'number',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A non-negative decimal between 0 and 100, with at most two decimal places.',
              },
              destination: {
                type: 'string',
                'x-stripe-expandable-resources': ['account'],
                description: 'The account where funds from the payment will be transferred to upon payment success.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          "The account (if any) the subscription's payments will be attributed to for tax reporting, and where funds from each payment will be transferred to for each of the subscription's invoices.",
      },
      trial_end: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'If the subscription has a trial, the end of that trial.',
      },
      trial_settings: {
        anyOf: [
          {
            type: 'object',
            properties: {
              end_behavior: {
                type: 'object',
                properties: {
                  missing_payment_method: {
                    type: 'string',
                    description:
                      'Indicates how the subscription should change when the trial ends if the user did not provide a payment method. One of: cancel, create_invoice, pause.',
                  },
                },
                description: 'Defines how a subscription behaves when a trial ends.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Settings related to subscription trials.',
      },
      trial_start: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'If the subscription has a trial, the beginning of that trial.',
      },
    },
    description: 'Subscriptions allow you to charge a customer on a recurring basis.',
  },
  invoice: {
    type: 'object',
    properties: {
      account_country: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The country of the business associated with this invoice, most often the business creating the invoice.',
      },
      account_name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The public name of the business associated with this invoice, most often the business creating the invoice.',
      },
      account_tax_ids: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'string',
              'x-stripe-expandable-resources': ['tax_id', 'deleted_tax_id'],
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The account tax IDs associated with the invoice.',
      },
      amount_due: {
        type: 'integer',
        description: 'Final amount due at this time for this invoice.',
      },
      amount_overpaid: {
        type: 'integer',
        description: 'Amount that was overpaid on the invoice.',
      },
      amount_paid: {
        type: 'integer',
        description: 'The amount, in cents (or local equivalent), that was paid.',
      },
      amount_paid_off_stripe: {
        type: 'integer',
        description: 'Amount, in cents (or local equivalent), that was paid on the invoice outside of Stripe.',
      },
      amount_remaining: {
        type: 'integer',
        description: 'The difference between amount_due and amount_paid, in cents (or local equivalent).',
      },
      amount_shipping: {
        type: 'integer',
        description: 'This is the sum of all the shipping amounts.',
      },
      application: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['application', 'deleted_application'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the Connect Application that created the invoice.',
      },
      attempt_count: {
        type: 'integer',
        description:
          'Number of payment attempts made for this invoice, from the perspective of the payment retry schedule.',
      },
      attempted: {
        type: 'boolean',
        description: 'Whether an attempt has been made to pay the invoice.',
      },
      auto_advance: {
        type: 'boolean',
        description: 'Controls whether Stripe performs automatic collection of the invoice.',
      },
      automatic_tax: {
        type: 'object',
        properties: {
          disabled_reason: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'If Stripe disabled automatic tax, this enum describes why. One of: finalization_requires_location_inputs, finalization_system_error.',
          },
          enabled: {
            type: 'boolean',
            description: 'Whether Stripe automatically computes tax on this invoice.',
          },
          liability: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  account: {
                    type: 'string',
                    'x-stripe-expandable-resources': ['account'],
                    description: 'The connected account being referenced when `type` is `account`.',
                  },
                  type: {
                    type: 'string',
                    description: 'Type of the account referenced. One of: account, self.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: "The account that's liable for tax.",
          },
          provider: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The tax provider powering automatic tax.',
          },
          status: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'The status of the most recent automated tax calculation for this invoice. One of: complete, failed, requires_location_inputs.',
          },
        },
      },
      automatically_finalizes_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'The time when this invoice is currently scheduled to be automatically finalized.',
      },
      billing_reason: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Indicates the reason why the invoice was created. One of: automatic_pending_invoice_item_invoice, manual, quote_accept, subscription, subscription_create, subscription_cycle, subscription_threshold, subscription_update, upcoming.',
      },
      collection_method: {
        type: 'string',
        description: 'Either `charge_automatically`, or `send_invoice`. One of: charge_automatically, send_invoice.',
      },
      confirmation_secret: {
        anyOf: [
          {
            type: 'object',
            properties: {
              client_secret: {
                type: 'string',
                description: 'The client_secret of the payment that Stripe creates for the invoice after finalization.',
              },
              type: {
                type: 'string',
                description: 'The type of client_secret.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The confirmation secret associated with this invoice.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code, in lowercase.',
      },
      custom_fields: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'The name of the custom field.',
                },
                value: {
                  type: 'string',
                  description: 'The value of the custom field.',
                },
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Custom fields displayed on the invoice.',
      },
      customer: {
        type: 'string',
        'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
        description: 'The ID of the customer to bill.',
      },
      customer_account: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The ID of the account representing the customer to bill.',
      },
      customer_address: {
        anyOf: [
          {
            type: 'object',
            properties: {
              city: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'City, district, suburb, town, or village.',
              },
              country: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Two-letter country code (ISO 3166-1 alpha-2).',
              },
              line1: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Address line 1, such as the street, PO Box, or company name.',
              },
              line2: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Address line 2, such as the apartment, suite, unit, or building.',
              },
              postal_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'ZIP or postal code.',
              },
              state: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'State, county, province, or region (ISO 3166-2).',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's address.",
      },
      customer_email: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's email.",
      },
      customer_name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's name.",
      },
      customer_phone: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's phone number.",
      },
      customer_shipping: {
        anyOf: [
          {
            type: 'object',
            properties: {
              address: {
                type: 'object',
                properties: {
                  city: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'City, district, suburb, town, or village.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter country code (ISO 3166-1 alpha-2).',
                  },
                  line1: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 1, such as the street, PO Box, or company name.',
                  },
                  line2: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 2, such as the apartment, suite, unit, or building.',
                  },
                  postal_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ZIP or postal code.',
                  },
                  state: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'State, county, province, or region (ISO 3166-2).',
                  },
                },
              },
              carrier: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The delivery service that shipped a physical product, such as Fedex, UPS, USPS, etc.',
              },
              name: {
                type: 'string',
                description: 'Recipient name.',
              },
              phone: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Recipient phone (including extension).',
              },
              tracking_number: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The tracking number for a physical product, obtained from the delivery service.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's shipping information.",
      },
      customer_tax_exempt: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's tax exempt status. One of: exempt, none, reverse.",
      },
      customer_tax_ids: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  description:
                    'The type of the tax ID, one of `ad_nrt`, `ar_cuit`, `eu_vat`, `bo_tin`, `br_cnpj`, `br_cpf`, `cn_tin`, `co_nit`, `cr_tin`, `do_rcn`, `ec_ruc`, `eu_oss_vat`, `hr_oib`, `pe_ruc`, `ro_tin`, `rs_pib`, `s…',
                },
                value: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The value of the tax ID.',
                },
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: "The customer's tax IDs.",
      },
      default_payment_method: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['payment_method'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the default payment method for the invoice.',
      },
      default_source: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['bank_account', 'card', 'source'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the default payment source for the invoice.',
      },
      default_tax_rates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            active: {
              type: 'boolean',
              description: 'Defaults to `true`.',
            },
            country: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'Two-letter country code (ISO 3166-1 alpha-2).',
            },
            created: {
              type: 'integer',
              format: 'unix-time',
              description: 'Time at which the object was created.',
            },
            description: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'An arbitrary string attached to the tax rate for your internal use only.',
            },
            display_name: {
              type: 'string',
              description:
                'The display name of the tax rates as it will appear to your customer on their receipt email, PDF, and the hosted invoice page.',
            },
            effective_percentage: {
              anyOf: [
                {
                  type: 'number',
                },
                {
                  type: 'null',
                },
              ],
              description: 'Actual/effective tax rate percentage out of 100.',
            },
            flat_amount: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    amount: {
                      type: 'integer',
                      description: 'Amount of the tax when the `rate_type` is `flat_amount`.',
                    },
                    currency: {
                      type: 'string',
                      description: 'Three-letter ISO currency code, in lowercase.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The amount of the tax rate when the `rate_type` is `flat_amount`.',
            },
            id: {
              type: 'string',
              description: 'Unique identifier for the object.',
            },
            inclusive: {
              type: 'boolean',
              description: 'This specifies if the tax rate is inclusive or exclusive.',
            },
            jurisdiction: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'The jurisdiction for the tax rate.',
            },
            jurisdiction_level: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description:
                'The level of the jurisdiction that imposes this tax rate. One of: city, country, county, district, multiple, state.',
            },
            livemode: {
              type: 'boolean',
              description: 'If the object exists in live mode, the value is `true`.',
            },
            metadata: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: {
                    type: 'string',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'Set of key-value pairs that you can attach to an object.',
            },
            object: {
              type: 'string',
              description: "String representing the object's type. One of: tax_rate.",
            },
            percentage: {
              type: 'number',
              description: 'Tax rate percentage out of 100.',
            },
            rate_type: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description:
                'Indicates the type of tax rate applied to the taxable amount. One of: flat_amount, percentage.',
            },
            state: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'ISO 3166-2 subdivision code, without country prefix.',
            },
            tax_type: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'The high-level tax type, such as `vat` or `sales_tax`.',
            },
          },
          description: 'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
        },
        description: 'The tax rates applied to this invoice, if any.',
      },
      description: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'An arbitrary string attached to the object.',
      },
      discounts: {
        type: 'array',
        items: {
          type: 'string',
          'x-stripe-expandable-resources': ['discount', 'deleted_discount'],
        },
        description: 'The discounts applied to the invoice.',
      },
      due_date: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'The date on which payment for this invoice is due.',
      },
      effective_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'The date when this invoice is in effect.',
      },
      ending_balance: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description: 'Ending customer balance after the invoice is finalized.',
      },
      footer: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Footer displayed on the invoice.',
      },
      from_invoice: {
        anyOf: [
          {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: 'The relation between this invoice and the cloned invoice',
              },
              invoice: {
                type: 'string',
                'x-stripe-expandable-resources': ['invoice'],
                description: 'The invoice that was cloned.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Details of the invoice that was cloned.',
      },
      hosted_invoice_url: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The URL for the hosted invoice page, which allows customers to view and pay an invoice.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      invoice_pdf: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The link to download the PDF for the invoice.',
      },
      issuer: {
        type: 'object',
        properties: {
          account: {
            type: 'string',
            'x-stripe-expandable-resources': ['account'],
            description: 'The connected account being referenced when `type` is `account`.',
          },
          type: {
            type: 'string',
            description: 'Type of the account referenced. One of: account, self.',
          },
        },
      },
      last_finalization_error: {
        anyOf: [
          {
            type: 'object',
            properties: {
              advice_code: {
                type: 'string',
                description:
                  'For card errors resulting from a card issuer decline, a short string indicating how to proceed with an error if they provide one.',
              },
              charge: {
                type: 'string',
                description: 'For card errors, the ID of the failed charge.',
              },
              code: {
                type: 'string',
                description:
                  'For some errors that could be handled programmatically, a short string indicating the error code reported.',
              },
              decline_code: {
                type: 'string',
                description:
                  "For card errors resulting from a card issuer decline, a short string indicating the card issuer's reason for the decline if they provide one.",
              },
              doc_url: {
                type: 'string',
                description: 'A URL to more information about the error code reported.',
              },
              message: {
                type: 'string',
                description: 'A human-readable message providing more details about the error.',
              },
              network_advice_code: {
                type: 'string',
                description:
                  'For card errors resulting from a card issuer decline, a 2 digit code which indicates the advice given to merchant by the card network on how to proceed with an error.',
              },
              network_decline_code: {
                type: 'string',
                description:
                  'For payments declined by the network, an alphanumeric code which indicates the reason the payment failed.',
              },
              param: {
                type: 'string',
                description: 'If the error is parameter-specific, the parameter related to the error.',
              },
              payment_intent: {
                type: 'object',
                properties: {
                  allowed_payment_method_types: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The list of payment method types allowed for use with this payment.',
                  },
                  amount: {
                    type: 'integer',
                    description: 'Amount intended to be collected by this PaymentIntent.',
                  },
                  amount_capturable: {
                    type: 'integer',
                    description: 'Amount that can be captured from this PaymentIntent.',
                  },
                  amount_details: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'object',
                      },
                    ],
                  },
                  amount_received: {
                    type: 'integer',
                    description: 'Amount that this PaymentIntent collects.',
                  },
                  application: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['application'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the Connect application that created the PaymentIntent.',
                  },
                  application_fee_amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      "The amount of the application fee (if any) that will be requested to be applied to the payment and transferred to the application owner's Stripe account.",
                  },
                  automatic_payment_methods: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Settings to configure compatible payment methods from the Stripe Dashboard',
                  },
                  canceled_at: {
                    anyOf: [
                      {
                        type: 'integer',
                        format: 'unix-time',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Populated when `status` is `canceled`, this is the time at which the PaymentIntent was canceled.',
                  },
                  cancellation_reason: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Reason for cancellation of this PaymentIntent, either user-provided (`duplicate`, `fraudulent`, `requested_by_customer`, or `abandoned`) or generated by Stripe internally (`failed_invoice`, `void_inv… One of: abandoned, automatic, duplicate, expired, failed_invoice, fraudulent, requested_by_customer, void_invoice.',
                  },
                  capture_method: {
                    type: 'string',
                    description:
                      "Controls when the funds will be captured from the customer's account. One of: automatic, automatic_async, manual.",
                  },
                  client_secret: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The client secret of this PaymentIntent.',
                  },
                  confirmation_method: {
                    type: 'string',
                    description:
                      'Describes whether we can confirm this PaymentIntent automatically, or if it requires customer action to confirm the payment. One of: automatic, manual.',
                  },
                  created: {
                    type: 'integer',
                    format: 'unix-time',
                    description: 'Time at which the object was created.',
                  },
                  currency: {
                    type: 'string',
                    description: 'Three-letter ISO currency code, in lowercase.',
                  },
                  customer: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the Customer this PaymentIntent belongs to, if one exists.',
                  },
                  customer_account: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'ID of the Account representing the customer that this PaymentIntent belongs to, if one exists.',
                  },
                  description: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'An arbitrary string attached to the object.',
                  },
                  excluded_payment_method_types: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The list of payment method types to exclude from use with this payment.',
                  },
                  hooks: {
                    type: 'object',
                  },
                  id: {
                    type: 'string',
                    description: 'Unique identifier for the object.',
                  },
                  last_payment_error: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The payment error encountered in the previous PaymentIntent confirmation.',
                  },
                  latest_charge: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['charge'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the latest Charge object created by this PaymentIntent.',
                  },
                  livemode: {
                    type: 'boolean',
                    description: 'If the object exists in live mode, the value is `true`.',
                  },
                  managed_payments: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Settings for Managed Payments.',
                  },
                  metadata: {
                    type: 'object',
                    description: 'Set of key-value pairs that you can attach to an object.',
                  },
                  next_action: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If present, this property tells you what actions you need to take in order for your customer to fulfill a payment using the provided source.',
                  },
                  object: {
                    type: 'string',
                    description: "String representing the object's type. One of: payment_intent.",
                  },
                  on_behalf_of: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['account'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'You can specify the settlement merchant as the connected account using the `on_behalf_of` attribute on the charge.',
                  },
                  payment_details: {
                    type: 'object',
                  },
                  payment_method: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['payment_method'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the payment method used in this PaymentIntent.',
                  },
                  payment_method_configuration_details: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Information about the payment method configuration used for this PaymentIntent.',
                  },
                  payment_method_options: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Payment-method-specific configuration for this PaymentIntent.',
                  },
                  payment_method_types: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    description: 'The list of payment method types (e.g.',
                  },
                  presentment_details: {
                    type: 'object',
                  },
                  processing: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'If present, this property tells you about the processing state of the payment.',
                  },
                  receipt_email: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Email address that the receipt for the resulting payment will be sent to.',
                  },
                  review: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['review'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the review associated with this PaymentIntent, if any.',
                  },
                  setup_future_usage: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: off_session, on_session.",
                  },
                  shipping: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Shipping information for this PaymentIntent.',
                  },
                  statement_descriptor: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      "Text that appears on the customer's statement as the statement descriptor for a non-card charge.",
                  },
                  statement_descriptor_suffix: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Provides information about a card charge.',
                  },
                  status: {
                    type: 'string',
                    description:
                      'Status of this PaymentIntent, one of `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, `requires_capture`, `canceled`, or `succeeded`. One of: canceled, processing, requires_action, requires_capture, requires_confirmation, requires_payment_method, succeeded.',
                  },
                  transfer_data: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The data that automatically creates a Transfer after the payment finalizes.',
                  },
                  transfer_group: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A string that identifies the resulting payment as part of a group.',
                  },
                },
                description:
                  'A PaymentIntent guides you through the process of collecting a payment from your customer.',
              },
              payment_method: {
                type: 'object',
                properties: {
                  acss_debit: {
                    type: 'object',
                  },
                  affirm: {
                    type: 'object',
                  },
                  afterpay_clearpay: {
                    type: 'object',
                  },
                  alipay: {
                    type: 'object',
                  },
                  allow_redisplay: {
                    type: 'string',
                    description:
                      'This field indicates whether this payment method can be shown again to its customer in a checkout flow. One of: always, limited, unspecified.',
                  },
                  alma: {
                    type: 'object',
                  },
                  amazon_pay: {
                    type: 'object',
                  },
                  au_becs_debit: {
                    type: 'object',
                  },
                  bacs_debit: {
                    type: 'object',
                  },
                  bancontact: {
                    type: 'object',
                  },
                  billie: {
                    type: 'object',
                  },
                  billing_details: {
                    type: 'object',
                  },
                  bizum: {
                    type: 'object',
                  },
                  blik: {
                    type: 'object',
                  },
                  boleto: {
                    type: 'object',
                  },
                  card: {
                    type: 'object',
                  },
                  card_present: {
                    type: 'object',
                  },
                  cashapp: {
                    type: 'object',
                  },
                  created: {
                    type: 'integer',
                    format: 'unix-time',
                    description: 'Time at which the object was created.',
                  },
                  crypto: {
                    type: 'object',
                  },
                  custom: {
                    type: 'object',
                  },
                  customer: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['customer'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The ID of the Customer to which this PaymentMethod is saved.',
                  },
                  customer_account: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                  },
                  customer_balance: {
                    type: 'object',
                  },
                  eps: {
                    type: 'object',
                  },
                  fpx: {
                    type: 'object',
                  },
                  giropay: {
                    type: 'object',
                  },
                  grabpay: {
                    type: 'object',
                  },
                  id: {
                    type: 'string',
                    description: 'Unique identifier for the object.',
                  },
                  ideal: {
                    type: 'object',
                  },
                  interac_present: {
                    type: 'object',
                  },
                  kakao_pay: {
                    type: 'object',
                  },
                  klarna: {
                    type: 'object',
                  },
                  konbini: {
                    type: 'object',
                  },
                  kr_card: {
                    type: 'object',
                  },
                  link: {
                    type: 'object',
                  },
                  livemode: {
                    type: 'boolean',
                    description: 'If the object exists in live mode, the value is `true`.',
                  },
                  mb_way: {
                    type: 'object',
                  },
                  metadata: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Set of key-value pairs that you can attach to an object.',
                  },
                  mobilepay: {
                    type: 'object',
                  },
                  multibanco: {
                    type: 'object',
                  },
                  naver_pay: {
                    type: 'object',
                  },
                  nz_bank_account: {
                    type: 'object',
                  },
                  object: {
                    type: 'string',
                    description: "String representing the object's type. One of: payment_method.",
                  },
                  oxxo: {
                    type: 'object',
                  },
                  p24: {
                    type: 'object',
                  },
                  pay_by_bank: {
                    type: 'object',
                  },
                  payco: {
                    type: 'object',
                  },
                  paynow: {
                    type: 'object',
                  },
                  paypal: {
                    type: 'object',
                  },
                  payto: {
                    type: 'object',
                  },
                  pix: {
                    type: 'object',
                  },
                  promptpay: {
                    type: 'object',
                  },
                  radar_options: {
                    type: 'object',
                    description: 'Options to configure Radar.',
                  },
                  revolut_pay: {
                    type: 'object',
                  },
                  samsung_pay: {
                    type: 'object',
                  },
                  satispay: {
                    type: 'object',
                  },
                  scalapay: {
                    type: 'object',
                  },
                  sepa_debit: {
                    type: 'object',
                  },
                  sofort: {
                    type: 'object',
                  },
                  sunbit: {
                    type: 'object',
                  },
                  swish: {
                    type: 'object',
                  },
                  twint: {
                    type: 'object',
                  },
                  type: {
                    type: 'string',
                    description: 'The type of the PaymentMethod.',
                  },
                  upi: {
                    type: 'object',
                  },
                  us_bank_account: {
                    type: 'object',
                  },
                  wechat_pay: {
                    type: 'object',
                  },
                  zip: {
                    type: 'object',
                  },
                },
                description: "PaymentMethod objects represent your customer's payment instruments.",
              },
              payment_method_type: {
                type: 'string',
                description:
                  'If the error is specific to the type of payment method, the payment method type that had a problem.',
              },
              request_log_url: {
                type: 'string',
                description: 'A URL to the request log entry in your dashboard.',
              },
              setup_intent: {
                type: 'object',
                properties: {
                  allowed_payment_method_types: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The list of payment method types to allow for this SetupIntent.',
                  },
                  application: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['application'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the Connect application that created the SetupIntent.',
                  },
                  attach_to_self: {
                    type: 'boolean',
                    description:
                      "If present, the SetupIntent's payment method will be attached to the in-context Stripe Account.",
                  },
                  automatic_payment_methods: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Settings for dynamic payment methods compatible with this Setup Intent',
                  },
                  cancellation_reason: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Reason for cancellation of this SetupIntent, one of `abandoned`, `requested_by_customer`, or `duplicate`. One of: abandoned, duplicate, requested_by_customer.',
                  },
                  client_secret: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The client secret of this SetupIntent.',
                  },
                  created: {
                    type: 'integer',
                    format: 'unix-time',
                    description: 'Time at which the object was created.',
                  },
                  customer: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the Customer this SetupIntent belongs to, if one exists.',
                  },
                  customer_account: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the Account this SetupIntent belongs to, if one exists.',
                  },
                  description: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'An arbitrary string attached to the object.',
                  },
                  excluded_payment_method_types: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Payment method types that are excluded from this SetupIntent.',
                  },
                  flow_directions: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                          description: 'One of: inbound, outbound.',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Indicates the directions of money movement for which this payment method is intended to be used.',
                  },
                  id: {
                    type: 'string',
                    description: 'Unique identifier for the object.',
                  },
                  last_setup_error: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The error encountered in the previous SetupIntent confirmation.',
                  },
                  latest_attempt: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['setup_attempt'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The most recent SetupAttempt for this SetupIntent.',
                  },
                  livemode: {
                    type: 'boolean',
                    description: 'If the object exists in live mode, the value is `true`.',
                  },
                  managed_payments: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                  },
                  mandate: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['mandate'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the multi use Mandate generated by the SetupIntent.',
                  },
                  metadata: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Set of key-value pairs that you can attach to an object.',
                  },
                  next_action: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If present, this property tells you what actions you need to take in order for your customer to continue payment setup.',
                  },
                  object: {
                    type: 'string',
                    description: "String representing the object's type. One of: setup_intent.",
                  },
                  on_behalf_of: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['account'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The account (if any) for which the setup is intended.',
                  },
                  payment_method: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['payment_method'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the payment method used with this SetupIntent.',
                  },
                  payment_method_configuration_details: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Information about the payment method configuration used for this Setup Intent.',
                  },
                  payment_method_options: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Payment method-specific configuration for this SetupIntent.',
                  },
                  payment_method_types: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    description: 'The list of payment method types (e.g.',
                  },
                  single_use_mandate: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['mandate'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the single_use Mandate generated by the SetupIntent.',
                  },
                  status: {
                    type: 'string',
                    description:
                      'Status of this SetupIntent, one of `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, `canceled`, or `succeeded`. One of: canceled, processing, requires_action, requires_confirmation, requires_payment_method, succeeded.',
                  },
                  usage: {
                    type: 'string',
                    description: 'Indicates how the payment method is intended to be used in the future.',
                  },
                },
                description:
                  "A SetupIntent guides you through the process of setting up and saving a customer's payment credentials for future payments.",
              },
              source: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      account: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['account'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The account this bank account belongs to.',
                      },
                      account_holder_name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The name of the person or business that owns the bank account.',
                      },
                      account_holder_type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The type of entity that holds the account.',
                      },
                      account_type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The bank account type.',
                      },
                      available_payout_methods: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'string',
                              description: 'One of: instant, standard.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A set of available payout methods for this bank account.',
                      },
                      bank_name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Name of the bank associated with the routing number (e.g., `WELLS FARGO`).',
                      },
                      country: {
                        type: 'string',
                        description: 'Two-letter ISO code representing the country the bank account is located in.',
                      },
                      currency: {
                        type: 'string',
                        description: 'Three-letter ISO code for the currency paid out to the bank account.',
                      },
                      customer: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The ID of the customer that the bank account is associated with.',
                      },
                      default_for_currency: {
                        anyOf: [
                          {
                            type: 'boolean',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Whether this bank account is the default external account for its currency.',
                      },
                      fingerprint: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Uniquely identifies this particular bank account.',
                      },
                      future_requirements: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Information about the upcoming new requirements for the bank account, including what information needs to be collected, and by when.',
                      },
                      id: {
                        type: 'string',
                        description: 'Unique identifier for the object.',
                      },
                      last4: {
                        type: 'string',
                        description: 'The last four digits of the bank account number.',
                      },
                      metadata: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Set of key-value pairs that you can attach to an object.',
                      },
                      object: {
                        type: 'string',
                        description: "String representing the object's type. One of: bank_account.",
                      },
                      requirements: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Information about the requirements for the bank account, including what information needs to be collected.',
                      },
                      routing_number: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The routing transit number for the bank account.',
                      },
                      status: {
                        type: 'string',
                        description:
                          'For bank accounts, possible values are `new`, `validated`, `verified`, `verification_failed`, `tokenized_account_number_deactivated` or `errored`.',
                      },
                    },
                    description: 'These bank accounts are payment methods on `Customer` objects.',
                  },
                  {
                    type: 'object',
                    properties: {
                      account: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['account'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                      },
                      address_city: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'City/District/Suburb/Town/Village.',
                      },
                      address_country: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Billing address country, if provided when creating card.',
                      },
                      address_line1: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Address line 1 (Street address/PO Box/Company name).',
                      },
                      address_line1_check: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'If `address_line1` was provided, results of the check: `pass`, `fail`, `unavailable`, or `unchecked`.',
                      },
                      address_line2: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Address line 2 (Apartment/Suite/Unit/Building).',
                      },
                      address_state: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'State/County/Province/Region.',
                      },
                      address_zip: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'ZIP or postal code.',
                      },
                      address_zip_check: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'If `address_zip` was provided, results of the check: `pass`, `fail`, `unavailable`, or `unchecked`.',
                      },
                      allow_redisplay: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This field indicates whether this payment method can be shown again to its customer in a checkout flow. One of: always, limited, unspecified.',
                      },
                      available_payout_methods: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'string',
                              description: 'One of: instant, standard.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A set of available payout methods for this card.',
                      },
                      brand: {
                        type: 'string',
                        description: 'Card brand.',
                      },
                      country: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Two-letter ISO code representing the country of the card.',
                      },
                      currency: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Three-letter ISO code for currency in lowercase.',
                      },
                      customer: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The customer that this card belongs to.',
                      },
                      cvc_check: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'If a CVC was provided, results of the check: `pass`, `fail`, `unavailable`, or `unchecked`.',
                      },
                      default_for_currency: {
                        anyOf: [
                          {
                            type: 'boolean',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Whether this card is the default external account for its currency.',
                      },
                      dynamic_last4: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: '(For tokenized numbers only.) The last four digits of the device account number.',
                      },
                      exp_month: {
                        type: 'integer',
                        description: "Two-digit number representing the card's expiration month.",
                      },
                      exp_year: {
                        type: 'integer',
                        description: "Four-digit number representing the card's expiration year.",
                      },
                      fingerprint: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Uniquely identifies this particular card number.',
                      },
                      funding: {
                        type: 'string',
                        description: 'Card funding type.',
                      },
                      id: {
                        type: 'string',
                        description: 'Unique identifier for the object.',
                      },
                      last4: {
                        type: 'string',
                        description: 'The last four digits of the card.',
                      },
                      metadata: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Set of key-value pairs that you can attach to an object.',
                      },
                      name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Cardholder name.',
                      },
                      networks: {
                        type: 'object',
                      },
                      object: {
                        type: 'string',
                        description: "String representing the object's type. One of: card.",
                      },
                      regulated_status: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Status of a card based on the card issuer. One of: regulated, unregulated.',
                      },
                      status: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'For external accounts that are cards, possible values are `new` and `errored`.',
                      },
                      tokenization_method: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'If the card number is tokenized, this is the method that was used.',
                      },
                    },
                    description: 'You can store multiple cards on a customer in order to charge the customer later.',
                  },
                  {
                    type: 'object',
                    properties: {
                      ach_credit_transfer: {
                        type: 'object',
                      },
                      ach_debit: {
                        type: 'object',
                      },
                      acss_debit: {
                        type: 'object',
                      },
                      alipay: {
                        type: 'object',
                      },
                      allow_redisplay: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This field indicates whether this payment method can be shown again to its customer in a checkout flow. One of: always, limited, unspecified.',
                      },
                      amount: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'A positive integer in the smallest currency unit (that is, 100 cents for $1.00, or 1 for ¥1, Japanese Yen being a zero-decimal currency) representing the total amount associated with the source.',
                      },
                      au_becs_debit: {
                        type: 'object',
                      },
                      bancontact: {
                        type: 'object',
                      },
                      card: {
                        type: 'object',
                      },
                      card_present: {
                        type: 'object',
                      },
                      client_secret: {
                        type: 'string',
                        description: 'The client secret of the source.',
                      },
                      code_verification: {
                        type: 'object',
                      },
                      created: {
                        type: 'integer',
                        format: 'unix-time',
                        description: 'Time at which the object was created.',
                      },
                      currency: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Three-letter ISO code for the currency associated with the source.',
                      },
                      customer: {
                        type: 'string',
                        description: 'The ID of the customer to which this source is attached.',
                      },
                      eps: {
                        type: 'object',
                      },
                      flow: {
                        type: 'string',
                        description: 'The authentication `flow` of the source.',
                      },
                      giropay: {
                        type: 'object',
                      },
                      id: {
                        type: 'string',
                        description: 'Unique identifier for the object.',
                      },
                      ideal: {
                        type: 'object',
                      },
                      klarna: {
                        type: 'object',
                      },
                      livemode: {
                        type: 'boolean',
                        description: 'If the object exists in live mode, the value is `true`.',
                      },
                      metadata: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Set of key-value pairs that you can attach to an object.',
                      },
                      multibanco: {
                        type: 'object',
                      },
                      object: {
                        type: 'string',
                        description: "String representing the object's type. One of: source.",
                      },
                      owner: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Information about the owner of the payment instrument that may be used or required by particular source types.',
                      },
                      p24: {
                        type: 'object',
                      },
                      receiver: {
                        type: 'object',
                      },
                      redirect: {
                        type: 'object',
                      },
                      sepa_debit: {
                        type: 'object',
                      },
                      sofort: {
                        type: 'object',
                      },
                      source_order: {
                        type: 'object',
                      },
                      statement_descriptor: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Extra information about a source.',
                      },
                      status: {
                        type: 'string',
                        description:
                          'The status of the source, one of `canceled`, `chargeable`, `consumed`, `failed`, or `pending`.',
                      },
                      three_d_secure: {
                        type: 'object',
                      },
                      type: {
                        type: 'string',
                        description: 'The `type` of the source.',
                      },
                      usage: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Either `reusable` or `single_use`.',
                      },
                      wechat: {
                        type: 'object',
                      },
                    },
                    description: '`Source` objects allow you to accept a variety of payment methods.',
                  },
                ],
                description: 'The source object for errors returned on a request involving a source.',
              },
              type: {
                type: 'string',
                description:
                  'The type of error returned. One of: api_error, card_error, idempotency_error, invalid_request_error.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The error encountered during the previous attempt to finalize the invoice.',
      },
      latest_revision: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['invoice'],
          },
          {
            type: 'null',
          },
        ],
        description: 'The ID of the most recent non-draft revision of this invoice',
      },
      lines: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                amount: {
                  type: 'integer',
                  description: 'The amount, in cents (or local equivalent).',
                },
                currency: {
                  type: 'string',
                  description: 'Three-letter ISO currency code, in lowercase.',
                },
                description: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'An arbitrary string attached to the object.',
                },
                discount_amounts: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The amount of discount calculated per discount for this line item.',
                },
                discountable: {
                  type: 'boolean',
                  description: 'If true, discounts will apply to this line item.',
                },
                discounts: {
                  type: 'array',
                  items: {
                    type: 'string',
                    'x-stripe-expandable-resources': ['discount'],
                  },
                  description: 'The discounts applied to the invoice line item.',
                },
                id: {
                  type: 'string',
                  description: 'Unique identifier for the object.',
                },
                invoice: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The ID of the invoice that contains this line item.',
                },
                livemode: {
                  type: 'boolean',
                  description: 'If the object exists in live mode, the value is `true`.',
                },
                metadata: {
                  type: 'object',
                  description: 'Set of key-value pairs that you can attach to an object.',
                },
                object: {
                  type: 'string',
                  description: "String representing the object's type. One of: line_item.",
                },
                parent: {
                  anyOf: [
                    {
                      type: 'object',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The parent that generated this line item.',
                },
                period: {
                  type: 'object',
                },
                pretax_credit_amounts: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'Contains pretax credit amounts (ex: discount, credit grants, etc) that apply to this line item.',
                },
                pricing: {
                  anyOf: [
                    {
                      type: 'object',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The pricing information of the line item.',
                },
                quantity: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'Quantity of units for the invoice line item in integer format, with any decimal precision truncated.',
                },
                quantity_decimal: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Non-negative decimal with at most 12 decimal places.',
                },
                subscription: {
                  anyOf: [
                    {
                      type: 'string',
                      'x-stripe-expandable-resources': ['subscription'],
                    },
                    {
                      type: 'null',
                    },
                  ],
                },
                subtotal: {
                  type: 'integer',
                  description:
                    'The subtotal of the line item, in cents (or local equivalent), before any discounts or taxes.',
                },
                taxes: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The tax information of the line item.',
                },
              },
              description:
                'Invoice Line Items represent the individual lines within an invoice and only exist within the context of an invoice.',
            },
            description: 'Details about each object.',
          },
          has_more: {
            type: 'boolean',
            description: 'True if this list has another page of items after this one that can be fetched.',
          },
          object: {
            type: 'string',
            description: "String representing the object's type. One of: list.",
          },
          url: {
            type: 'string',
            description: 'The URL where this list can be accessed.',
          },
        },
        description: 'The individual line items that make up the invoice.',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      metadata: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      next_payment_attempt: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'The time at which payment will next be attempted.',
      },
      number: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A unique, identifying string that appears on emails sent to the customer for this invoice.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: invoice.",
      },
      on_behalf_of: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['account'],
          },
          {
            type: 'null',
          },
        ],
        description: 'The account (if any) for which the funds of the invoice payment are intended.',
      },
      parent: {
        anyOf: [
          {
            type: 'object',
            properties: {
              quote_details: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      quote: {
                        type: 'string',
                        description: 'The quote that generated this invoice',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Details about the quote that generated this invoice',
              },
              subscription_details: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      metadata: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Set of key-value pairs defined as subscription metadata when an invoice is created.',
                      },
                      subscription: {
                        type: 'string',
                        'x-stripe-expandable-resources': ['subscription'],
                        description: 'The subscription that generated this invoice',
                      },
                      subscription_proration_date: {
                        type: 'integer',
                        format: 'unix-time',
                        description: 'Only set for upcoming invoices that preview prorations.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Details about the subscription that generated this invoice',
              },
              type: {
                type: 'string',
                description:
                  'The type of parent that generated this invoice One of: quote_details, subscription_details.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The parent that generated this invoice',
      },
      payment_settings: {
        type: 'object',
        properties: {
          default_mandate: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'ID of the mandate to be used for this invoice.',
          },
          payment_method_options: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  acss_debit: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `acss_debit`, this sub-hash contains details about the Canadian pre-authorized debit payment method options to pass to the invoice’s PaymentIntent.',
                  },
                  bancontact: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `bancontact`, this sub-hash contains details about the Bancontact payment method options to pass to the invoice’s PaymentIntent.',
                  },
                  card: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `card`, this sub-hash contains details about the Card payment method options to pass to the invoice’s PaymentIntent.',
                  },
                  customer_balance: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `customer_balance`, this sub-hash contains details about the Bank transfer payment method options to pass to the invoice’s PaymentIntent.',
                  },
                  konbini: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `konbini`, this sub-hash contains details about the Konbini payment method options to pass to the invoice’s PaymentIntent.',
                  },
                  payto: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `payto`, this sub-hash contains details about the PayTo payment method options to pass to the invoice’s PaymentIntent.',
                  },
                  pix: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `pix`, this sub-hash contains details about the Pix payment method options to pass to the invoice’s PaymentIntent.',
                  },
                  sepa_debit: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `sepa_debit`, this sub-hash contains details about the SEPA Direct Debit payment method options to pass to the invoice’s PaymentIntent.',
                  },
                  upi: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `upi`, this sub-hash contains details about the UPI payment method options to pass to the invoice’s PaymentIntent.',
                  },
                  us_bank_account: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If paying by `us_bank_account`, this sub-hash contains details about the ACH direct debit payment method options to pass to the invoice’s PaymentIntent.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Payment-method-specific configuration to provide to the invoice’s PaymentIntent.',
          },
          payment_method_types: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The list of payment method types (e.g.',
          },
        },
      },
      period_end: {
        type: 'integer',
        format: 'unix-time',
        description: 'The latest timestamp at which invoice items can be associated with this invoice.',
      },
      period_start: {
        type: 'integer',
        format: 'unix-time',
        description: 'The earliest timestamp at which invoice items can be associated with this invoice.',
      },
      post_payment_credit_notes_amount: {
        type: 'integer',
        description: 'Total amount of all post-payment credit notes issued for this invoice.',
      },
      pre_payment_credit_notes_amount: {
        type: 'integer',
        description: 'Total amount of all pre-payment credit notes issued for this invoice.',
      },
      receipt_number: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'This is the transaction number that appears on email receipts sent for this invoice.',
      },
      rendering: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount_tax_display: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'How line-item prices and amounts will be displayed with respect to tax on invoice PDFs.',
              },
              pdf: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      page_size: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Page size of invoice pdf. One of: a4, auto, letter.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Invoice pdf rendering options',
              },
              template: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'ID of the rendering template that the invoice is formatted by.',
              },
              template_version: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Version of the rendering template that the invoice is using.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'The rendering-related settings that control how the invoice is displayed on customer-facing surfaces such as PDF and Hosted Invoice Page.',
      },
      shipping_cost: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount_subtotal: {
                type: 'integer',
                description: 'Total shipping cost before any taxes are applied.',
              },
              amount_tax: {
                type: 'integer',
                description: 'Total tax amount applied due to shipping costs.',
              },
              amount_total: {
                type: 'integer',
                description: 'Total shipping cost after taxes are applied.',
              },
              shipping_rate: {
                anyOf: [
                  {
                    type: 'string',
                    'x-stripe-expandable-resources': ['shipping_rate'],
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the ShippingRate for this invoice.',
              },
              taxes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    amount: {
                      type: 'integer',
                      description: 'Amount of tax applied for this rate.',
                    },
                    rate: {
                      type: 'object',
                      description:
                        'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
                    },
                    taxability_reason: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The reasoning behind this tax, for example, if the product is tax exempt. One of: customer_exempt, not_collecting, not_subject_to_tax, not_supported, portion_product_exempt, portion_reduced_rated, portion_standard_rated, product_exempt, product_exempt_holiday, proportionally_rated, reduced_rated, reverse_charge, standard_rated, taxable_basis_reduced, zero_rated.',
                    },
                    taxable_amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The amount on which tax is calculated, in cents (or local equivalent).',
                    },
                  },
                },
                description: 'The taxes applied to the shipping rate.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The details of the cost of shipping, including the ShippingRate applied on the invoice.',
      },
      shipping_details: {
        anyOf: [
          {
            type: 'object',
            properties: {
              address: {
                type: 'object',
                properties: {
                  city: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'City, district, suburb, town, or village.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter country code (ISO 3166-1 alpha-2).',
                  },
                  line1: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 1, such as the street, PO Box, or company name.',
                  },
                  line2: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 2, such as the apartment, suite, unit, or building.',
                  },
                  postal_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ZIP or postal code.',
                  },
                  state: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'State, county, province, or region (ISO 3166-2).',
                  },
                },
              },
              carrier: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The delivery service that shipped a physical product, such as Fedex, UPS, USPS, etc.',
              },
              name: {
                type: 'string',
                description: 'Recipient name.',
              },
              phone: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Recipient phone (including extension).',
              },
              tracking_number: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The tracking number for a physical product, obtained from the delivery service.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Shipping details for the invoice.',
      },
      starting_balance: {
        type: 'integer',
        description: 'Starting customer balance before the invoice is finalized.',
      },
      statement_descriptor: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "Extra information about an invoice for the customer's credit card statement.",
      },
      status: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The status of the invoice, one of `draft`, `open`, `paid`, `uncollectible`, or `void`. One of: draft, open, paid, uncollectible, void.',
      },
      status_transitions: {
        type: 'object',
        properties: {
          finalized_at: {
            anyOf: [
              {
                type: 'integer',
                format: 'unix-time',
              },
              {
                type: 'null',
              },
            ],
            description: 'The time that the invoice draft was finalized.',
          },
          marked_uncollectible_at: {
            anyOf: [
              {
                type: 'integer',
                format: 'unix-time',
              },
              {
                type: 'null',
              },
            ],
            description: 'The time that the invoice was marked uncollectible.',
          },
          paid_at: {
            anyOf: [
              {
                type: 'integer',
                format: 'unix-time',
              },
              {
                type: 'null',
              },
            ],
            description: 'The time that the invoice was paid.',
          },
          voided_at: {
            anyOf: [
              {
                type: 'integer',
                format: 'unix-time',
              },
              {
                type: 'null',
              },
            ],
            description: 'The time that the invoice was voided.',
          },
        },
      },
      subtotal: {
        type: 'integer',
        description:
          'Total of all subscriptions, invoice items, and prorations on the invoice before any invoice level discount or exclusive tax is applied.',
      },
      subtotal_excluding_tax: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The integer amount in cents (or local equivalent) representing the subtotal of the invoice before any invoice level discount or tax is applied.',
      },
      test_clock: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['test_helpers.test_clock'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the test clock this invoice belongs to.',
      },
      threshold_reason: {
        type: 'object',
        properties: {
          amount_gte: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The total invoice amount threshold boundary if it triggered the threshold invoice.',
          },
          item_reasons: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                line_item_ids: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description: 'The IDs of the line items that triggered the threshold invoice.',
                },
                usage_gte: {
                  type: 'integer',
                  description: 'The quantity threshold boundary that applied to the given line item.',
                },
              },
            },
            description: 'Indicates which line items triggered a threshold invoice.',
          },
        },
      },
      total: {
        type: 'integer',
        description: 'Total after discounts and taxes.',
      },
      total_discount_amounts: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                amount: {
                  type: 'integer',
                  description: 'The amount, in cents (or local equivalent), of the discount.',
                },
                discount: {
                  type: 'string',
                  'x-stripe-expandable-resources': ['discount', 'deleted_discount'],
                  description: 'The discount that was applied to get this discount amount.',
                },
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The aggregate amounts calculated per discount across all line items.',
      },
      total_excluding_tax: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The integer amount in cents (or local equivalent) representing the total amount of the invoice including all discounts but excluding all tax.',
      },
      total_pretax_credit_amounts: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                amount: {
                  type: 'integer',
                  description: 'The amount, in cents (or local equivalent), of the pretax credit amount.',
                },
                credit_balance_transaction: {
                  anyOf: [
                    {
                      type: 'string',
                      'x-stripe-expandable-resources': ['billing.credit_balance_transaction'],
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The credit balance transaction that was applied to get this pretax credit amount.',
                },
                discount: {
                  type: 'string',
                  'x-stripe-expandable-resources': ['discount', 'deleted_discount'],
                  description: 'The discount that was applied to get this pretax credit amount.',
                },
                type: {
                  type: 'string',
                  description:
                    'Type of the pretax credit amount referenced. One of: credit_balance_transaction, discount.',
                },
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Contains pretax credit amounts (ex: discount, credit grants, etc) that apply to this invoice.',
      },
      total_taxes: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                amount: {
                  type: 'integer',
                  description: 'The amount of the tax, in cents (or local equivalent).',
                },
                tax_behavior: {
                  type: 'string',
                  description: 'Whether this tax is inclusive or exclusive. One of: exclusive, inclusive.',
                },
                tax_rate_details: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        tax_rate: {
                          type: 'string',
                          'x-stripe-expandable-resources': ['tax_rate'],
                          description: 'ID of the tax rate',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Additional details about the tax rate.',
                },
                taxability_reason: {
                  type: 'string',
                  description: 'The reasoning behind this tax, for example, if the product is tax exempt.',
                },
                taxable_amount: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The amount on which tax is calculated, in cents (or local equivalent).',
                },
                type: {
                  type: 'string',
                  description: 'The type of tax information. One of: tax_rate_details.',
                },
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The aggregate tax information of all line items.',
      },
      webhooks_delivered_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Invoices are automatically paid or sent 1 hour after webhooks are delivered, or until all webhook delivery attempts have been exhausted.',
      },
    },
    description:
      'Invoices are statements of amounts owed by a customer, and are either generated one-off, or generated periodically from a subscription.',
  },
  payment_intent: {
    type: 'object',
    properties: {
      allowed_payment_method_types: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The list of payment method types allowed for use with this payment.',
      },
      amount: {
        type: 'integer',
        description: 'Amount intended to be collected by this PaymentIntent.',
      },
      amount_capturable: {
        type: 'integer',
        description: 'Amount that can be captured from this PaymentIntent.',
      },
      amount_details: {
        anyOf: [
          {
            type: 'object',
            properties: {
              discount_amount: {
                type: 'integer',
                description: 'The total discount applied on the transaction represented in the smallest currency unit.',
              },
              error: {
                type: 'object',
                properties: {
                  code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The code of the error that occurred when validating the current amount details. One of: amount_details_amount_mismatch, amount_details_tax_shipping_discount_greater_than_amount.',
                  },
                  message: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A message providing more details about the error.',
                  },
                },
              },
              line_items: {
                type: 'object',
                properties: {
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                    },
                    description: 'Details about each object.',
                  },
                  has_more: {
                    type: 'boolean',
                    description: 'True if this list has another page of items after this one that can be fetched.',
                  },
                  object: {
                    type: 'string',
                    description: "String representing the object's type. One of: list.",
                  },
                  url: {
                    type: 'string',
                    description: 'The URL where this list can be accessed.',
                  },
                },
                description: 'A list of line items, each containing information about a product in the PaymentIntent.',
              },
              shipping: {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If a physical good is being shipped, the cost of shipping represented in the smallest currency unit.',
                  },
                  from_postal_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If a physical good is being shipped, the postal code of where it is being shipped from.',
                  },
                  to_postal_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If a physical good is being shipped, the postal code of where it is being shipped to.',
                  },
                },
              },
              tax: {
                type: 'object',
                properties: {
                  total_tax_amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The total amount of tax on the transaction represented in the smallest currency unit.',
                  },
                },
              },
              tip: {
                type: 'object',
                properties: {
                  amount: {
                    type: 'integer',
                    description: 'Portion of the amount that corresponds to a tip.',
                  },
                },
              },
            },
          },
          {
            type: 'object',
            properties: {
              tip: {
                type: 'object',
                properties: {
                  amount: {
                    type: 'integer',
                    description: 'Portion of the amount that corresponds to a tip.',
                  },
                },
              },
            },
          },
        ],
      },
      amount_received: {
        type: 'integer',
        description: 'Amount that this PaymentIntent collects.',
      },
      application: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['application'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the Connect application that created the PaymentIntent.',
      },
      application_fee_amount: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description:
          "The amount of the application fee (if any) that will be requested to be applied to the payment and transferred to the application owner's Stripe account.",
      },
      automatic_payment_methods: {
        anyOf: [
          {
            type: 'object',
            properties: {
              allow_redirects: {
                type: 'string',
                description:
                  'Controls whether this PaymentIntent will accept redirect-based payment methods. One of: always, never.',
              },
              enabled: {
                type: 'boolean',
                description: 'Automatically calculates compatible payment methods',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Settings to configure compatible payment methods from the Stripe Dashboard',
      },
      canceled_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'Populated when `status` is `canceled`, this is the time at which the PaymentIntent was canceled.',
      },
      cancellation_reason: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Reason for cancellation of this PaymentIntent, either user-provided (`duplicate`, `fraudulent`, `requested_by_customer`, or `abandoned`) or generated by Stripe internally (`failed_invoice`, `void_inv… One of: abandoned, automatic, duplicate, expired, failed_invoice, fraudulent, requested_by_customer, void_invoice.',
      },
      capture_method: {
        type: 'string',
        description:
          "Controls when the funds will be captured from the customer's account. One of: automatic, automatic_async, manual.",
      },
      client_secret: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The client secret of this PaymentIntent.',
      },
      confirmation_method: {
        type: 'string',
        description:
          'Describes whether we can confirm this PaymentIntent automatically, or if it requires customer action to confirm the payment. One of: automatic, manual.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code, in lowercase.',
      },
      customer: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the Customer this PaymentIntent belongs to, if one exists.',
      },
      customer_account: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the Account representing the customer that this PaymentIntent belongs to, if one exists.',
      },
      description: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'An arbitrary string attached to the object.',
      },
      excluded_payment_method_types: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The list of payment method types to exclude from use with this payment.',
      },
      hooks: {
        type: 'object',
        properties: {
          inputs: {
            type: 'object',
            properties: {
              tax: {
                type: 'object',
              },
            },
          },
        },
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      last_payment_error: {
        anyOf: [
          {
            type: 'object',
            properties: {
              advice_code: {
                type: 'string',
                description:
                  'For card errors resulting from a card issuer decline, a short string indicating how to proceed with an error if they provide one.',
              },
              charge: {
                type: 'string',
                description: 'For card errors, the ID of the failed charge.',
              },
              code: {
                type: 'string',
                description:
                  'For some errors that could be handled programmatically, a short string indicating the error code reported.',
              },
              decline_code: {
                type: 'string',
                description:
                  "For card errors resulting from a card issuer decline, a short string indicating the card issuer's reason for the decline if they provide one.",
              },
              doc_url: {
                type: 'string',
                description: 'A URL to more information about the error code reported.',
              },
              message: {
                type: 'string',
                description: 'A human-readable message providing more details about the error.',
              },
              network_advice_code: {
                type: 'string',
                description:
                  'For card errors resulting from a card issuer decline, a 2 digit code which indicates the advice given to merchant by the card network on how to proceed with an error.',
              },
              network_decline_code: {
                type: 'string',
                description:
                  'For payments declined by the network, an alphanumeric code which indicates the reason the payment failed.',
              },
              param: {
                type: 'string',
                description: 'If the error is parameter-specific, the parameter related to the error.',
              },
              payment_intent: {
                type: 'object',
                description:
                  'A PaymentIntent guides you through the process of collecting a payment from your customer.',
              },
              payment_method: {
                type: 'object',
                properties: {
                  acss_debit: {
                    type: 'object',
                  },
                  affirm: {
                    type: 'object',
                  },
                  afterpay_clearpay: {
                    type: 'object',
                  },
                  alipay: {
                    type: 'object',
                  },
                  allow_redisplay: {
                    type: 'string',
                    description:
                      'This field indicates whether this payment method can be shown again to its customer in a checkout flow. One of: always, limited, unspecified.',
                  },
                  alma: {
                    type: 'object',
                  },
                  amazon_pay: {
                    type: 'object',
                  },
                  au_becs_debit: {
                    type: 'object',
                  },
                  bacs_debit: {
                    type: 'object',
                  },
                  bancontact: {
                    type: 'object',
                  },
                  billie: {
                    type: 'object',
                  },
                  billing_details: {
                    type: 'object',
                  },
                  bizum: {
                    type: 'object',
                  },
                  blik: {
                    type: 'object',
                  },
                  boleto: {
                    type: 'object',
                  },
                  card: {
                    type: 'object',
                  },
                  card_present: {
                    type: 'object',
                  },
                  cashapp: {
                    type: 'object',
                  },
                  created: {
                    type: 'integer',
                    format: 'unix-time',
                    description: 'Time at which the object was created.',
                  },
                  crypto: {
                    type: 'object',
                  },
                  custom: {
                    type: 'object',
                  },
                  customer: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['customer'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The ID of the Customer to which this PaymentMethod is saved.',
                  },
                  customer_account: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                  },
                  customer_balance: {
                    type: 'object',
                  },
                  eps: {
                    type: 'object',
                  },
                  fpx: {
                    type: 'object',
                  },
                  giropay: {
                    type: 'object',
                  },
                  grabpay: {
                    type: 'object',
                  },
                  id: {
                    type: 'string',
                    description: 'Unique identifier for the object.',
                  },
                  ideal: {
                    type: 'object',
                  },
                  interac_present: {
                    type: 'object',
                  },
                  kakao_pay: {
                    type: 'object',
                  },
                  klarna: {
                    type: 'object',
                  },
                  konbini: {
                    type: 'object',
                  },
                  kr_card: {
                    type: 'object',
                  },
                  link: {
                    type: 'object',
                  },
                  livemode: {
                    type: 'boolean',
                    description: 'If the object exists in live mode, the value is `true`.',
                  },
                  mb_way: {
                    type: 'object',
                  },
                  metadata: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Set of key-value pairs that you can attach to an object.',
                  },
                  mobilepay: {
                    type: 'object',
                  },
                  multibanco: {
                    type: 'object',
                  },
                  naver_pay: {
                    type: 'object',
                  },
                  nz_bank_account: {
                    type: 'object',
                  },
                  object: {
                    type: 'string',
                    description: "String representing the object's type. One of: payment_method.",
                  },
                  oxxo: {
                    type: 'object',
                  },
                  p24: {
                    type: 'object',
                  },
                  pay_by_bank: {
                    type: 'object',
                  },
                  payco: {
                    type: 'object',
                  },
                  paynow: {
                    type: 'object',
                  },
                  paypal: {
                    type: 'object',
                  },
                  payto: {
                    type: 'object',
                  },
                  pix: {
                    type: 'object',
                  },
                  promptpay: {
                    type: 'object',
                  },
                  radar_options: {
                    type: 'object',
                    description: 'Options to configure Radar.',
                  },
                  revolut_pay: {
                    type: 'object',
                  },
                  samsung_pay: {
                    type: 'object',
                  },
                  satispay: {
                    type: 'object',
                  },
                  scalapay: {
                    type: 'object',
                  },
                  sepa_debit: {
                    type: 'object',
                  },
                  sofort: {
                    type: 'object',
                  },
                  sunbit: {
                    type: 'object',
                  },
                  swish: {
                    type: 'object',
                  },
                  twint: {
                    type: 'object',
                  },
                  type: {
                    type: 'string',
                    description: 'The type of the PaymentMethod.',
                  },
                  upi: {
                    type: 'object',
                  },
                  us_bank_account: {
                    type: 'object',
                  },
                  wechat_pay: {
                    type: 'object',
                  },
                  zip: {
                    type: 'object',
                  },
                },
                description: "PaymentMethod objects represent your customer's payment instruments.",
              },
              payment_method_type: {
                type: 'string',
                description:
                  'If the error is specific to the type of payment method, the payment method type that had a problem.',
              },
              request_log_url: {
                type: 'string',
                description: 'A URL to the request log entry in your dashboard.',
              },
              setup_intent: {
                type: 'object',
                properties: {
                  allowed_payment_method_types: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The list of payment method types to allow for this SetupIntent.',
                  },
                  application: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['application'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the Connect application that created the SetupIntent.',
                  },
                  attach_to_self: {
                    type: 'boolean',
                    description:
                      "If present, the SetupIntent's payment method will be attached to the in-context Stripe Account.",
                  },
                  automatic_payment_methods: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Settings for dynamic payment methods compatible with this Setup Intent',
                  },
                  cancellation_reason: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Reason for cancellation of this SetupIntent, one of `abandoned`, `requested_by_customer`, or `duplicate`. One of: abandoned, duplicate, requested_by_customer.',
                  },
                  client_secret: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The client secret of this SetupIntent.',
                  },
                  created: {
                    type: 'integer',
                    format: 'unix-time',
                    description: 'Time at which the object was created.',
                  },
                  customer: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the Customer this SetupIntent belongs to, if one exists.',
                  },
                  customer_account: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the Account this SetupIntent belongs to, if one exists.',
                  },
                  description: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'An arbitrary string attached to the object.',
                  },
                  excluded_payment_method_types: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Payment method types that are excluded from this SetupIntent.',
                  },
                  flow_directions: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                          description: 'One of: inbound, outbound.',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Indicates the directions of money movement for which this payment method is intended to be used.',
                  },
                  id: {
                    type: 'string',
                    description: 'Unique identifier for the object.',
                  },
                  last_setup_error: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The error encountered in the previous SetupIntent confirmation.',
                  },
                  latest_attempt: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['setup_attempt'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The most recent SetupAttempt for this SetupIntent.',
                  },
                  livemode: {
                    type: 'boolean',
                    description: 'If the object exists in live mode, the value is `true`.',
                  },
                  managed_payments: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                  },
                  mandate: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['mandate'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the multi use Mandate generated by the SetupIntent.',
                  },
                  metadata: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Set of key-value pairs that you can attach to an object.',
                  },
                  next_action: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If present, this property tells you what actions you need to take in order for your customer to continue payment setup.',
                  },
                  object: {
                    type: 'string',
                    description: "String representing the object's type. One of: setup_intent.",
                  },
                  on_behalf_of: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['account'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The account (if any) for which the setup is intended.',
                  },
                  payment_method: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['payment_method'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the payment method used with this SetupIntent.',
                  },
                  payment_method_configuration_details: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Information about the payment method configuration used for this Setup Intent.',
                  },
                  payment_method_options: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Payment method-specific configuration for this SetupIntent.',
                  },
                  payment_method_types: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    description: 'The list of payment method types (e.g.',
                  },
                  single_use_mandate: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['mandate'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the single_use Mandate generated by the SetupIntent.',
                  },
                  status: {
                    type: 'string',
                    description:
                      'Status of this SetupIntent, one of `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, `canceled`, or `succeeded`. One of: canceled, processing, requires_action, requires_confirmation, requires_payment_method, succeeded.',
                  },
                  usage: {
                    type: 'string',
                    description: 'Indicates how the payment method is intended to be used in the future.',
                  },
                },
                description:
                  "A SetupIntent guides you through the process of setting up and saving a customer's payment credentials for future payments.",
              },
              source: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      account: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['account'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The account this bank account belongs to.',
                      },
                      account_holder_name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The name of the person or business that owns the bank account.',
                      },
                      account_holder_type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The type of entity that holds the account.',
                      },
                      account_type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The bank account type.',
                      },
                      available_payout_methods: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'string',
                              description: 'One of: instant, standard.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A set of available payout methods for this bank account.',
                      },
                      bank_name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Name of the bank associated with the routing number (e.g., `WELLS FARGO`).',
                      },
                      country: {
                        type: 'string',
                        description: 'Two-letter ISO code representing the country the bank account is located in.',
                      },
                      currency: {
                        type: 'string',
                        description: 'Three-letter ISO code for the currency paid out to the bank account.',
                      },
                      customer: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The ID of the customer that the bank account is associated with.',
                      },
                      default_for_currency: {
                        anyOf: [
                          {
                            type: 'boolean',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Whether this bank account is the default external account for its currency.',
                      },
                      fingerprint: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Uniquely identifies this particular bank account.',
                      },
                      future_requirements: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Information about the upcoming new requirements for the bank account, including what information needs to be collected, and by when.',
                      },
                      id: {
                        type: 'string',
                        description: 'Unique identifier for the object.',
                      },
                      last4: {
                        type: 'string',
                        description: 'The last four digits of the bank account number.',
                      },
                      metadata: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Set of key-value pairs that you can attach to an object.',
                      },
                      object: {
                        type: 'string',
                        description: "String representing the object's type. One of: bank_account.",
                      },
                      requirements: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Information about the requirements for the bank account, including what information needs to be collected.',
                      },
                      routing_number: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The routing transit number for the bank account.',
                      },
                      status: {
                        type: 'string',
                        description:
                          'For bank accounts, possible values are `new`, `validated`, `verified`, `verification_failed`, `tokenized_account_number_deactivated` or `errored`.',
                      },
                    },
                    description: 'These bank accounts are payment methods on `Customer` objects.',
                  },
                  {
                    type: 'object',
                    properties: {
                      account: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['account'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                      },
                      address_city: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'City/District/Suburb/Town/Village.',
                      },
                      address_country: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Billing address country, if provided when creating card.',
                      },
                      address_line1: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Address line 1 (Street address/PO Box/Company name).',
                      },
                      address_line1_check: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'If `address_line1` was provided, results of the check: `pass`, `fail`, `unavailable`, or `unchecked`.',
                      },
                      address_line2: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Address line 2 (Apartment/Suite/Unit/Building).',
                      },
                      address_state: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'State/County/Province/Region.',
                      },
                      address_zip: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'ZIP or postal code.',
                      },
                      address_zip_check: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'If `address_zip` was provided, results of the check: `pass`, `fail`, `unavailable`, or `unchecked`.',
                      },
                      allow_redisplay: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This field indicates whether this payment method can be shown again to its customer in a checkout flow. One of: always, limited, unspecified.',
                      },
                      available_payout_methods: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'string',
                              description: 'One of: instant, standard.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A set of available payout methods for this card.',
                      },
                      brand: {
                        type: 'string',
                        description: 'Card brand.',
                      },
                      country: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Two-letter ISO code representing the country of the card.',
                      },
                      currency: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Three-letter ISO code for currency in lowercase.',
                      },
                      customer: {
                        anyOf: [
                          {
                            type: 'string',
                            'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The customer that this card belongs to.',
                      },
                      cvc_check: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'If a CVC was provided, results of the check: `pass`, `fail`, `unavailable`, or `unchecked`.',
                      },
                      default_for_currency: {
                        anyOf: [
                          {
                            type: 'boolean',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Whether this card is the default external account for its currency.',
                      },
                      dynamic_last4: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: '(For tokenized numbers only.) The last four digits of the device account number.',
                      },
                      exp_month: {
                        type: 'integer',
                        description: "Two-digit number representing the card's expiration month.",
                      },
                      exp_year: {
                        type: 'integer',
                        description: "Four-digit number representing the card's expiration year.",
                      },
                      fingerprint: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Uniquely identifies this particular card number.',
                      },
                      funding: {
                        type: 'string',
                        description: 'Card funding type.',
                      },
                      id: {
                        type: 'string',
                        description: 'Unique identifier for the object.',
                      },
                      last4: {
                        type: 'string',
                        description: 'The last four digits of the card.',
                      },
                      metadata: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Set of key-value pairs that you can attach to an object.',
                      },
                      name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Cardholder name.',
                      },
                      networks: {
                        type: 'object',
                      },
                      object: {
                        type: 'string',
                        description: "String representing the object's type. One of: card.",
                      },
                      regulated_status: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Status of a card based on the card issuer. One of: regulated, unregulated.',
                      },
                      status: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'For external accounts that are cards, possible values are `new` and `errored`.',
                      },
                      tokenization_method: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'If the card number is tokenized, this is the method that was used.',
                      },
                    },
                    description: 'You can store multiple cards on a customer in order to charge the customer later.',
                  },
                  {
                    type: 'object',
                    properties: {
                      ach_credit_transfer: {
                        type: 'object',
                      },
                      ach_debit: {
                        type: 'object',
                      },
                      acss_debit: {
                        type: 'object',
                      },
                      alipay: {
                        type: 'object',
                      },
                      allow_redisplay: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'This field indicates whether this payment method can be shown again to its customer in a checkout flow. One of: always, limited, unspecified.',
                      },
                      amount: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'A positive integer in the smallest currency unit (that is, 100 cents for $1.00, or 1 for ¥1, Japanese Yen being a zero-decimal currency) representing the total amount associated with the source.',
                      },
                      au_becs_debit: {
                        type: 'object',
                      },
                      bancontact: {
                        type: 'object',
                      },
                      card: {
                        type: 'object',
                      },
                      card_present: {
                        type: 'object',
                      },
                      client_secret: {
                        type: 'string',
                        description: 'The client secret of the source.',
                      },
                      code_verification: {
                        type: 'object',
                      },
                      created: {
                        type: 'integer',
                        format: 'unix-time',
                        description: 'Time at which the object was created.',
                      },
                      currency: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Three-letter ISO code for the currency associated with the source.',
                      },
                      customer: {
                        type: 'string',
                        description: 'The ID of the customer to which this source is attached.',
                      },
                      eps: {
                        type: 'object',
                      },
                      flow: {
                        type: 'string',
                        description: 'The authentication `flow` of the source.',
                      },
                      giropay: {
                        type: 'object',
                      },
                      id: {
                        type: 'string',
                        description: 'Unique identifier for the object.',
                      },
                      ideal: {
                        type: 'object',
                      },
                      klarna: {
                        type: 'object',
                      },
                      livemode: {
                        type: 'boolean',
                        description: 'If the object exists in live mode, the value is `true`.',
                      },
                      metadata: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Set of key-value pairs that you can attach to an object.',
                      },
                      multibanco: {
                        type: 'object',
                      },
                      object: {
                        type: 'string',
                        description: "String representing the object's type. One of: source.",
                      },
                      owner: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Information about the owner of the payment instrument that may be used or required by particular source types.',
                      },
                      p24: {
                        type: 'object',
                      },
                      receiver: {
                        type: 'object',
                      },
                      redirect: {
                        type: 'object',
                      },
                      sepa_debit: {
                        type: 'object',
                      },
                      sofort: {
                        type: 'object',
                      },
                      source_order: {
                        type: 'object',
                      },
                      statement_descriptor: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Extra information about a source.',
                      },
                      status: {
                        type: 'string',
                        description:
                          'The status of the source, one of `canceled`, `chargeable`, `consumed`, `failed`, or `pending`.',
                      },
                      three_d_secure: {
                        type: 'object',
                      },
                      type: {
                        type: 'string',
                        description: 'The `type` of the source.',
                      },
                      usage: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Either `reusable` or `single_use`.',
                      },
                      wechat: {
                        type: 'object',
                      },
                    },
                    description: '`Source` objects allow you to accept a variety of payment methods.',
                  },
                ],
                description: 'The source object for errors returned on a request involving a source.',
              },
              type: {
                type: 'string',
                description:
                  'The type of error returned. One of: api_error, card_error, idempotency_error, invalid_request_error.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The payment error encountered in the previous PaymentIntent confirmation.',
      },
      latest_charge: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['charge'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the latest Charge object created by this PaymentIntent.',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      managed_payments: {
        anyOf: [
          {
            type: 'object',
            properties: {
              enabled: {
                type: 'boolean',
                description:
                  "Set to `true` to enable Managed Payments, Stripe's merchant of record solution, for this session.",
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Settings for Managed Payments.',
      },
      metadata: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      next_action: {
        anyOf: [
          {
            type: 'object',
            properties: {
              alipay_handle_redirect: {
                type: 'object',
                properties: {
                  native_data: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The native data to be used with Alipay SDK you must redirect your customer to in order to authenticate the payment in an Android App.',
                  },
                  native_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The native URL you must redirect your customer to in order to authenticate the payment in an iOS App.',
                  },
                  return_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If the customer does not exit their browser while authenticating, they will be redirected to this specified URL after completion.',
                  },
                  url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The URL you must redirect your customer to in order to authenticate the payment.',
                  },
                },
              },
              blik_authorize: {
                type: 'object',
                properties: {},
              },
              boleto_display_details: {
                type: 'object',
                properties: {
                  expires_at: {
                    anyOf: [
                      {
                        type: 'integer',
                        format: 'unix-time',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The timestamp after which the boleto expires.',
                  },
                  hosted_voucher_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The URL to the hosted boleto voucher page, which allows customers to view the boleto voucher.',
                  },
                  number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The boleto number.',
                  },
                  pdf: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The URL to the downloadable boleto voucher PDF.',
                  },
                },
              },
              card_await_notification: {
                type: 'object',
                properties: {
                  charge_attempt_at: {
                    anyOf: [
                      {
                        type: 'integer',
                        format: 'unix-time',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The time that payment will be attempted.',
                  },
                  customer_approval_required: {
                    anyOf: [
                      {
                        type: 'boolean',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'For payments greater than INR 15000, the customer must provide explicit approval of the payment with their bank.',
                  },
                },
              },
              cashapp_handle_redirect_or_display_qr_code: {
                type: 'object',
                properties: {
                  hosted_instructions_url: {
                    type: 'string',
                    description:
                      'The URL to the hosted Cash App Pay instructions page, which allows customers to view the QR code, and supports QR code refreshing on expiration.',
                  },
                  mobile_auth_url: {
                    type: 'string',
                    description: 'The url for mobile redirect based auth',
                  },
                  qr_code: {
                    type: 'object',
                  },
                },
              },
              display_bank_transfer_instructions: {
                type: 'object',
                properties: {
                  amount_remaining: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The remaining amount that needs to be transferred to complete the payment.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Three-letter ISO currency code, in lowercase.',
                  },
                  financial_addresses: {
                    type: 'array',
                    items: {
                      type: 'object',
                      description:
                        'FinancialAddresses contain identifying information that resolves to a FinancialAccount.',
                    },
                    description: 'A list of financial addresses that can be used to fund the customer balance',
                  },
                  hosted_instructions_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A link to a hosted page that guides your customer through completing the transfer.',
                  },
                  reference: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A string identifying this payment.',
                  },
                  type: {
                    type: 'string',
                    description:
                      'Type of bank transfer One of: eu_bank_transfer, gb_bank_transfer, jp_bank_transfer, mx_bank_transfer, us_bank_transfer.',
                  },
                },
              },
              klarna_display_qr_code: {
                type: 'object',
                properties: {
                  data: {
                    type: 'string',
                    description: 'The data being used to generate QR code',
                  },
                  expires_at: {
                    anyOf: [
                      {
                        type: 'integer',
                        format: 'unix-time',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The timestamp at which the QR code expires.',
                  },
                  image_url_png: {
                    type: 'string',
                    description: 'The image_url_png string used to render QR code',
                  },
                  image_url_svg: {
                    type: 'string',
                    description: 'The image_url_svg string used to render QR code',
                  },
                },
              },
              konbini_display_details: {
                type: 'object',
                properties: {
                  expires_at: {
                    type: 'integer',
                    format: 'unix-time',
                    description: 'The timestamp at which the pending Konbini payment expires.',
                  },
                  hosted_voucher_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The URL for the Konbini payment instructions page, which allows customers to view and print a Konbini voucher.',
                  },
                  stores: {
                    type: 'object',
                  },
                },
              },
              multibanco_display_details: {
                type: 'object',
                properties: {
                  entity: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Entity number associated with this Multibanco payment.',
                  },
                  expires_at: {
                    anyOf: [
                      {
                        type: 'integer',
                        format: 'unix-time',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The timestamp at which the Multibanco voucher expires.',
                  },
                  hosted_voucher_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The URL for the hosted Multibanco voucher page, which allows customers to view a Multibanco voucher.',
                  },
                  reference: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Reference number associated with this Multibanco payment.',
                  },
                },
              },
              oxxo_display_details: {
                type: 'object',
                properties: {
                  expires_after: {
                    anyOf: [
                      {
                        type: 'integer',
                        format: 'unix-time',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The timestamp after which the OXXO voucher expires.',
                  },
                  hosted_voucher_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The URL for the hosted OXXO voucher page, which allows customers to view and print an OXXO voucher.',
                  },
                  number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'OXXO reference number.',
                  },
                },
              },
              paynow_display_qr_code: {
                type: 'object',
                properties: {
                  data: {
                    type: 'string',
                    description:
                      'The raw data string used to generate QR code, it should be used together with QR code library.',
                  },
                  hosted_instructions_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The URL to the hosted PayNow instructions page, which allows customers to view the PayNow QR code.',
                  },
                  image_url_png: {
                    type: 'string',
                    description: 'The image_url_png string used to render QR code',
                  },
                  image_url_svg: {
                    type: 'string',
                    description: 'The image_url_svg string used to render QR code',
                  },
                },
              },
              pix_display_qr_code: {
                type: 'object',
                properties: {
                  data: {
                    type: 'string',
                    description:
                      'The raw data string used to generate QR code, it should be used together with QR code library.',
                  },
                  expires_at: {
                    type: 'integer',
                    description: 'The date (unix timestamp) when the PIX expires.',
                  },
                  hosted_instructions_url: {
                    type: 'string',
                    description:
                      'The URL to the hosted pix instructions page, which allows customers to view the pix QR code.',
                  },
                  image_url_png: {
                    type: 'string',
                    description: 'The image_url_png string used to render png QR code',
                  },
                  image_url_svg: {
                    type: 'string',
                    description: 'The image_url_svg string used to render svg QR code',
                  },
                },
              },
              promptpay_display_qr_code: {
                type: 'object',
                properties: {
                  data: {
                    type: 'string',
                    description:
                      'The raw data string used to generate QR code, it should be used together with QR code library.',
                  },
                  hosted_instructions_url: {
                    type: 'string',
                    description:
                      'The URL to the hosted PromptPay instructions page, which allows customers to view the PromptPay QR code.',
                  },
                  image_url_png: {
                    type: 'string',
                    description:
                      'The PNG path used to render the QR code, can be used as the source in an HTML img tag',
                  },
                  image_url_svg: {
                    type: 'string',
                    description:
                      'The SVG path used to render the QR code, can be used as the source in an HTML img tag',
                  },
                },
              },
              redirect_to_url: {
                type: 'object',
                properties: {
                  return_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If the customer does not exit their browser while authenticating, they will be redirected to this specified URL after completion.',
                  },
                  url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The URL you must redirect your customer to in order to authenticate the payment.',
                  },
                },
              },
              swish_handle_redirect_or_display_qr_code: {
                type: 'object',
                properties: {
                  hosted_instructions_url: {
                    type: 'string',
                    description:
                      'The URL to the hosted Swish instructions page, which allows customers to view the QR code.',
                  },
                  qr_code: {
                    type: 'object',
                  },
                },
              },
              type: {
                type: 'string',
                description: 'Type of the next action to perform.',
              },
              upi_handle_redirect_or_display_qr_code: {
                type: 'object',
                properties: {
                  hosted_instructions_url: {
                    type: 'string',
                    description:
                      'The URL to the hosted UPI instructions page, which allows customers to view the QR code.',
                  },
                  qr_code: {
                    type: 'object',
                  },
                },
              },
              use_stripe_sdk: {
                type: 'object',
                properties: {},
                additionalProperties: true,
                description:
                  'When confirming a PaymentIntent with Stripe.js, Stripe.js depends on the contents of this dictionary to invoke authentication flows.',
              },
              verify_with_microdeposits: {
                type: 'object',
                properties: {
                  arrival_date: {
                    type: 'integer',
                    format: 'unix-time',
                    description: 'The timestamp when the microdeposits are expected to land.',
                  },
                  hosted_verification_url: {
                    type: 'string',
                    description:
                      'The URL for the hosted verification page, which allows customers to verify their bank account.',
                  },
                  microdeposit_type: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of the microdeposit sent to the customer. One of: amounts, descriptor_code.',
                  },
                },
              },
              wechat_pay_display_qr_code: {
                type: 'object',
                properties: {
                  data: {
                    type: 'string',
                    description: 'The data being used to generate QR code',
                  },
                  hosted_instructions_url: {
                    type: 'string',
                    description:
                      'The URL to the hosted WeChat Pay instructions page, which allows customers to view the WeChat Pay QR code.',
                  },
                  image_data_url: {
                    type: 'string',
                    description: 'The base64 image data for a pre-generated QR code',
                  },
                  image_url_png: {
                    type: 'string',
                    description: 'The image_url_png string used to render QR code',
                  },
                  image_url_svg: {
                    type: 'string',
                    description: 'The image_url_svg string used to render QR code',
                  },
                },
              },
              wechat_pay_redirect_to_android_app: {
                type: 'object',
                properties: {
                  app_id: {
                    type: 'string',
                    description: 'app_id is the APP ID registered on WeChat open platform',
                  },
                  nonce_str: {
                    type: 'string',
                    description: 'nonce_str is a random string',
                  },
                  package: {
                    type: 'string',
                    description: 'package is static value',
                  },
                  partner_id: {
                    type: 'string',
                    description: 'an unique merchant ID assigned by WeChat Pay',
                  },
                  prepay_id: {
                    type: 'string',
                    description: 'an unique trading ID assigned by WeChat Pay',
                  },
                  sign: {
                    type: 'string',
                    description: 'A signature',
                  },
                  timestamp: {
                    type: 'string',
                    description: 'Specifies the current time in epoch format',
                  },
                },
              },
              wechat_pay_redirect_to_ios_app: {
                type: 'object',
                properties: {
                  native_url: {
                    type: 'string',
                    description: 'An universal link that redirect to WeChat Pay app',
                  },
                },
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'If present, this property tells you what actions you need to take in order for your customer to fulfill a payment using the provided source.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: payment_intent.",
      },
      on_behalf_of: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['account'],
          },
          {
            type: 'null',
          },
        ],
        description:
          'You can specify the settlement merchant as the connected account using the `on_behalf_of` attribute on the charge.',
      },
      payment_details: {
        type: 'object',
        properties: {
          customer_reference: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'A unique value to identify the customer.',
          },
          order_reference: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'A unique value assigned by the business to identify the transaction.',
          },
        },
      },
      payment_method: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['payment_method'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the payment method used in this PaymentIntent.',
      },
      payment_method_configuration_details: {
        anyOf: [
          {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'ID of the payment method configuration used.',
              },
              parent: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'ID of the parent payment method configuration used.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Information about the payment method configuration used for this PaymentIntent.',
      },
      payment_method_options: {
        anyOf: [
          {
            type: 'object',
            properties: {
              acss_debit: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      mandate_options: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      target_date: {
                        type: 'string',
                        description:
                          "Controls when Stripe will attempt to debit the funds from the customer's account.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              affirm: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      preferred_locale: {
                        type: 'string',
                        description:
                          'Preferred language of the Affirm authorization page that the customer is redirected to.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              afterpay_clearpay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      reference: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'An internal identifier or reference that this payment corresponds to.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              alipay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              alma: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              amazon_pay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              au_becs_debit: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      target_date: {
                        type: 'string',
                        description:
                          "Controls when Stripe will attempt to debit the funds from the customer's account.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              bacs_debit: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      mandate_options: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      target_date: {
                        type: 'string',
                        description:
                          "Controls when Stripe will attempt to debit the funds from the customer's account.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              bancontact: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      preferred_language: {
                        type: 'string',
                        description:
                          'Preferred language of the Bancontact authorization page that the customer is redirected to. One of: de, en, fr, nl.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              billie: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              bizum: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {},
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              blik: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              boleto: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      expires_after_days: {
                        type: 'integer',
                        description: 'The number of calendar days before a Boleto voucher expires.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              card: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      installments: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Installment details for this payment.',
                      },
                      mandate_options: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Configuration options for setting up an eMandate for cards issued in India.',
                      },
                      network: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Selected network to process this payment intent on. One of: amex, cartes_bancaires, diners, discover, eftpos_au, girocard, interac, jcb, link, mastercard, unionpay, unknown, visa.',
                      },
                      request_extended_authorization: {
                        type: 'string',
                        description:
                          'Request ability to capture beyond the standard authorization validity window for this PaymentIntent. One of: if_available, never.',
                      },
                      request_incremental_authorization: {
                        type: 'string',
                        description:
                          'Request ability to increment the authorization for this PaymentIntent. One of: if_available, never.',
                      },
                      request_multicapture: {
                        type: 'string',
                        description:
                          'Request ability to make multiple captures for this PaymentIntent. One of: if_available, never.',
                      },
                      request_overcapture: {
                        type: 'string',
                        description:
                          'Request ability to overcapture for this PaymentIntent. One of: if_available, never.',
                      },
                      request_three_d_secure: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'We strongly recommend that you rely on our SCA Engine to automatically prompt your customers for authentication based on risk level and other requirements. One of: any, automatic, challenge.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      statement_descriptor_suffix_kana: {
                        type: 'string',
                        description:
                          'Provides information about a card payment that customers see on their statements.',
                      },
                      statement_descriptor_suffix_kanji: {
                        type: 'string',
                        description:
                          'Provides information about a card payment that customers see on their statements.',
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              card_present: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual, manual_preferred.",
                      },
                      request_extended_authorization: {
                        anyOf: [
                          {
                            type: 'boolean',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Request ability to capture this payment beyond the standard authorization validity window',
                      },
                      request_incremental_authorization_support: {
                        anyOf: [
                          {
                            type: 'boolean',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      routing: {
                        type: 'object',
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              cashapp: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              crypto: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              customer_balance: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      bank_transfer: {
                        type: 'object',
                      },
                      funding_type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The funding method type to be used when there are not enough funds in the customer balance. One of: bank_transfer.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              eps: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              fpx: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              giropay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              grabpay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              ideal: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              interac_present: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {},
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              kakao_pay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              klarna: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      preferred_locale: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Preferred locale of the Klarna checkout page that the customer is redirected to.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              konbini: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      confirmation_number: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'An optional 10 to 11 digit numeric-only string determining the confirmation code at applicable convenience stores.',
                      },
                      expires_after_days: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The number of calendar days (between 1 and 60) after which Konbini payment instructions will expire.',
                      },
                      expires_at: {
                        anyOf: [
                          {
                            type: 'integer',
                            format: 'unix-time',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The timestamp at which the Konbini payment instructions will expire.',
                      },
                      product_description: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'A product descriptor of up to 22 characters, which will appear to customers at the convenience store.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              kr_card: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              link: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              mb_way: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              mobilepay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              multibanco: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              naver_pay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              nz_bank_account: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      target_date: {
                        type: 'string',
                        description:
                          "Controls when Stripe will attempt to debit the funds from the customer's account.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              oxxo: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      expires_after_days: {
                        type: 'integer',
                        description: 'The number of calendar days before an OXXO invoice expires.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              p24: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              pay_by_bank: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {},
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              payco: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              paynow: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              paypal: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      preferred_locale: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Preferred locale of the PayPal checkout page that the customer is redirected to.',
                      },
                      reference: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          "A reference of the PayPal transaction visible to customer which is mapped to PayPal's invoice ID.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              payto: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      mandate_options: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              pix: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      amount_includes_iof: {
                        type: 'string',
                        description: 'Determines if the amount includes the IOF tax. One of: always, never.',
                      },
                      expires_after_seconds: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The number of seconds (between 10 and 1209600) after which Pix payment will expire.',
                      },
                      expires_at: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The timestamp at which the Pix expires.',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              promptpay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              revolut_pay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              samsung_pay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              satispay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              scalapay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              sepa_debit: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      mandate_options: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      target_date: {
                        type: 'string',
                        description:
                          "Controls when Stripe will attempt to debit the funds from the customer's account.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              sofort: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      preferred_language: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Preferred language of the SOFORT authorization page that the customer is redirected to. One of: de, en, es, fr, it, nl, pl.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              sunbit: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: manual.",
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              swish: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      reference: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A reference for this payment to be displayed in the Swish app.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              twint: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              upi: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: off_session, on_session.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              us_bank_account: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      financial_connections: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      target_date: {
                        type: 'string',
                        description:
                          "Controls when Stripe will attempt to debit the funds from the customer's account.",
                      },
                      transaction_purpose: {
                        type: 'string',
                        description: 'The purpose of the transaction. One of: goods, other, services, unspecified.',
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              wechat_pay: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      app_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The app ID registered with WeChat Pay.',
                      },
                      client: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The client type that the end customer will pay from One of: android, ios, web.',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
              zip: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none.",
                      },
                    },
                  },
                  {
                    type: 'object',
                    properties: {
                      capture_method: {
                        type: 'string',
                        description:
                          "Controls when the funds will be captured from the customer's account. One of: automatic_delayed, manual, manual_preferred.",
                      },
                      installments: {
                        type: 'object',
                      },
                      mandate_options: {
                        type: 'object',
                      },
                      request_incremental_authorization_support: {
                        type: 'boolean',
                        description:
                          'Request ability to increment this PaymentIntent if the combination of MCC and card brand is eligible.',
                      },
                      require_cvc_recollection: {
                        type: 'boolean',
                        description:
                          'When enabled, using a card that is attached to a customer will require the CVC to be provided again (i.e.',
                      },
                      routing: {
                        type: 'object',
                      },
                      setup_future_usage: {
                        type: 'string',
                        description:
                          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: none, off_session, on_session.",
                      },
                      verification_method: {
                        type: 'string',
                        description: 'Bank account verification method. One of: automatic, instant, microdeposits.',
                      },
                    },
                  },
                ],
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Payment-method-specific configuration for this PaymentIntent.',
      },
      payment_method_types: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'The list of payment method types (e.g.',
      },
      presentment_details: {
        type: 'object',
        properties: {
          presentment_amount: {
            type: 'integer',
            description: 'Amount intended to be collected by this payment, denominated in `presentment_currency`.',
          },
          presentment_currency: {
            type: 'string',
            description: 'Currency presented to the customer during payment.',
          },
        },
      },
      processing: {
        anyOf: [
          {
            type: 'object',
            properties: {
              card: {
                type: 'object',
                properties: {
                  customer_notification: {
                    type: 'object',
                  },
                },
              },
              type: {
                type: 'string',
                description:
                  'Type of the payment method for which payment is in `processing` state, one of `card`. One of: card.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'If present, this property tells you about the processing state of the payment.',
      },
      receipt_email: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Email address that the receipt for the resulting payment will be sent to.',
      },
      review: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['review'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the review associated with this PaymentIntent, if any.',
      },
      setup_future_usage: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          "Indicates that you intend to make future payments with this PaymentIntent's payment method. One of: off_session, on_session.",
      },
      shipping: {
        anyOf: [
          {
            type: 'object',
            properties: {
              address: {
                type: 'object',
                properties: {
                  city: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'City, district, suburb, town, or village.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter country code (ISO 3166-1 alpha-2).',
                  },
                  line1: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 1, such as the street, PO Box, or company name.',
                  },
                  line2: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 2, such as the apartment, suite, unit, or building.',
                  },
                  postal_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ZIP or postal code.',
                  },
                  state: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'State, county, province, or region (ISO 3166-2).',
                  },
                },
              },
              carrier: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The delivery service that shipped a physical product, such as Fedex, UPS, USPS, etc.',
              },
              name: {
                type: 'string',
                description: 'Recipient name.',
              },
              phone: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Recipient phone (including extension).',
              },
              tracking_number: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The tracking number for a physical product, obtained from the delivery service.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Shipping information for this PaymentIntent.',
      },
      statement_descriptor: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "Text that appears on the customer's statement as the statement descriptor for a non-card charge.",
      },
      statement_descriptor_suffix: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Provides information about a card charge.',
      },
      status: {
        type: 'string',
        description:
          'Status of this PaymentIntent, one of `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, `requires_capture`, `canceled`, or `succeeded`. One of: canceled, processing, requires_action, requires_capture, requires_confirmation, requires_payment_method, succeeded.',
      },
      transfer_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount: {
                type: 'integer',
                description: 'The amount transferred to the destination account.',
              },
              description: {
                type: 'string',
                description: 'An arbitrary string attached to the transfer.',
              },
              destination: {
                type: 'string',
                'x-stripe-expandable-resources': ['account'],
                description:
                  'The account (if any) that the payment is attributed to for tax reporting, and where funds from the payment are transferred to after payment success.',
              },
              metadata: {
                type: 'object',
                additionalProperties: {
                  type: 'string',
                },
                description: 'Set of key-value pairs that you can attach to an object.',
              },
              payment_data: {
                type: 'object',
                properties: {
                  description: {
                    type: 'string',
                    description: 'An arbitrary string attached to the destination payment.',
                  },
                  metadata: {
                    type: 'object',
                    description: 'Set of key-value pairs that you can attach to an object.',
                  },
                },
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The data that automatically creates a Transfer after the payment finalizes.',
      },
      transfer_group: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A string that identifies the resulting payment as part of a group.',
      },
    },
    description: 'A PaymentIntent guides you through the process of collecting a payment from your customer.',
  },
  charge: {
    type: 'object',
    properties: {
      amount: {
        type: 'integer',
        description: 'Amount intended to be collected by this payment.',
      },
      amount_captured: {
        type: 'integer',
        description:
          'Amount in cents (or local equivalent) captured (can be less than the amount attribute on the charge if a partial capture was made).',
      },
      amount_refunded: {
        type: 'integer',
        description:
          'Amount in cents (or local equivalent) refunded (can be less than the amount attribute on the charge if a partial refund was issued).',
      },
      application: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['application'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the Connect application that created the charge.',
      },
      application_fee: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['application_fee'],
          },
          {
            type: 'null',
          },
        ],
        description: 'The application fee (if any) for the charge.',
      },
      application_fee_amount: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description: 'The amount of the application fee (if any) requested for the charge.',
      },
      balance_transaction: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['balance_transaction'],
          },
          {
            type: 'null',
          },
        ],
        description:
          'ID of the balance transaction that describes the impact of this charge on your account balance (not including refunds or disputes).',
      },
      billing_details: {
        type: 'object',
        properties: {
          address: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  city: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'City, district, suburb, town, or village.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter country code (ISO 3166-1 alpha-2).',
                  },
                  line1: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 1, such as the street, PO Box, or company name.',
                  },
                  line2: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 2, such as the apartment, suite, unit, or building.',
                  },
                  postal_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ZIP or postal code.',
                  },
                  state: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'State, county, province, or region (ISO 3166-2).',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Billing address.',
          },
          email: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Email address.',
          },
          name: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Full name.',
          },
          phone: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Billing phone number (including extension).',
          },
          tax_id: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Taxpayer identification number.',
          },
        },
      },
      calculated_statement_descriptor: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          "The full statement descriptor that is passed to card networks, and that is displayed on your customers' credit card and bank statements.",
      },
      captured: {
        type: 'boolean',
        description:
          'If the charge was created without capturing, this Boolean represents whether it is still uncaptured or has since been captured.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code, in lowercase.',
      },
      customer: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the customer this charge is for if one exists.',
      },
      description: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'An arbitrary string attached to the object.',
      },
      disputed: {
        type: 'boolean',
        description: 'Whether the charge has been disputed.',
      },
      failure_balance_transaction: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['balance_transaction'],
          },
          {
            type: 'null',
          },
        ],
        description:
          'ID of the balance transaction that describes the reversal of the balance on your account due to payment failure.',
      },
      failure_code: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Error code explaining reason for charge failure if available (see the errors section for a list of codes).',
      },
      failure_message: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Message to user further explaining reason for charge failure if available.',
      },
      fraud_details: {
        anyOf: [
          {
            type: 'object',
            properties: {
              stripe_report: {
                type: 'string',
                description: 'Assessments from Stripe.',
              },
              user_report: {
                type: 'string',
                description: 'Assessments reported by you.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Information on fraud assessments for the charge.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      metadata: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: charge.",
      },
      on_behalf_of: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['account'],
          },
          {
            type: 'null',
          },
        ],
        description: 'The account (if any) the charge was made on behalf of without triggering an automatic transfer.',
      },
      outcome: {
        anyOf: [
          {
            type: 'object',
            properties: {
              advice_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'An enumerated value providing a more detailed explanation on how to proceed with an error. One of: confirm_card_data, do_not_try_again, try_again_later.',
              },
              network_advice_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'For charges declined by the network, a 2 digit code which indicates the advice returned by the network on how to proceed with an error.',
              },
              network_decline_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'For charges declined by the network, an alphanumeric code which indicates the reason the charge failed.',
              },
              network_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Possible values are `approved_by_network`, `declined_by_network`, `not_sent_to_network`, and `reversed_after_approval`.',
              },
              reason: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "An enumerated value providing a more detailed explanation of the outcome's `type`.",
              },
              risk_level: {
                type: 'string',
                description: "Stripe Radar's evaluation of the riskiness of the payment.",
              },
              risk_score: {
                type: 'integer',
                description: "Stripe Radar's evaluation of the riskiness of the payment.",
              },
              rule: {
                type: 'string',
                'x-stripe-expandable-resources': ['rule'],
                description: 'The ID of the Radar rule that matched the payment, if applicable.',
              },
              seller_message: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'A human-readable description of the outcome type and reason, designed for you (the recipient of the payment), not your customer.',
              },
              type: {
                type: 'string',
                description:
                  'Possible values are `authorized`, `manual_review`, `issuer_declined`, `blocked`, and `invalid`.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Details about whether the payment was accepted, and why.',
      },
      paid: {
        type: 'boolean',
        description: '`true` if the charge succeeded, or was successfully authorized for later capture.',
      },
      payment_intent: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['payment_intent'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the PaymentIntent associated with this charge, if one exists.',
      },
      payment_method: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the payment method used in this charge.',
      },
      payment_method_details: {
        anyOf: [
          {
            type: 'object',
            properties: {
              ach_credit_transfer: {
                type: 'object',
                properties: {
                  account_number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Account number to transfer funds to.',
                  },
                  bank_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Name of the bank associated with the routing number.',
                  },
                  routing_number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Routing transit number for the bank account to transfer funds to.',
                  },
                  swift_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'SWIFT code of the bank associated with the routing number.',
                  },
                },
              },
              ach_debit: {
                type: 'object',
                properties: {
                  account_holder_type: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Type of entity that holds the account. One of: company, individual.',
                  },
                  bank_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Name of the bank associated with the bank account.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter ISO code representing the country the bank account is located in.',
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular bank account.',
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four digits of the bank account number.',
                  },
                  routing_number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Routing transit number of the bank account.',
                  },
                },
              },
              acss_debit: {
                type: 'object',
                properties: {
                  bank_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Name of the bank associated with the bank account.',
                  },
                  expected_debit_date: {
                    type: 'string',
                    description: "Estimated date to debit the customer's bank account.",
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular bank account.',
                  },
                  institution_number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Institution number of the bank account',
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four digits of the bank account number.',
                  },
                  mandate: {
                    type: 'string',
                    description: 'ID of the mandate used to make this payment.',
                  },
                  transit_number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Transit number of the bank account.',
                  },
                },
              },
              affirm: {
                type: 'object',
                properties: {
                  location: {
                    type: 'string',
                    description: 'ID of the location that this reader is assigned to.',
                  },
                  reader: {
                    type: 'string',
                    description: 'ID of the reader this transaction was made on.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Affirm transaction ID associated with this payment.',
                  },
                },
              },
              afterpay_clearpay: {
                type: 'object',
                properties: {
                  order_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Afterpay order ID associated with this payment intent.',
                  },
                  reference: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Order identifier shown to the merchant in Afterpay's online portal.",
                  },
                },
              },
              alipay: {
                type: 'object',
                properties: {
                  buyer_id: {
                    type: 'string',
                    description: 'Uniquely identifies this particular Alipay account.',
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular Alipay account.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Transaction ID of this particular Alipay transaction.',
                  },
                },
              },
              alma: {
                type: 'object',
                properties: {
                  installments: {
                    type: 'object',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Alma transaction ID associated with this payment.',
                  },
                },
              },
              amazon_pay: {
                type: 'object',
                properties: {
                  funding: {
                    type: 'object',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Amazon Pay transaction ID associated with this payment.',
                  },
                },
              },
              au_becs_debit: {
                type: 'object',
                properties: {
                  bsb_number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bank-State-Branch number of the bank account.',
                  },
                  expected_debit_date: {
                    type: 'string',
                    description: "Estimated date to debit the customer's bank account.",
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular bank account.',
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four digits of the bank account number.',
                  },
                  mandate: {
                    type: 'string',
                    description: 'ID of the mandate used to make this payment.',
                  },
                },
              },
              bacs_debit: {
                type: 'object',
                properties: {
                  expected_debit_date: {
                    type: 'string',
                    description: "Estimated date to debit the customer's bank account.",
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular bank account.',
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four digits of the bank account number.',
                  },
                  mandate: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the mandate used to make this payment.',
                  },
                  sort_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Sort code of the bank account.',
                  },
                },
              },
              bancontact: {
                type: 'object',
                properties: {
                  bank_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bank code of bank associated with the bank account.',
                  },
                  bank_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Name of the bank associated with the bank account.',
                  },
                  bic: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bank Identifier Code of the bank associated with the bank account.',
                  },
                  generated_sepa_debit: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['payment_method'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The ID of the SEPA Direct Debit PaymentMethod which was generated by this Charge.',
                  },
                  generated_sepa_debit_mandate: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['mandate'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The mandate for the SEPA Direct Debit PaymentMethod which was generated by this Charge.',
                  },
                  iban_last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four characters of the IBAN.',
                  },
                  preferred_language: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Preferred language of the Bancontact authorization page that the customer is redirected to. One of: de, en, fr, nl.',
                  },
                  verified_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Owner's verified full name.",
                  },
                },
              },
              billie: {
                type: 'object',
                properties: {
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Billie transaction ID associated with this payment.',
                  },
                },
              },
              bizum: {
                type: 'object',
                properties: {
                  buyer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique identifier for the buyer as determined by the local payment processor.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Bizum transaction ID associated with this payment.',
                  },
                },
              },
              blik: {
                type: 'object',
                properties: {
                  buyer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique and immutable identifier assigned by BLIK to every buyer.',
                  },
                },
              },
              boleto: {
                type: 'object',
                properties: {
                  tax_id: {
                    type: 'string',
                    description:
                      'The tax ID of the customer (CPF for individuals consumers or CNPJ for businesses consumers)',
                  },
                },
              },
              card: {
                type: 'object',
                properties: {
                  amount_authorized: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The authorized amount.',
                  },
                  authorization_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Authorization code on the charge.',
                  },
                  brand: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Card brand.',
                  },
                  capture_before: {
                    type: 'integer',
                    format: 'unix-time',
                    description:
                      'When using manual capture, a future timestamp at which the charge will be automatically refunded if uncaptured.',
                  },
                  checks: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Check results by Card networks on Card address and CVC at time of payment.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter ISO code representing the country of the card.',
                  },
                  exp_month: {
                    type: 'integer',
                    description: "Two-digit number representing the card's expiration month.",
                  },
                  exp_year: {
                    type: 'integer',
                    description: "Four-digit number representing the card's expiration year.",
                  },
                  extended_authorization: {
                    type: 'object',
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular card number.',
                  },
                  funding: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Card funding type.',
                  },
                  incremental_authorization: {
                    type: 'object',
                  },
                  installments: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Installment details for this payment.',
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The last four digits of the card.',
                  },
                  mandate: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the mandate used to make this payment or created by it.',
                  },
                  multicapture: {
                    type: 'object',
                  },
                  network: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Identifies which network this charge was processed on.',
                  },
                  network_token: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If this card has network token credentials, this contains the details of the network token credentials.',
                  },
                  network_transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'This is used by the financial networks to identify a transaction.',
                  },
                  overcapture: {
                    type: 'object',
                  },
                  regulated_status: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Status of a card based on the card issuer. One of: regulated, unregulated.',
                  },
                  three_d_secure: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Populated if this transaction used 3D Secure authentication.',
                  },
                  transaction_link_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Transaction Link ID (TLID) is a unique identifier for a transaction.',
                  },
                  wallet: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'If this Card is part of a card wallet, this contains the details of the card wallet.',
                  },
                },
              },
              card_present: {
                type: 'object',
                properties: {
                  amount_authorized: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The authorized amount',
                  },
                  brand: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Card brand.',
                  },
                  brand_product: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The product code that identifies the specific program or product associated with a card.',
                  },
                  capture_before: {
                    type: 'integer',
                    format: 'unix-time',
                    description:
                      'When using manual capture, a future timestamp after which the charge will be automatically refunded if uncaptured.',
                  },
                  cardholder_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The cardholder name as read from the card, in ISO 7813 format.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter ISO code representing the country of the card.',
                  },
                  description: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A high-level description of the type of cards issued in this range.',
                  },
                  emv_auth_data: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Authorization response cryptogram.',
                  },
                  exp_month: {
                    type: 'integer',
                    description: "Two-digit number representing the card's expiration month.",
                  },
                  exp_year: {
                    type: 'integer',
                    description: "Four-digit number representing the card's expiration year.",
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular card number.',
                  },
                  funding: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Card funding type.',
                  },
                  generated_card: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'ID of a card PaymentMethod generated from the card_present PaymentMethod that may be attached to a Customer for future transactions.',
                  },
                  incremental_authorization_supported: {
                    type: 'boolean',
                    description: 'Whether this PaymentIntent is eligible for incremental authorizations.',
                  },
                  issuer: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The name of the card's issuing bank.",
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The last four digits of the card.',
                  },
                  location: {
                    type: 'string',
                    description: "ID of the location that this transaction's reader is assigned to.",
                  },
                  network: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Identifies which network this charge was processed on.',
                  },
                  network_transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'This is used by the financial networks to identify a transaction.',
                  },
                  offline: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Details about payments collected offline.',
                  },
                  overcapture_supported: {
                    type: 'boolean',
                    description: 'Defines whether the authorized amount can be over-captured or not',
                  },
                  preferred_locales: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The languages that the issuing bank recommends using for localizing any customer-facing text, as read from the card.',
                  },
                  read_method: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'How card details were read in this transaction. One of: contact_emv, contactless_emv, contactless_magstripe_mode, magnetic_stripe_fallback, magnetic_stripe_track2.',
                  },
                  reader: {
                    type: 'string',
                    description: 'ID of the reader this transaction was made on.',
                  },
                  receipt: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A collection of fields required to be displayed on receipts.',
                  },
                  wallet: {
                    type: 'object',
                  },
                },
              },
              cashapp: {
                type: 'object',
                properties: {
                  buyer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique and immutable identifier assigned by Cash App to every buyer.',
                  },
                  cashtag: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A public identifier for buyers using Cash App.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique and immutable identifier of payments assigned by Cash App',
                  },
                },
              },
              crypto: {
                type: 'object',
                properties: {
                  buyer_address: {
                    type: 'string',
                    description: 'The wallet address of the customer.',
                  },
                  network: {
                    type: 'string',
                    description:
                      'The blockchain network that the transaction was sent on. One of: base, ethereum, polygon, solana, sui, tempo.',
                  },
                  token_currency: {
                    type: 'string',
                    description:
                      'The token currency that the transaction was sent with. One of: phantom_cash, usdc, usdg, usdp, usdsui, usdt.',
                  },
                  transaction_hash: {
                    type: 'string',
                    description: 'The blockchain transaction hash of the crypto payment.',
                  },
                },
              },
              customer_balance: {
                type: 'object',
                properties: {},
              },
              eps: {
                type: 'object',
                properties: {
                  bank: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The customer's bank.",
                  },
                  verified_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Owner's verified full name.",
                  },
                },
              },
              fpx: {
                type: 'object',
                properties: {
                  bank: {
                    type: 'string',
                    description: "The customer's bank.",
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Unique transaction id generated by FPX for every request from the merchant',
                  },
                },
              },
              giropay: {
                type: 'object',
                properties: {
                  bank_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bank code of bank associated with the bank account.',
                  },
                  bank_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Name of the bank associated with the bank account.',
                  },
                  bic: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bank Identifier Code of the bank associated with the bank account.',
                  },
                  verified_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Owner's verified full name.",
                  },
                },
              },
              grabpay: {
                type: 'object',
                properties: {
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Unique transaction id generated by GrabPay',
                  },
                },
              },
              ideal: {
                type: 'object',
                properties: {
                  bank: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The customer's bank.",
                  },
                  bic: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The Bank Identifier Code of the customer's bank.",
                  },
                  generated_sepa_debit: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['payment_method'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The ID of the SEPA Direct Debit PaymentMethod which was generated by this Charge.',
                  },
                  generated_sepa_debit_mandate: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['mandate'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The mandate for the SEPA Direct Debit PaymentMethod which was generated by this Charge.',
                  },
                  iban_last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four characters of the IBAN.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Unique transaction ID generated by iDEAL.',
                  },
                  verified_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Owner's verified full name.",
                  },
                },
              },
              interac_present: {
                type: 'object',
                properties: {
                  brand: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Card brand.',
                  },
                  cardholder_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The cardholder name as read from the card, in ISO 7813 format.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter ISO code representing the country of the card.',
                  },
                  description: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A high-level description of the type of cards issued in this range.',
                  },
                  emv_auth_data: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Authorization response cryptogram.',
                  },
                  exp_month: {
                    type: 'integer',
                    description: "Two-digit number representing the card's expiration month.",
                  },
                  exp_year: {
                    type: 'integer',
                    description: "Four-digit number representing the card's expiration year.",
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular card number.',
                  },
                  funding: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Card funding type.',
                  },
                  generated_card: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'ID of a card PaymentMethod generated from the card_present PaymentMethod that may be attached to a Customer for future transactions.',
                  },
                  issuer: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The name of the card's issuing bank.",
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The last four digits of the card.',
                  },
                  location: {
                    type: 'string',
                    description: "ID of the location that this transaction's reader is assigned to.",
                  },
                  network: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Identifies which network this charge was processed on.',
                  },
                  network_transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'This is used by the financial networks to identify a transaction.',
                  },
                  preferred_locales: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The languages that the issuing bank recommends using for localizing any customer-facing text, as read from the card.',
                  },
                  read_method: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'How card details were read in this transaction. One of: contact_emv, contactless_emv, contactless_magstripe_mode, magnetic_stripe_fallback, magnetic_stripe_track2.',
                  },
                  reader: {
                    type: 'string',
                    description: 'ID of the reader this transaction was made on.',
                  },
                  receipt: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A collection of fields required to be displayed on receipts.',
                  },
                },
              },
              kakao_pay: {
                type: 'object',
                properties: {
                  buyer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique identifier for the buyer as determined by the local payment processor.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Kakao Pay transaction ID associated with this payment.',
                  },
                },
              },
              klarna: {
                type: 'object',
                properties: {
                  location: {
                    type: 'string',
                    description: "ID of the location that this transaction's reader is assigned to.",
                  },
                  payer_details: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The payer details for this transaction.',
                  },
                  payment_method_category: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Klarna payment method used for this transaction.',
                  },
                  preferred_locale: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Preferred language of the Klarna authorization page that the customer is redirected to.',
                  },
                  reader: {
                    type: 'string',
                    description: 'ID of the reader this transaction was made on.',
                  },
                },
              },
              konbini: {
                type: 'object',
                properties: {
                  store: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'If the payment succeeded, this contains the details of the convenience store where the payment was completed.',
                  },
                },
              },
              kr_card: {
                type: 'object',
                properties: {
                  brand: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The local credit or debit card brand.',
                  },
                  buyer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique identifier for the buyer as determined by the local payment processor.',
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The last four digits of the card.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Korean Card transaction ID associated with this payment.',
                  },
                },
              },
              link: {
                type: 'object',
                properties: {
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Two-letter ISO code representing the funding source country beneath the Link payment.',
                  },
                },
              },
              mb_way: {
                type: 'object',
                properties: {},
              },
              mobilepay: {
                type: 'object',
                properties: {
                  card: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Internal card details',
                  },
                },
              },
              multibanco: {
                type: 'object',
                properties: {
                  entity: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Entity number associated with this Multibanco payment.',
                  },
                  reference: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Reference number associated with this Multibanco payment.',
                  },
                },
              },
              naver_pay: {
                type: 'object',
                properties: {
                  buyer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique identifier for the buyer as determined by the local payment processor.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Naver Pay transaction ID associated with this payment.',
                  },
                },
              },
              nz_bank_account: {
                type: 'object',
                properties: {
                  account_holder_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The name on the bank account.',
                  },
                  bank_code: {
                    type: 'string',
                    description: "The numeric code for the bank account's bank.",
                  },
                  bank_name: {
                    type: 'string',
                    description: 'The name of the bank.',
                  },
                  branch_code: {
                    type: 'string',
                    description: "The numeric code for the bank account's bank branch.",
                  },
                  expected_debit_date: {
                    type: 'string',
                    description: "Estimated date to debit the customer's bank account.",
                  },
                  last4: {
                    type: 'string',
                    description: 'Last four digits of the bank account number.',
                  },
                  suffix: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The suffix of the bank account number.',
                  },
                },
              },
              oxxo: {
                type: 'object',
                properties: {
                  number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'OXXO reference number',
                  },
                },
              },
              p24: {
                type: 'object',
                properties: {
                  bank: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The customer's bank.",
                  },
                  reference: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Unique reference for this Przelewy24 payment.',
                  },
                  verified_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Owner's verified full name.",
                  },
                },
              },
              pay_by_bank: {
                type: 'object',
                properties: {},
              },
              payco: {
                type: 'object',
                properties: {
                  buyer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique identifier for the buyer as determined by the local payment processor.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Payco transaction ID associated with this payment.',
                  },
                },
              },
              paynow: {
                type: 'object',
                properties: {
                  location: {
                    type: 'string',
                    description: "ID of the location that this transaction's reader is assigned to.",
                  },
                  reader: {
                    type: 'string',
                    description: 'ID of the reader this transaction was made on.',
                  },
                  reference: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Reference number associated with this PayNow payment',
                  },
                },
              },
              paypal: {
                type: 'object',
                properties: {
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Two-letter ISO code representing the buyer's country.",
                  },
                  payer_email: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Owner's email.",
                  },
                  payer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'PayPal account PayerID.',
                  },
                  payer_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Owner's full name.",
                  },
                  seller_protection: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The level of protection offered as defined by PayPal Seller Protection for Merchants, for this transaction.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique ID generated by PayPal for this transaction.',
                  },
                },
              },
              payto: {
                type: 'object',
                properties: {
                  bsb_number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bank-State-Branch number of the bank account.',
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four digits of the bank account number.',
                  },
                  mandate: {
                    type: 'string',
                    description: 'ID of the mandate used to make this payment.',
                  },
                  pay_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The PayID alias for the bank account.',
                  },
                },
              },
              pix: {
                type: 'object',
                properties: {
                  bank_transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Unique transaction id generated by BCB',
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular Pix account.',
                  },
                  mandate: {
                    type: 'string',
                    description: 'ID of the multi use Mandate generated by the PaymentIntent',
                  },
                },
              },
              promptpay: {
                type: 'object',
                properties: {
                  reference: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bill reference generated by PromptPay',
                  },
                },
              },
              revolut_pay: {
                type: 'object',
                properties: {
                  funding: {
                    type: 'object',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Revolut Pay transaction ID associated with this payment.',
                  },
                },
              },
              samsung_pay: {
                type: 'object',
                properties: {
                  buyer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A unique identifier for the buyer as determined by the local payment processor.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Samsung Pay transaction ID associated with this payment.',
                  },
                },
              },
              satispay: {
                type: 'object',
                properties: {
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Satispay transaction ID associated with this payment.',
                  },
                },
              },
              scalapay: {
                type: 'object',
                properties: {
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Scalapay transaction ID associated with this payment.',
                  },
                },
              },
              sepa_debit: {
                type: 'object',
                properties: {
                  bank_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bank code of bank associated with the bank account.',
                  },
                  branch_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Branch code of bank associated with the bank account.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter ISO code representing the country the bank account is located in.',
                  },
                  expected_debit_date: {
                    type: 'string',
                    description: "Estimated date to debit the customer's bank account.",
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular bank account.',
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four characters of the IBAN.',
                  },
                  mandate: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Find the ID of the mandate used for this payment under the payment_method_details.sepa_debit.mandate property on the Charge.',
                  },
                },
              },
              sofort: {
                type: 'object',
                properties: {
                  bank_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bank code of bank associated with the bank account.',
                  },
                  bank_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Name of the bank associated with the bank account.',
                  },
                  bic: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Bank Identifier Code of the bank associated with the bank account.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter ISO code representing the country the bank account is located in.',
                  },
                  generated_sepa_debit: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['payment_method'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The ID of the SEPA Direct Debit PaymentMethod which was generated by this Charge.',
                  },
                  generated_sepa_debit_mandate: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['mandate'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The mandate for the SEPA Direct Debit PaymentMethod which was generated by this Charge.',
                  },
                  iban_last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four characters of the IBAN.',
                  },
                  preferred_language: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Preferred language of the SOFORT authorization page that the customer is redirected to. One of: de, en, es, fr, it, nl, pl.',
                  },
                  verified_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Owner's verified full name.",
                  },
                },
              },
              stripe_account: {
                type: 'object',
                properties: {},
              },
              sunbit: {
                type: 'object',
                properties: {
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The Sunbit transaction ID associated with this payment.',
                  },
                },
              },
              swish: {
                type: 'object',
                properties: {
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Uniquely identifies the payer's Swish account.",
                  },
                  payment_reference: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Payer bank reference number for the payment',
                  },
                  verified_phone_last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The last four digits of the Swish account phone number',
                  },
                },
              },
              twint: {
                type: 'object',
                properties: {
                  mandate: {
                    type: 'string',
                    description: 'ID of the multi use Mandate generated by the PaymentIntent',
                  },
                },
              },
              type: {
                type: 'string',
                description: 'The type of transaction-specific details of the payment method used in the payment.',
              },
              upi: {
                type: 'object',
                properties: {
                  vpa: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Customer's unique Virtual Payment Address.",
                  },
                },
              },
              us_bank_account: {
                type: 'object',
                properties: {
                  account_holder_type: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Account holder type: individual or company. One of: company, individual.',
                  },
                  account_type: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Account type: checkings or savings. One of: checking, savings.',
                  },
                  bank_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Name of the bank associated with the bank account.',
                  },
                  expected_debit_date: {
                    type: 'string',
                    description: "Estimated date to debit the customer's bank account.",
                  },
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular bank account.',
                  },
                  last4: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Last four digits of the bank account number.',
                  },
                  mandate: {
                    type: 'string',
                    'x-stripe-expandable-resources': ['mandate'],
                    description: 'ID of the mandate used to make this payment.',
                  },
                  payment_reference: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Reference number to locate ACH payments with customer's bank.",
                  },
                  routing_number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Routing number of the bank account.',
                  },
                },
              },
              wechat: {
                type: 'object',
                properties: {},
              },
              wechat_pay: {
                type: 'object',
                properties: {
                  fingerprint: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Uniquely identifies this particular WeChat Pay account.',
                  },
                  location: {
                    type: 'string',
                    description: "ID of the location that this transaction's reader is assigned to.",
                  },
                  reader: {
                    type: 'string',
                    description: 'ID of the reader this transaction was made on.',
                  },
                  transaction_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Transaction ID of this particular WeChat Pay transaction.',
                  },
                },
              },
              zip: {
                type: 'object',
                properties: {},
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Details about the payment method at the time of the transaction.',
      },
      presentment_details: {
        type: 'object',
        properties: {
          presentment_amount: {
            type: 'integer',
            description: 'Amount intended to be collected by this payment, denominated in `presentment_currency`.',
          },
          presentment_currency: {
            type: 'string',
            description: 'Currency presented to the customer during payment.',
          },
        },
      },
      radar_options: {
        type: 'object',
        properties: {
          session: {
            type: 'string',
            description:
              'A Radar Session is a snapshot of the browser metadata and device details that help Radar make more accurate predictions on your payments.',
          },
        },
        description: 'Options to configure Radar.',
      },
      receipt_email: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'This is the email address that the receipt for this charge was sent to.',
      },
      receipt_number: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'This is the transaction number that appears on email receipts sent for this charge.',
      },
      receipt_url: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'This is the URL to view the receipt for this charge.',
      },
      refunded: {
        type: 'boolean',
        description: 'Whether the charge has been fully refunded.',
      },
      review: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['review'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the review associated with this charge if one exists.',
      },
      shipping: {
        anyOf: [
          {
            type: 'object',
            properties: {
              address: {
                type: 'object',
                properties: {
                  city: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'City, district, suburb, town, or village.',
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Two-letter country code (ISO 3166-1 alpha-2).',
                  },
                  line1: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 1, such as the street, PO Box, or company name.',
                  },
                  line2: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Address line 2, such as the apartment, suite, unit, or building.',
                  },
                  postal_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ZIP or postal code.',
                  },
                  state: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'State, county, province, or region (ISO 3166-2).',
                  },
                },
              },
              carrier: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The delivery service that shipped a physical product, such as Fedex, UPS, USPS, etc.',
              },
              name: {
                type: 'string',
                description: 'Recipient name.',
              },
              phone: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Recipient phone (including extension).',
              },
              tracking_number: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The tracking number for a physical product, obtained from the delivery service.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Shipping information for the charge.',
      },
      source_transfer: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['transfer'],
          },
          {
            type: 'null',
          },
        ],
        description: 'The transfer ID which created this charge.',
      },
      statement_descriptor: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          "For a non-card charge, text that appears on the customer's statement as the statement descriptor.",
      },
      statement_descriptor_suffix: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Provides information about a card charge.',
      },
      status: {
        type: 'string',
        description:
          'The status of the payment is either `succeeded`, `pending`, or `failed`. One of: failed, pending, succeeded.',
      },
      transfer: {
        type: 'string',
        'x-stripe-expandable-resources': ['transfer'],
        description:
          'ID of the transfer to the `destination` account (only applicable if the charge was created using the `destination` parameter).',
      },
      transfer_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The amount transferred to the destination account, if specified.',
              },
              destination: {
                type: 'string',
                'x-stripe-expandable-resources': ['account'],
                description:
                  'ID of an existing, connected Stripe account to transfer funds to if `transfer_data` was specified in the charge request.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'An optional dictionary including the account to automatically transfer to as part of a destination charge.',
      },
      transfer_group: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A string that identifies this transaction as part of a group.',
      },
    },
    description: 'The `Charge` object represents a single attempt to move money into your Stripe account.',
  },
  refund: {
    type: 'object',
    properties: {
      amount: {
        type: 'integer',
        description: 'Amount, in cents (or local equivalent).',
      },
      balance_transaction: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['balance_transaction'],
          },
          {
            type: 'null',
          },
        ],
        description: 'Balance transaction that describes the impact on your account balance.',
      },
      charge: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['charge'],
          },
          {
            type: 'null',
          },
        ],
        description: "ID of the charge that's refunded.",
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code, in lowercase.',
      },
      customer: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the customer of this refund.',
      },
      customer_account: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the account of this refund.',
      },
      description: {
        type: 'string',
        description: 'An arbitrary string attached to the object.',
      },
      destination_details: {
        type: 'object',
        properties: {
          affirm: {
            type: 'object',
            properties: {},
          },
          afterpay_clearpay: {
            type: 'object',
            properties: {},
          },
          alipay: {
            type: 'object',
            properties: {},
          },
          alma: {
            type: 'object',
            properties: {},
          },
          amazon_pay: {
            type: 'object',
            properties: {},
          },
          au_bank_transfer: {
            type: 'object',
            properties: {},
          },
          blik: {
            type: 'object',
            properties: {
              network_decline_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'For refunds declined by the network, a decline code provided by the network which indicates the reason the refund failed.',
              },
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          br_bank_transfer: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          card: {
            type: 'object',
            properties: {
              reference: {
                type: 'string',
                description: 'Value of the reference number assigned to the refund.',
              },
              reference_status: {
                type: 'string',
                description: 'Status of the reference number on the refund.',
              },
              reference_type: {
                type: 'string',
                description: 'Type of the reference number assigned to the refund.',
              },
              type: {
                type: 'string',
                description: 'The type of refund. One of: pending, refund, reversal.',
              },
            },
          },
          cashapp: {
            type: 'object',
            properties: {},
          },
          crypto: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The transaction hash of the refund.',
              },
            },
          },
          customer_cash_balance: {
            type: 'object',
            properties: {},
          },
          eps: {
            type: 'object',
            properties: {},
          },
          eu_bank_transfer: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          gb_bank_transfer: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          giropay: {
            type: 'object',
            properties: {},
          },
          grabpay: {
            type: 'object',
            properties: {},
          },
          jp_bank_transfer: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          klarna: {
            type: 'object',
            properties: {},
          },
          mb_way: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          multibanco: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          mx_bank_transfer: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          nz_bank_transfer: {
            type: 'object',
            properties: {},
          },
          p24: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          paynow: {
            type: 'object',
            properties: {},
          },
          paypal: {
            type: 'object',
            properties: {
              network_decline_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'For refunds declined by the network, a decline code provided by the network which indicates the reason the refund failed.',
              },
            },
          },
          pix: {
            type: 'object',
            properties: {},
          },
          revolut: {
            type: 'object',
            properties: {},
          },
          scalapay: {
            type: 'object',
            properties: {},
          },
          sofort: {
            type: 'object',
            properties: {},
          },
          swish: {
            type: 'object',
            properties: {
              network_decline_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'For refunds declined by the network, a decline code provided by the network which indicates the reason the refund failed.',
              },
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          th_bank_transfer: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          twint: {
            type: 'object',
            properties: {},
          },
          type: {
            type: 'string',
            description:
              'The type of transaction-specific details of the payment method used in the refund (e.g., `card`).',
          },
          us_bank_transfer: {
            type: 'object',
            properties: {
              reference: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reference assigned to the refund.',
              },
              reference_status: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Status of the reference on the refund.',
              },
            },
          },
          wechat_pay: {
            type: 'object',
            properties: {},
          },
          zip: {
            type: 'object',
            properties: {},
          },
        },
      },
      failure_balance_transaction: {
        type: 'string',
        'x-stripe-expandable-resources': ['balance_transaction'],
        description:
          'After the refund fails, this balance transaction describes the adjustment made on your account balance that reverses the initial balance transaction.',
      },
      failure_reason: {
        type: 'string',
        description: 'Provides the reason for the refund failure.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      instructions_email: {
        type: 'string',
        description:
          'For payment methods without native refund support (for example, Konbini, PromptPay), provide an email address for the customer to receive refund instructions.',
      },
      metadata: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      next_action: {
        type: 'object',
        properties: {
          display_details: {
            type: 'object',
            properties: {
              email_sent: {
                type: 'object',
              },
              expires_at: {
                type: 'integer',
                format: 'unix-time',
                description: 'The expiry timestamp.',
              },
            },
          },
          type: {
            type: 'string',
            description: 'Type of the next action to perform.',
          },
        },
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: refund.",
      },
      payment_intent: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['payment_intent'],
          },
          {
            type: 'null',
          },
        ],
        description: "ID of the PaymentIntent that's refunded.",
      },
      payment_method: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['payment_method'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the payment method associated with this refund.',
      },
      pending_reason: {
        type: 'string',
        description:
          'Provides the reason for why the refund is pending. One of: charge_pending, insufficient_funds, processing.',
      },
      presentment_details: {
        type: 'object',
        properties: {
          presentment_amount: {
            type: 'integer',
            description: 'Amount intended to be collected by this payment, denominated in `presentment_currency`.',
          },
          presentment_currency: {
            type: 'string',
            description: 'Currency presented to the customer during payment.',
          },
        },
      },
      reason: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Reason for the refund, which is either user-provided (`duplicate`, `fraudulent`, or `requested_by_customer`) or generated by Stripe internally (`expired_uncaptured_charge`). One of: duplicate, expired_uncaptured_charge, fraudulent, requested_by_customer.',
      },
      receipt_number: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'This is the transaction number that appears on email receipts sent for this refund.',
      },
      source_transfer_reversal: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['transfer_reversal'],
          },
          {
            type: 'null',
          },
        ],
        description: "The transfer reversal that's associated with the refund.",
      },
      status: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Status of the refund.',
      },
      transfer_reversal: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['transfer_reversal'],
          },
          {
            type: 'null',
          },
        ],
        description: 'This refers to the transfer reversal object if the accompanying transfer reverses.',
      },
    },
    description: "Refund objects allow you to refund a previously created charge that isn't refunded yet.",
  },
  dispute: {
    type: 'object',
    properties: {
      amount: {
        type: 'integer',
        description: 'Disputed amount.',
      },
      balance_transactions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            amount: {
              type: 'integer',
              description: 'Gross amount of this transaction (in cents (or local equivalent)).',
            },
            available_on: {
              type: 'integer',
              format: 'unix-time',
              description: "The date that the transaction's net funds become available in the Stripe balance.",
            },
            balance_type: {
              type: 'string',
              description:
                'The balance that this transaction impacts. One of: issuing, payments, refund_and_dispute_prefunding, risk_reserved.',
            },
            created: {
              type: 'integer',
              format: 'unix-time',
              description: 'Time at which the object was created.',
            },
            currency: {
              type: 'string',
              description: 'Three-letter ISO currency code, in lowercase.',
            },
            description: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'An arbitrary string attached to the object.',
            },
            exchange_rate: {
              anyOf: [
                {
                  type: 'number',
                },
                {
                  type: 'null',
                },
              ],
              description: 'If applicable, this transaction uses an exchange rate.',
            },
            fee: {
              type: 'integer',
              description: 'Fees (in cents (or local equivalent)) paid for this transaction.',
            },
            fee_details: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  amount: {
                    type: 'integer',
                    description: 'Amount of the fee, in cents.',
                  },
                  application: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the Connect application that earned the fee.',
                  },
                  currency: {
                    type: 'string',
                    description: 'Three-letter ISO currency code, in lowercase.',
                  },
                  description: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'An arbitrary string attached to the object.',
                  },
                  type: {
                    type: 'string',
                    description:
                      'Type of the fee, one of: `application_fee`, `payment_method_passthrough_fee`, `stripe_fee`, `tax`, or `withheld_tax`.',
                  },
                },
              },
              description: 'Detailed breakdown of fees (in cents (or local equivalent)) paid for this transaction.',
            },
            id: {
              type: 'string',
              description: 'Unique identifier for the object.',
            },
            net: {
              type: 'integer',
              description: 'Net impact to a Stripe balance (in cents (or local equivalent)).',
            },
            object: {
              type: 'string',
              description: "String representing the object's type. One of: balance_transaction.",
            },
            reporting_category: {
              type: 'string',
              description:
                'Learn more about how reporting categories can help you understand balance transactions from an accounting perspective.',
            },
            source: {
              anyOf: [
                {
                  type: 'string',
                  'x-stripe-expandable-resources': [
                    'application_fee',
                    'charge',
                    'connect_collection_transfer',
                    'customer_cash_balance_transaction',
                    'dispute',
                    'fee_refund',
                    'issuing.authorization',
                    'issuing.dispute',
                    'issuing.transaction',
                    'payout',
                    'refund',
                    'reserve_transaction',
                    'tax_deducted_at_source',
                    'topup',
                    'transfer',
                    'transfer_reversal',
                  ],
                },
                {
                  type: 'null',
                },
              ],
              description: 'This transaction relates to the Stripe object.',
            },
            status: {
              type: 'string',
              description:
                "The transaction's net funds status in the Stripe balance, which are either `available` or `pending`.",
            },
            type: {
              type: 'string',
              description:
                'Transaction type: `tax_fund`, `adjustment`, `advance`, `advance_funding`, `anticipation_repayment`, `application_fee`, `application_fee_refund`, `charge`, `climate_order_purchase`, `climate_order_ref…',
            },
          },
          description: 'Balance transactions represent funds moving through your Stripe account.',
        },
        description:
          'List of zero, one, or two balance transactions that show funds withdrawn and reinstated to your Stripe account as a result of this dispute.',
      },
      charge: {
        type: 'string',
        'x-stripe-expandable-resources': ['charge'],
        description: "ID of the charge that's disputed.",
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code, in lowercase.',
      },
      enhanced_eligibility_types: {
        type: 'array',
        items: {
          type: 'string',
          description: 'One of: mastercard_compliance, visa_compelling_evidence_3, visa_compliance.',
        },
        description: 'List of eligibility types that are included in `enhanced_evidence`.',
      },
      evidence: {
        type: 'object',
        properties: {
          access_activity_log: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'Any server or activity logs showing proof that the customer accessed or downloaded the purchased digital product.',
          },
          billing_address: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The billing address provided by the customer.',
          },
          cancellation_policy: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['file'],
              },
              {
                type: 'null',
              },
            ],
            description: '(ID of a file upload) Your subscription cancellation policy, as shown to the customer.',
          },
          cancellation_policy_disclosure: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'An explanation of how and when the customer was shown your refund policy prior to purchase.',
          },
          cancellation_rebuttal: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A justification for why the customer's subscription was not canceled.",
          },
          customer_communication: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['file'],
              },
              {
                type: 'null',
              },
            ],
            description:
              '(ID of a file upload) Any communication with the customer that you feel is relevant to your case.',
          },
          customer_email_address: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The email address of the customer.',
          },
          customer_name: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The name of the customer.',
          },
          customer_purchase_ip: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The IP address that the customer used when making the purchase.',
          },
          customer_signature: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['file'],
              },
              {
                type: 'null',
              },
            ],
            description: "(ID of a file upload) A relevant document or contract showing the customer's signature.",
          },
          duplicate_charge_documentation: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['file'],
              },
              {
                type: 'null',
              },
            ],
            description:
              '(ID of a file upload) Documentation for the prior charge that can uniquely identify the charge, such as a receipt, shipping label, work order, etc.',
          },
          duplicate_charge_explanation: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'An explanation of the difference between the disputed charge versus the prior charge that appears to be a duplicate.',
          },
          duplicate_charge_id: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The Stripe ID for the prior charge which appears to be a duplicate of the disputed charge.',
          },
          enhanced_evidence: {
            type: 'object',
            properties: {
              mastercard_compliance: {
                type: 'object',
              },
              visa_compelling_evidence_3: {
                type: 'object',
              },
              visa_compliance: {
                type: 'object',
              },
            },
          },
          product_description: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'A description of the product or service that was sold.',
          },
          receipt: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['file'],
              },
              {
                type: 'null',
              },
            ],
            description:
              '(ID of a file upload) Any receipt or message sent to the customer notifying them of the charge.',
          },
          refund_policy: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['file'],
              },
              {
                type: 'null',
              },
            ],
            description: '(ID of a file upload) Your refund policy, as shown to the customer.',
          },
          refund_policy_disclosure: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'Documentation demonstrating that the customer was shown your refund policy prior to purchase.',
          },
          refund_refusal_explanation: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'A justification for why the customer is not entitled to a refund.',
          },
          service_date: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'The date on which the customer received or began receiving the purchased service, in a clear human-readable format.',
          },
          service_documentation: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['file'],
              },
              {
                type: 'null',
              },
            ],
            description:
              '(ID of a file upload) Documentation showing proof that a service was provided to the customer.',
          },
          shipping_address: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The address to which a physical product was shipped.',
          },
          shipping_carrier: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The delivery service that shipped a physical product, such as Fedex, UPS, USPS, etc.',
          },
          shipping_date: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'The date on which a physical product began its route to the shipping address, in a clear human-readable format.',
          },
          shipping_documentation: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['file'],
              },
              {
                type: 'null',
              },
            ],
            description:
              '(ID of a file upload) Documentation showing proof that a product was shipped to the customer at the same address the customer provided to you.',
          },
          shipping_tracking_number: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The tracking number for a physical product, obtained from the delivery service.',
          },
          uncategorized_file: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['file'],
              },
              {
                type: 'null',
              },
            ],
            description: '(ID of a file upload) Any additional evidence or statements.',
          },
          uncategorized_text: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Any additional evidence or statements.',
          },
        },
      },
      evidence_details: {
        type: 'object',
        properties: {
          due_by: {
            anyOf: [
              {
                type: 'integer',
                format: 'unix-time',
              },
              {
                type: 'null',
              },
            ],
            description: 'Date by which evidence must be submitted in order to successfully challenge dispute.',
          },
          enhanced_eligibility: {
            type: 'object',
            properties: {
              mastercard_compliance: {
                type: 'object',
              },
              visa_compelling_evidence_3: {
                type: 'object',
              },
              visa_compliance: {
                type: 'object',
              },
            },
          },
          has_evidence: {
            type: 'boolean',
            description: 'Whether evidence has been staged for this dispute.',
          },
          past_due: {
            type: 'boolean',
            description: 'Whether the last evidence submission was submitted past the due date.',
          },
          submission_count: {
            type: 'integer',
            description: 'The number of times evidence has been submitted.',
          },
        },
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      is_charge_refundable: {
        type: 'boolean',
        description: "If true, it's still possible to refund the disputed payment.",
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      metadata: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: dispute.",
      },
      payment_intent: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['payment_intent'],
          },
          {
            type: 'null',
          },
        ],
        description: "ID of the PaymentIntent that's disputed.",
      },
      payment_method_details: {
        type: 'object',
        properties: {
          amazon_pay: {
            type: 'object',
            properties: {
              dispute_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The AmazonPay dispute type, chargeback or claim One of: chargeback, claim.',
              },
            },
          },
          card: {
            type: 'object',
            properties: {
              brand: {
                type: 'string',
                description: 'Card brand.',
              },
              case_type: {
                type: 'string',
                description: 'The type of dispute opened. One of: block, chargeback, compliance, inquiry, resolution.',
              },
              network: {
                type: 'string',
                description: 'Identifies which network this charge was processed on.',
              },
              network_reason_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "The card network's specific dispute reason code, which maps to one of Stripe's primary dispute categories to simplify response guidance.",
              },
            },
          },
          klarna: {
            type: 'object',
            properties: {
              chargeback_loss_reason_code: {
                type: 'string',
                description: "Chargeback loss reason mapped by Stripe from Klarna's chargeback loss reason",
              },
              reason_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reason for the dispute as defined by Klarna',
              },
            },
          },
          paypal: {
            type: 'object',
            properties: {
              case_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the dispute in PayPal.',
              },
              reason_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The reason for the dispute as defined by PayPal',
              },
            },
          },
          type: {
            type: 'string',
            description: 'Payment method type. One of: amazon_pay, card, klarna, paypal.',
          },
        },
      },
      reason: {
        type: 'string',
        description: 'Reason given by cardholder for dispute.',
      },
      status: {
        type: 'string',
        description:
          'The current status of a dispute. One of: lost, needs_response, prevented, under_review, warning_closed, warning_needs_response, warning_under_review, won.',
      },
    },
    description: 'A dispute occurs when a customer questions your charge with their card issuer.',
  },
  credit_note: {
    type: 'object',
    properties: {
      amount: {
        type: 'integer',
        description:
          'The integer amount in cents (or local equivalent) representing the total amount of the credit note, including tax.',
      },
      amount_shipping: {
        type: 'integer',
        description: 'This is the sum of all the shipping amounts.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code, in lowercase.',
      },
      customer: {
        type: 'string',
        'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
        description: 'ID of the customer.',
      },
      customer_account: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the account representing the customer.',
      },
      customer_balance_transaction: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['customer_balance_transaction'],
          },
          {
            type: 'null',
          },
        ],
        description: 'Customer balance transaction related to this credit note.',
      },
      discount_amount: {
        type: 'integer',
        description:
          'The integer amount in cents (or local equivalent) representing the total amount of discount that was credited.',
      },
      discount_amounts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            amount: {
              type: 'integer',
              description: 'The amount, in cents (or local equivalent), of the discount.',
            },
            discount: {
              type: 'string',
              'x-stripe-expandable-resources': ['discount', 'deleted_discount'],
              description: 'The discount that was applied to get this discount amount.',
            },
          },
        },
        description: 'The aggregate amounts calculated per discount for all line items.',
      },
      effective_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'The date when this credit note is in effect.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      invoice: {
        type: 'string',
        'x-stripe-expandable-resources': ['invoice'],
        description: 'ID of the invoice.',
      },
      lines: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                amount: {
                  type: 'integer',
                  description:
                    'The integer amount in cents (or local equivalent) representing the gross amount being credited for this line item, excluding (exclusive) tax and discounts.',
                },
                description: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Description of the item being credited.',
                },
                discount_amount: {
                  type: 'integer',
                  description:
                    'The integer amount in cents (or local equivalent) representing the discount being credited for this line item.',
                },
                discount_amounts: {
                  type: 'array',
                  items: {
                    type: 'object',
                  },
                  description: 'The amount of discount calculated per discount for this line item',
                },
                id: {
                  type: 'string',
                  description: 'Unique identifier for the object.',
                },
                invoice_line_item: {
                  type: 'string',
                  description: 'ID of the invoice line item being credited',
                },
                livemode: {
                  type: 'boolean',
                  description: 'If the object exists in live mode, the value is `true`.',
                },
                metadata: {
                  anyOf: [
                    {
                      type: 'object',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Set of key-value pairs that you can attach to an object.',
                },
                object: {
                  type: 'string',
                  description: "String representing the object's type. One of: credit_note_line_item.",
                },
                pretax_credit_amounts: {
                  type: 'array',
                  items: {
                    type: 'object',
                  },
                  description: 'The pretax credit amounts (ex: discount, credit grants, etc) for this line item.',
                },
                quantity: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The number of units of product being credited.',
                },
                tax_rates: {
                  type: 'array',
                  items: {
                    type: 'object',
                    description:
                      'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
                  },
                  description: 'The tax rates which apply to the line item.',
                },
                taxes: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The tax information of the line item.',
                },
                type: {
                  type: 'string',
                  description:
                    'The type of the credit note line item, one of `invoice_line_item` or `custom_line_item`. One of: custom_line_item, invoice_line_item.',
                },
                unit_amount: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The cost of each unit of product being credited.',
                },
                unit_amount_decimal: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Same as `unit_amount`, but contains a decimal value with at most 12 decimal places.',
                },
              },
              description: 'The credit note line item object',
            },
            description: 'Details about each object.',
          },
          has_more: {
            type: 'boolean',
            description: 'True if this list has another page of items after this one that can be fetched.',
          },
          object: {
            type: 'string',
            description: "String representing the object's type. One of: list.",
          },
          url: {
            type: 'string',
            description: 'The URL where this list can be accessed.',
          },
        },
        description: 'Line items that make up the credit note',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      memo: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Customer-facing text that appears on the credit note PDF.',
      },
      metadata: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      number: {
        type: 'string',
        description:
          'A unique number that identifies this particular credit note and appears on the PDF of the credit note and its associated invoice.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: credit_note.",
      },
      out_of_band_amount: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description: 'Amount that was credited outside of Stripe.',
      },
      pdf: {
        type: 'string',
        description: 'The link to download the PDF of the credit note.',
      },
      post_payment_amount: {
        type: 'integer',
        description:
          "The amount of the credit note that was refunded to the customer, credited to the customer's balance, credited outside of Stripe, or any combination thereof.",
      },
      pre_payment_amount: {
        type: 'integer',
        description:
          "The amount of the credit note by which the invoice's `amount_remaining` and `amount_due` were reduced.",
      },
      pretax_credit_amounts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            amount: {
              type: 'integer',
              description: 'The amount, in cents (or local equivalent), of the pretax credit amount.',
            },
            credit_balance_transaction: {
              type: 'string',
              'x-stripe-expandable-resources': ['billing.credit_balance_transaction'],
              description: 'The credit balance transaction that was applied to get this pretax credit amount.',
            },
            discount: {
              type: 'string',
              'x-stripe-expandable-resources': ['discount', 'deleted_discount'],
              description: 'The discount that was applied to get this pretax credit amount.',
            },
            type: {
              type: 'string',
              description: 'Type of the pretax credit amount referenced. One of: credit_balance_transaction, discount.',
            },
          },
        },
        description: 'The pretax credit amounts (ex: discount, credit grants, etc) for all line items.',
      },
      reason: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Reason for issuing this credit note, one of `duplicate`, `fraudulent`, `order_change`, or `product_unsatisfactory` One of: duplicate, fraudulent, order_change, product_unsatisfactory.',
      },
      refunds: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            amount_refunded: {
              type: 'integer',
              description: 'Amount of the refund that applies to this credit note, in cents (or local equivalent).',
            },
            payment_record_refund: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    payment_record: {
                      type: 'string',
                      description: 'ID of the payment record.',
                    },
                    refund_group: {
                      type: 'string',
                      description: 'ID of the refund group.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The PaymentRecord refund details associated with this credit note refund.',
            },
            refund: {
              type: 'string',
              'x-stripe-expandable-resources': ['refund'],
              description: 'ID of the refund.',
            },
            type: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description:
                'Type of the refund, one of `refund` or `payment_record_refund`. One of: payment_record_refund, refund.',
            },
          },
        },
        description: 'Refunds related to this credit note.',
      },
      shipping_cost: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount_subtotal: {
                type: 'integer',
                description: 'Total shipping cost before any taxes are applied.',
              },
              amount_tax: {
                type: 'integer',
                description: 'Total tax amount applied due to shipping costs.',
              },
              amount_total: {
                type: 'integer',
                description: 'Total shipping cost after taxes are applied.',
              },
              shipping_rate: {
                anyOf: [
                  {
                    type: 'string',
                    'x-stripe-expandable-resources': ['shipping_rate'],
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the ShippingRate for this invoice.',
              },
              taxes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    amount: {
                      type: 'integer',
                      description: 'Amount of tax applied for this rate.',
                    },
                    rate: {
                      type: 'object',
                      description:
                        'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
                    },
                    taxability_reason: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The reasoning behind this tax, for example, if the product is tax exempt. One of: customer_exempt, not_collecting, not_subject_to_tax, not_supported, portion_product_exempt, portion_reduced_rated, portion_standard_rated, product_exempt, product_exempt_holiday, proportionally_rated, reduced_rated, reverse_charge, standard_rated, taxable_basis_reduced, zero_rated.',
                    },
                    taxable_amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The amount on which tax is calculated, in cents (or local equivalent).',
                    },
                  },
                },
                description: 'The taxes applied to the shipping rate.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The details of the cost of shipping, including the ShippingRate applied to the invoice.',
      },
      status: {
        type: 'string',
        description: 'Status of this credit note, one of `issued` or `void`. One of: issued, void.',
      },
      subtotal: {
        type: 'integer',
        description:
          'The integer amount in cents (or local equivalent) representing the amount of the credit note, excluding exclusive tax and invoice level discounts.',
      },
      subtotal_excluding_tax: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The integer amount in cents (or local equivalent) representing the amount of the credit note, excluding all tax and invoice level discounts.',
      },
      total: {
        type: 'integer',
        description:
          'The integer amount in cents (or local equivalent) representing the total amount of the credit note, including tax and all discount.',
      },
      total_excluding_tax: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The integer amount in cents (or local equivalent) representing the total amount of the credit note, excluding tax, but including discounts.',
      },
      total_taxes: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                amount: {
                  type: 'integer',
                  description: 'The amount of the tax, in cents (or local equivalent).',
                },
                tax_behavior: {
                  type: 'string',
                  description: 'Whether this tax is inclusive or exclusive. One of: exclusive, inclusive.',
                },
                tax_rate_details: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        tax_rate: {
                          type: 'string',
                          'x-stripe-expandable-resources': ['tax_rate'],
                          description: 'ID of the tax rate',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Additional details about the tax rate.',
                },
                taxability_reason: {
                  type: 'string',
                  description: 'The reasoning behind this tax, for example, if the product is tax exempt.',
                },
                taxable_amount: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The amount on which tax is calculated, in cents (or local equivalent).',
                },
                type: {
                  type: 'string',
                  description: 'The type of tax information. One of: tax_rate_details.',
                },
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The aggregate tax information for all line items.',
      },
      type: {
        type: 'string',
        description:
          'Type of this credit note, one of `pre_payment` or `post_payment`. One of: mixed, post_payment, pre_payment.',
      },
      voided_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'The time that the credit note was voided.',
      },
    },
    description: "Issue a credit note to adjust an invoice's amount after the invoice is finalized.",
  },
  coupon: {
    type: 'object',
    properties: {
      amount_off: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Amount (in the `currency` specified) that will be taken off the subtotal of any invoices for this customer.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'If `amount_off` has been set, the three-letter ISO code for the currency of the amount to take off.',
      },
      duration: {
        type: 'string',
        description: 'One of `forever`, `once`, or `repeating`. One of: forever, once, repeating.',
      },
      duration_in_months: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description: 'If `duration` is `repeating`, the number of months the coupon applies.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      max_redemptions: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Maximum number of times this coupon can be redeemed, in total, across all customers, before it is no longer valid.',
      },
      metadata: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Name of the coupon displayed to customers on for instance invoices or receipts.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: coupon.",
      },
      percent_off: {
        anyOf: [
          {
            type: 'number',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Percent that will be taken off the subtotal of any invoices for this customer for the duration of the coupon.',
      },
      redeem_by: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'Date after which the coupon can no longer be redeemed.',
      },
      times_redeemed: {
        type: 'integer',
        description: 'Number of times this coupon has been applied to a customer.',
      },
      valid: {
        type: 'boolean',
        description: 'Taking account of the above properties, whether this coupon can still be applied to a customer.',
      },
    },
    description:
      'A coupon contains information about a percent-off or amount-off discount you might want to apply to a customer.',
  },
  promotion_code: {
    type: 'object',
    properties: {
      active: {
        type: 'boolean',
        description: 'Whether the promotion code is currently active.',
      },
      code: {
        type: 'string',
        description: 'The customer-facing code.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      customer: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
          },
          {
            type: 'null',
          },
        ],
        description: 'The customer who can use this promotion code.',
      },
      customer_account: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The account representing the customer who can use this promotion code.',
      },
      expires_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'Date at which the promotion code can no longer be redeemed.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      max_redemptions: {
        anyOf: [
          {
            type: 'integer',
          },
          {
            type: 'null',
          },
        ],
        description: 'Maximum number of times this promotion code can be redeemed.',
      },
      metadata: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: promotion_code.",
      },
      promotion: {
        type: 'object',
        properties: {
          coupon: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['coupon'],
              },
              {
                type: 'null',
              },
            ],
            description: 'If promotion `type` is `coupon`, the coupon for this promotion.',
          },
          type: {
            type: 'string',
            description: 'The type of promotion. One of: coupon.',
          },
        },
      },
      restrictions: {
        type: 'object',
        properties: {
          currency_options: {
            type: 'object',
            additionalProperties: {
              type: 'object',
            },
            description: 'Promotion code restrictions defined in each available currency option.',
          },
          first_time_transaction: {
            type: 'boolean',
            description:
              'A Boolean indicating if the Promotion Code should only be redeemed for Customers without any successful payments or invoices',
          },
          minimum_amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description:
              'Minimum amount required to redeem this Promotion Code into a Coupon (e.g., a purchase must be $100 or more to work).',
          },
          minimum_amount_currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Three-letter ISO code for minimum_amount',
          },
        },
      },
      times_redeemed: {
        type: 'integer',
        description: 'Number of times this promotion code has been used.',
      },
    },
    description: 'A Promotion Code represents a customer-redeemable code for an underlying promotion.',
  },
  balance_transaction: {
    type: 'object',
    properties: {
      amount: {
        type: 'integer',
        description: 'Gross amount of this transaction (in cents (or local equivalent)).',
      },
      available_on: {
        type: 'integer',
        format: 'unix-time',
        description: "The date that the transaction's net funds become available in the Stripe balance.",
      },
      balance_type: {
        type: 'string',
        description:
          'The balance that this transaction impacts. One of: issuing, payments, refund_and_dispute_prefunding, risk_reserved.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      currency: {
        type: 'string',
        description: 'Three-letter ISO currency code, in lowercase.',
      },
      description: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'An arbitrary string attached to the object.',
      },
      exchange_rate: {
        anyOf: [
          {
            type: 'number',
          },
          {
            type: 'null',
          },
        ],
        description: 'If applicable, this transaction uses an exchange rate.',
      },
      fee: {
        type: 'integer',
        description: 'Fees (in cents (or local equivalent)) paid for this transaction.',
      },
      fee_details: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            amount: {
              type: 'integer',
              description: 'Amount of the fee, in cents.',
            },
            application: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'ID of the Connect application that earned the fee.',
            },
            currency: {
              type: 'string',
              description: 'Three-letter ISO currency code, in lowercase.',
            },
            description: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'An arbitrary string attached to the object.',
            },
            type: {
              type: 'string',
              description:
                'Type of the fee, one of: `application_fee`, `payment_method_passthrough_fee`, `stripe_fee`, `tax`, or `withheld_tax`.',
            },
          },
        },
        description: 'Detailed breakdown of fees (in cents (or local equivalent)) paid for this transaction.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      net: {
        type: 'integer',
        description: 'Net impact to a Stripe balance (in cents (or local equivalent)).',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: balance_transaction.",
      },
      reporting_category: {
        type: 'string',
        description:
          'Learn more about how reporting categories can help you understand balance transactions from an accounting perspective.',
      },
      source: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': [
              'application_fee',
              'charge',
              'connect_collection_transfer',
              'customer_cash_balance_transaction',
              'dispute',
              'fee_refund',
              'issuing.authorization',
              'issuing.dispute',
              'issuing.transaction',
              'payout',
              'refund',
              'reserve_transaction',
              'tax_deducted_at_source',
              'topup',
              'transfer',
              'transfer_reversal',
            ],
          },
          {
            type: 'null',
          },
        ],
        description: 'This transaction relates to the Stripe object.',
      },
      status: {
        type: 'string',
        description:
          "The transaction's net funds status in the Stripe balance, which are either `available` or `pending`.",
      },
      type: {
        type: 'string',
        description:
          'Transaction type: `tax_fund`, `adjustment`, `advance`, `advance_funding`, `anticipation_repayment`, `application_fee`, `application_fee_refund`, `charge`, `climate_order_purchase`, `climate_order_ref…',
      },
    },
    description: 'Balance transactions represent funds moving through your Stripe account.',
  },
  subscription_schedule: {
    type: 'object',
    properties: {
      application: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['application', 'deleted_application'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the Connect Application that created the schedule.',
      },
      billing_mode: {
        type: 'object',
        properties: {
          flexible: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  proration_discounts: {
                    type: 'string',
                    description:
                      'Controls how invoices and invoice items display proration amounts and discount amounts. One of: included, itemized.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Configure behavior for flexible billing mode',
          },
          type: {
            type: 'string',
            description:
              'Controls how prorations and invoices for subscriptions are calculated and orchestrated. One of: classic, flexible.',
          },
          updated_at: {
            type: 'integer',
            format: 'unix-time',
            description: 'Details on when the current billing_mode was adopted.',
          },
        },
        description: 'The billing mode of the subscription.',
      },
      canceled_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'Time at which the subscription schedule was canceled.',
      },
      completed_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'Time at which the subscription schedule was completed.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      current_phase: {
        anyOf: [
          {
            type: 'object',
            properties: {
              end_date: {
                type: 'integer',
                format: 'unix-time',
                description: 'The end of this phase of the subscription schedule.',
              },
              start_date: {
                type: 'integer',
                format: 'unix-time',
                description: 'The start of this phase of the subscription schedule.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Object representing the start and end dates for the current phase of the subscription schedule, if it is `active`.',
      },
      customer: {
        type: 'string',
        'x-stripe-expandable-resources': ['customer', 'deleted_customer'],
        description: 'ID of the customer who owns the subscription schedule.',
      },
      customer_account: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the account who owns the subscription schedule.',
      },
      default_settings: {
        type: 'object',
        properties: {
          application_fee_percent: {
            anyOf: [
              {
                type: 'number',
              },
              {
                type: 'null',
              },
            ],
            description: 'A non-negative decimal between 0 and 100, with at most two decimal places.',
          },
          automatic_tax: {
            type: 'object',
            properties: {
              disabled_reason: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If Stripe disabled automatic tax, this enum describes why. One of: requires_location_inputs.',
              },
              enabled: {
                type: 'boolean',
                description: 'Whether Stripe automatically computes tax on invoices created during this phase.',
              },
              liability: {
                anyOf: [
                  {
                    type: 'object',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The account that's liable for tax.",
              },
            },
          },
          billing_cycle_anchor: {
            type: 'string',
            description: 'Possible values are `phase_start` or `automatic`. One of: automatic, phase_start.',
          },
          billing_thresholds: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount_gte: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Monetary threshold that triggers the subscription to create an invoice',
                  },
                  reset_billing_cycle_anchor: {
                    anyOf: [
                      {
                        type: 'boolean',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Indicates if the `billing_cycle_anchor` should be reset when a threshold is reached.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description:
              'Define thresholds at which an invoice will be sent, and the subscription advanced to a new billing period',
          },
          collection_method: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'Either `charge_automatically`, or `send_invoice`. One of: charge_automatically, send_invoice.',
          },
          default_payment_method: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['payment_method'],
              },
              {
                type: 'null',
              },
            ],
            description: 'ID of the default payment method for the subscription schedule.',
          },
          description: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Subscription description, meant to be displayable to the customer.',
          },
          invoice_settings: {
            type: 'object',
            properties: {
              account_tax_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                      'x-stripe-expandable-resources': ['tax_id', 'deleted_tax_id'],
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The account tax IDs associated with the subscription schedule.',
              },
              custom_fields: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A list of up to 4 custom fields to be displayed on the invoice.',
              },
              days_until_due: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Number of days within which a customer must pay invoices generated by this subscription schedule.',
              },
              description: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'An arbitrary string attached to the object.',
              },
              footer: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Footer to be displayed on the invoice.',
              },
              issuer: {
                type: 'object',
              },
            },
          },
          on_behalf_of: {
            anyOf: [
              {
                type: 'string',
                'x-stripe-expandable-resources': ['account'],
              },
              {
                type: 'null',
              },
            ],
            description:
              "The account (if any) the charge was made on behalf of for charges associated with the schedule's subscription.",
          },
          transfer_data: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount_percent: {
                    anyOf: [
                      {
                        type: 'number',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'A non-negative decimal between 0 and 100, with at most two decimal places.',
                  },
                  destination: {
                    type: 'string',
                    'x-stripe-expandable-resources': ['account'],
                    description:
                      'The account where funds from the payment will be transferred to upon payment success.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description:
              "The account (if any) the associated subscription's payments will be attributed to for tax reporting, and where funds from each payment will be transferred to for each of the subscription's invoices.",
          },
        },
      },
      end_behavior: {
        type: 'string',
        description:
          'Behavior of the subscription schedule and underlying subscription when it ends. One of: cancel, none, release, renew.',
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      metadata: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Set of key-value pairs that you can attach to an object.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: subscription_schedule.",
      },
      phases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            add_invoice_items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  discountable: {
                    anyOf: [
                      {
                        type: 'boolean',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Controls whether discounts apply to this invoice item.',
                  },
                  discounts: {
                    type: 'array',
                    items: {
                      type: 'object',
                    },
                    description: 'The stackable discounts that will be applied to the item.',
                  },
                  metadata: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Set of key-value pairs that you can attach to an object.',
                  },
                  period: {
                    type: 'object',
                  },
                  price: {
                    type: 'string',
                    'x-stripe-expandable-resources': ['price', 'deleted_price'],
                    description: 'ID of the price used to generate the invoice item.',
                  },
                  quantity: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The quantity of the invoice item.',
                  },
                  tax_rates: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'object',
                          description:
                            'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The tax rates which apply to the item.',
                  },
                },
                description:
                  'An Add Invoice Item describes the prices and quantities that will be added as pending invoice items when entering a phase.',
              },
              description:
                'A list of prices and quantities that will generate invoice items appended to the next invoice for this phase.',
            },
            application_fee_percent: {
              anyOf: [
                {
                  type: 'number',
                },
                {
                  type: 'null',
                },
              ],
              description: 'A non-negative decimal between 0 and 100, with at most two decimal places.',
            },
            automatic_tax: {
              type: 'object',
              properties: {
                disabled_reason: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'If Stripe disabled automatic tax, this enum describes why. One of: requires_location_inputs.',
                },
                enabled: {
                  type: 'boolean',
                  description: 'Whether Stripe automatically computes tax on invoices created during this phase.',
                },
                liability: {
                  anyOf: [
                    {
                      type: 'object',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: "The account that's liable for tax.",
                },
              },
            },
            billing_cycle_anchor: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'Possible values are `phase_start` or `automatic`. One of: automatic, phase_start.',
            },
            billing_thresholds: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    amount_gte: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'Monetary threshold that triggers the subscription to create an invoice',
                    },
                    reset_billing_cycle_anchor: {
                      anyOf: [
                        {
                          type: 'boolean',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'Indicates if the `billing_cycle_anchor` should be reset when a threshold is reached.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description:
                'Define thresholds at which an invoice will be sent, and the subscription advanced to a new billing period',
            },
            collection_method: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description:
                'Either `charge_automatically`, or `send_invoice`. One of: charge_automatically, send_invoice.',
            },
            currency: {
              type: 'string',
              description: 'Three-letter ISO currency code, in lowercase.',
            },
            default_payment_method: {
              anyOf: [
                {
                  type: 'string',
                  'x-stripe-expandable-resources': ['payment_method'],
                },
                {
                  type: 'null',
                },
              ],
              description: 'ID of the default payment method for the subscription schedule.',
            },
            default_tax_rates: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      active: {
                        type: 'boolean',
                        description: 'Defaults to `true`.',
                      },
                      country: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Two-letter country code (ISO 3166-1 alpha-2).',
                      },
                      created: {
                        type: 'integer',
                        format: 'unix-time',
                        description: 'Time at which the object was created.',
                      },
                      description: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'An arbitrary string attached to the tax rate for your internal use only.',
                      },
                      display_name: {
                        type: 'string',
                        description:
                          'The display name of the tax rates as it will appear to your customer on their receipt email, PDF, and the hosted invoice page.',
                      },
                      effective_percentage: {
                        anyOf: [
                          {
                            type: 'number',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Actual/effective tax rate percentage out of 100.',
                      },
                      flat_amount: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The amount of the tax rate when the `rate_type` is `flat_amount`.',
                      },
                      id: {
                        type: 'string',
                        description: 'Unique identifier for the object.',
                      },
                      inclusive: {
                        type: 'boolean',
                        description: 'This specifies if the tax rate is inclusive or exclusive.',
                      },
                      jurisdiction: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The jurisdiction for the tax rate.',
                      },
                      jurisdiction_level: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The level of the jurisdiction that imposes this tax rate. One of: city, country, county, district, multiple, state.',
                      },
                      livemode: {
                        type: 'boolean',
                        description: 'If the object exists in live mode, the value is `true`.',
                      },
                      metadata: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Set of key-value pairs that you can attach to an object.',
                      },
                      object: {
                        type: 'string',
                        description: "String representing the object's type. One of: tax_rate.",
                      },
                      percentage: {
                        type: 'number',
                        description: 'Tax rate percentage out of 100.',
                      },
                      rate_type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Indicates the type of tax rate applied to the taxable amount. One of: flat_amount, percentage.',
                      },
                      state: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'ISO 3166-2 subdivision code, without country prefix.',
                      },
                      tax_type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The high-level tax type, such as `vat` or `sales_tax`.',
                      },
                    },
                    description:
                      'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description:
                'The default tax rates to apply to the subscription during this phase of the subscription schedule.',
            },
            description: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'Subscription description, meant to be displayable to the customer.',
            },
            discounts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  coupon: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['coupon'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the coupon to create a new discount for.',
                  },
                  discount: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['discount'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of an existing discount on the object (or one of its ancestors) to reuse.',
                  },
                  promotion_code: {
                    anyOf: [
                      {
                        type: 'string',
                        'x-stripe-expandable-resources': ['promotion_code'],
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'ID of the promotion code to create a new discount for.',
                  },
                },
              },
              description: 'The stackable discounts that will be applied to the subscription on this phase.',
            },
            end_date: {
              type: 'integer',
              format: 'unix-time',
              description: 'The end of this phase of the subscription schedule.',
            },
            invoice_settings: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    account_tax_ids: {
                      anyOf: [
                        {
                          type: 'array',
                          items: {
                            type: 'string',
                            'x-stripe-expandable-resources': ['tax_id', 'deleted_tax_id'],
                          },
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The account tax IDs associated with this phase of the subscription schedule.',
                    },
                    custom_fields: {
                      anyOf: [
                        {
                          type: 'array',
                          items: {
                            type: 'object',
                          },
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'A list of up to 4 custom fields to be displayed on the invoice.',
                    },
                    days_until_due: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'Number of days within which a customer must pay invoices generated by this subscription schedule.',
                    },
                    description: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'An arbitrary string attached to the object.',
                    },
                    footer: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'Footer to be displayed on the invoice.',
                    },
                    issuer: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The connected account that issues the invoice.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The invoice settings applicable during this phase.',
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  billing_thresholds: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'Define thresholds at which an invoice will be sent, and the related subscription advanced to a new billing period',
                  },
                  discounts: {
                    type: 'array',
                    items: {
                      type: 'object',
                    },
                    description: 'The discounts applied to the subscription item.',
                  },
                  metadata: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Set of key-value pairs that you can attach to an item.',
                  },
                  price: {
                    type: 'string',
                    'x-stripe-expandable-resources': ['price', 'deleted_price'],
                    description: 'ID of the price to which the customer should be subscribed.',
                  },
                  quantity: {
                    type: 'integer',
                    description: 'Quantity of the plan to which the customer should be subscribed.',
                  },
                  tax_rates: {
                    anyOf: [
                      {
                        type: 'array',
                        items: {
                          type: 'object',
                          description:
                            'Tax rates can be applied to invoices, subscriptions and Checkout Sessions to collect tax.',
                        },
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The tax rates which apply to this `phase_item`.',
                  },
                },
                description: 'A phase item describes the price and quantity of a phase.',
              },
              description:
                'Subscription items to configure the subscription to during this phase of the subscription schedule.',
            },
            metadata: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: {
                    type: 'string',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'Set of key-value pairs that you can attach to a phase.',
            },
            on_behalf_of: {
              anyOf: [
                {
                  type: 'string',
                  'x-stripe-expandable-resources': ['account'],
                },
                {
                  type: 'null',
                },
              ],
              description:
                "The account (if any) the charge was made on behalf of for charges associated with the schedule's subscription.",
            },
            proration_behavior: {
              type: 'string',
              description:
                'When transitioning phases, controls how prorations are handled (if any). One of: always_invoice, create_prorations, none.',
            },
            start_date: {
              type: 'integer',
              format: 'unix-time',
              description: 'The start of this phase of the subscription schedule.',
            },
            transfer_data: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    amount_percent: {
                      anyOf: [
                        {
                          type: 'number',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'A non-negative decimal between 0 and 100, with at most two decimal places.',
                    },
                    destination: {
                      type: 'string',
                      'x-stripe-expandable-resources': ['account'],
                      description:
                        'The account where funds from the payment will be transferred to upon payment success.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description:
                "The account (if any) the associated subscription's payments will be attributed to for tax reporting, and where funds from each payment will be transferred to for each of the subscription's invoices.",
            },
            trial: {
              type: 'boolean',
              description:
                'If set to true the entire phase is counted as a trial and the customer will not be charged for any fees.',
            },
            trial_end: {
              anyOf: [
                {
                  type: 'integer',
                  format: 'unix-time',
                },
                {
                  type: 'null',
                },
              ],
              description: 'When the trial ends within the phase.',
            },
          },
          description:
            'A phase describes the plans, coupon, and trialing status of a subscription for a predefined time period.',
        },
        description: "Configuration for the subscription schedule's phases.",
      },
      released_at: {
        anyOf: [
          {
            type: 'integer',
            format: 'unix-time',
          },
          {
            type: 'null',
          },
        ],
        description: 'Time at which the subscription schedule was released.',
      },
      released_subscription: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the subscription once managed by the subscription schedule (if it is released).',
      },
      status: {
        type: 'string',
        description:
          'The present status of the subscription schedule. One of: active, canceled, completed, not_started, released.',
      },
      subscription: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['subscription'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the subscription managed by the subscription schedule.',
      },
      test_clock: {
        anyOf: [
          {
            type: 'string',
            'x-stripe-expandable-resources': ['test_helpers.test_clock'],
          },
          {
            type: 'null',
          },
        ],
        description: 'ID of the test clock this subscription schedule belongs to.',
      },
    },
    description:
      'A subscription schedule allows you to create and manage the lifecycle of a subscription by predefining expected changes.',
  },
  event: {
    type: 'object',
    properties: {
      account: {
        type: 'string',
        description: 'The connected account that originates the event.',
      },
      api_version: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The Stripe API version used to render `data` when the event was created.',
      },
      context: {
        type: 'string',
        description: 'Authentication context needed to fetch the event or related object.',
      },
      created: {
        type: 'integer',
        format: 'unix-time',
        description: 'Time at which the object was created.',
      },
      data: {
        type: 'object',
        properties: {
          object: {
            type: 'object',
            properties: {},
            additionalProperties: true,
            description: 'Object containing the API resource relevant to the event.',
          },
          previous_attributes: {
            type: 'object',
            properties: {},
            additionalProperties: true,
            description:
              'Object containing the names of the updated attributes and their values prior to the event (only included in events of type `*.updated`).',
          },
        },
      },
      id: {
        type: 'string',
        description: 'Unique identifier for the object.',
      },
      livemode: {
        type: 'boolean',
        description: 'If the object exists in live mode, the value is `true`.',
      },
      object: {
        type: 'string',
        description: "String representing the object's type. One of: event.",
      },
      pending_webhooks: {
        type: 'integer',
        description:
          "Number of webhooks that haven't been successfully delivered (for example, to return a 20x response) to the URLs you specify.",
      },
      request: {
        anyOf: [
          {
            type: 'object',
            properties: {
              id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'ID of the API request that caused the event.',
              },
              idempotency_key: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The idempotency key transmitted during the request, if any.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Information on the API request that triggers the event.',
      },
      type: {
        type: 'string',
        description: 'Description of the event (for example, `invoice.created` or `charge.refunded`).',
      },
    },
    description: 'Snapshot events allow you to track and react to activity in your Stripe integration.',
  },
};
