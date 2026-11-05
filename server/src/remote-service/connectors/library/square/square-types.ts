/**
 * Types and per-entity configuration for the Square connector.
 *
 * Square has no schema-introspection endpoint, so every record shape comes from Square's published
 * OpenAPI spec (vendored in `square-entity-schemas.generated.ts`) and every table here is a fixed
 * Square object type. The connector is read-only: it exists to pull Square data into Scratch (and
 * through Live Export into a destination such as Supabase).
 *
 * API reference: https://developer.squareup.com/reference/square
 */
import type { ConnectorAuthTokenOrProvider } from '../../connector-auth-token';
import { SquareObjectName } from './square-entity-schemas.generated';

/** Which Square environment an access token belongs to. Sandbox tokens are rejected by production and vice versa. */
export type SquareEnvironment = 'production' | 'sandbox';

/** The API host of each environment. OAuth sign-in and token requests go to the same host. */
export const SQUARE_API_BASE_URL_BY_ENVIRONMENT: Record<SquareEnvironment, string> = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};

/**
 * Which environment a Square application id belongs to. Square gives an application one id per environment, and
 * the sandbox one always starts with `sandbox-` (`sandbox-sq0idb-…`), so an OAuth app's id is enough to tell where
 * its sign-in, its tokens, and the connections made with it live.
 */
export function squareEnvironmentForOAuthApplicationId(oauthApplicationId: string): SquareEnvironment {
  return oauthApplicationId.startsWith('sandbox-') ? 'sandbox' : 'production';
}

export const SQUARE_DASHBOARD_BASE_URL_BY_ENVIRONMENT: Record<SquareEnvironment, string> = {
  production: 'https://app.squareup.com/dashboard',
  sandbox: 'https://app.squareupsandbox.com/dashboard',
};

/** Normalize the stored environment value, defaulting to production for anything unrecognized. */
export function normalizeSquareEnvironment(storedEnvironmentValue: string | undefined): SquareEnvironment {
  return storedEnvironmentValue === 'sandbox' ? 'sandbox' : 'production';
}

export interface SquareCredentials {
  /**
   * What every request sends as its Bearer token: either a pasted personal access token from the Developer
   * Dashboard, or the OAuth access token of Whalesync's Square app. The OAuth token comes as a provider, re-read on
   * each request, so a refresh during a long pull is picked up.
   */
  accessToken: ConnectorAuthTokenOrProvider;
  environment: SquareEnvironment;
}

/**
 * The OAuth permissions the connector reads with. Each table declares the one its endpoints need
 * ({@link SquareEntityConfig.oauthReadScope}).
 *
 * https://developer.squareup.com/docs/oauth-api/square-permissions
 */
export type SquareOAuthReadScope =
  | 'MERCHANT_PROFILE_READ'
  | 'CUSTOMERS_READ'
  | 'ITEMS_READ'
  | 'ORDERS_READ'
  | 'PAYMENTS_READ'
  | 'INVOICES_READ'
  | 'EMPLOYEES_READ'
  | 'PAYOUTS_READ'
  | 'GIFTCARDS_READ'
  | 'SUBSCRIPTIONS_READ';

/** The tables the Square connector exposes. Values are the Scratch table ids (`EntityId.wsId`). */
export type SquareEntityType =
  | 'locations'
  | 'customers'
  | 'catalog_items'
  | 'catalog_item_variations'
  | 'catalog_categories'
  | 'catalog_modifier_lists'
  | 'catalog_taxes'
  | 'catalog_discounts'
  | 'orders'
  | 'payments'
  | 'refunds'
  | 'invoices'
  | 'team_members'
  | 'payouts'
  | 'payout_entries'
  | 'gift_cards'
  | 'gift_card_activities'
  | 'subscriptions';

/**
 * How a table's records are listed. Each strategy mirrors a quirk of the Square endpoint behind it:
 *
 * - `single-request`: one call returns everything (ListLocations has no pagination).
 * - `cursor`: a plain GET walked by `cursor`.
 * - `cursor-per-location`: a GET that only covers ONE location per call — ListPayments and
 *   ListPayouts default to the seller's *main* location, and ListInvoices requires `location_id` —
 *   so a full pull walks every location in turn.
 * - `cursor-per-payout`: a GET that only covers ONE payout per call (ListPayoutEntries takes the
 *   payout id in its path), so a full pull lists every payout first and then walks each in turn,
 *   oldest first.
 * - `orders-search`: SearchOrders requires `location_ids`, at most 10 per request, so a full pull
 *   walks the locations in batches of 10.
 * - `cursor-search`: a search POST sent with no query, which Square answers with every record of
 *   every status at every location, walked by `cursor` (SearchTeamMembers, SearchSubscriptions).
 */
export type SquareListingStrategy =
  | 'single-request'
  | 'cursor'
  | 'cursor-per-location'
  | 'cursor-per-payout'
  | 'orders-search'
  | 'cursor-search';

export interface SquareEntityConfig {
  displayName: string;
  description: string;
  /** Square's name for the object, which keys its schema in the generated schema file. */
  squareObjectName: SquareObjectName;
  /** The OAuth permission this table's list and retrieve endpoints need. */
  oauthReadScope: SquareOAuthReadScope;
  /** For catalog tables: the CatalogObject `type` this table holds, e.g. `ITEM`. */
  catalogObjectType?: string;
  /** For catalog tables: the one `<type>_data` property a CatalogObject of this type carries. */
  catalogTypeDataPropertyName?: string;
  listingStrategy: SquareListingStrategy;
  /** The list (or search) endpoint path. For `cursor-per-payout`, it holds a `{payout_id}` placeholder. */
  listEndpointPath: string;
  /** The key the list response carries its page of records under, e.g. `payments`. */
  listResponseRecordsKey: string;
  /** Extra query params a full pull needs so Square doesn't silently omit records. */
  listQueryParams?: Record<string, string | number>;
  /**
   * The endpoint that fetches one record, `{id}` substituted, and the key its response carries the
   * record under (e.g. `payment`). Absent when Square has no such endpoint (payout entries, gift card
   * activities): those tables can only be pulled whole.
   */
  retrieveOneRecord?: { endpointPathTemplate: string; responseRecordKey: string };
  /** Dot path of the record's human-readable title. */
  titlePath: string;
  /** Dot path used to suggest record file names (falls back to the id). */
  slugPath: string;
  /** Path under the Square Dashboard listing these records, when we know one. */
  dashboardPath?: string;
}

/**
 * The earliest `begin_time` we ask for on the endpoints that default to "the last year only"
 * (ListPayments, ListRefunds, ListPayouts, ListGiftCardActivities). Square was founded in 2009, so nothing predates it; an
 * explicit early bound is what turns "the last 12 months" into the full history.
 */
export const SQUARE_FULL_HISTORY_BEGIN_TIME = '2009-01-01T00:00:00Z';

/**
 * The `end_time` sent alongside {@link SQUARE_FULL_HISTORY_BEGIN_TIME} where Square refuses a `begin_time` on its own.
 * ListGiftCardActivities answers "Time range provided is not valid" (HTTP 400) unless it gets both or neither, and
 * neither means the last year only. The value is fixed rather than "now" so a resumed pull sends the same query its
 * saved cursor came from.
 */
export const SQUARE_FULL_HISTORY_END_TIME = '2100-01-01T00:00:00Z';

/** SearchOrders accepts at most 10 location ids per request. */
export const SQUARE_ORDERS_SEARCH_MAX_LOCATION_IDS = 10;

/**
 * Every order state, passed explicitly so a full pull can't depend on which states SearchOrders
 * happens to include when no state filter is given.
 */
export const SQUARE_ALL_ORDER_STATES = ['OPEN', 'COMPLETED', 'CANCELED', 'DRAFT'];

function catalogEntityConfig(params: {
  displayName: string;
  description: string;
  catalogObjectType: string;
  catalogTypeDataPropertyName: string;
  slugPath?: string;
}): SquareEntityConfig {
  return {
    displayName: params.displayName,
    description: params.description,
    squareObjectName: 'CatalogObject',
    oauthReadScope: 'ITEMS_READ',
    catalogObjectType: params.catalogObjectType,
    catalogTypeDataPropertyName: params.catalogTypeDataPropertyName,
    listingStrategy: 'cursor',
    listEndpointPath: '/v2/catalog/list',
    listResponseRecordsKey: 'objects',
    listQueryParams: { types: params.catalogObjectType },
    retrieveOneRecord: { endpointPathTemplate: '/v2/catalog/object/{id}', responseRecordKey: 'object' },
    titlePath: `${params.catalogTypeDataPropertyName}.name`,
    slugPath: params.slugPath ?? `${params.catalogTypeDataPropertyName}.name`,
    dashboardPath: 'items/library',
  };
}

export const SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE: Record<SquareEntityType, SquareEntityConfig> = {
  locations: {
    displayName: 'Locations',
    description: 'Business locations, including inactive ones',
    squareObjectName: 'Location',
    oauthReadScope: 'MERCHANT_PROFILE_READ',
    listingStrategy: 'single-request',
    listEndpointPath: '/v2/locations',
    listResponseRecordsKey: 'locations',
    retrieveOneRecord: { endpointPathTemplate: '/v2/locations/{id}', responseRecordKey: 'location' },
    titlePath: 'name',
    slugPath: 'name',
  },
  customers: {
    displayName: 'Customers',
    description: 'Customer profiles in the customer directory',
    squareObjectName: 'Customer',
    oauthReadScope: 'CUSTOMERS_READ',
    listingStrategy: 'cursor',
    listEndpointPath: '/v2/customers',
    listResponseRecordsKey: 'customers',
    listQueryParams: { limit: 100 },
    retrieveOneRecord: { endpointPathTemplate: '/v2/customers/{id}', responseRecordKey: 'customer' },
    titlePath: 'given_name',
    slugPath: 'given_name',
    dashboardPath: 'customers/directory',
  },
  catalog_items: catalogEntityConfig({
    displayName: 'Catalog Items',
    description: 'Items for sale (products and services), with their variations embedded',
    catalogObjectType: 'ITEM',
    catalogTypeDataPropertyName: 'item_data',
  }),
  catalog_item_variations: catalogEntityConfig({
    displayName: 'Catalog Item Variations',
    description: 'The sellable variations of each item — what an order line item references',
    catalogObjectType: 'ITEM_VARIATION',
    catalogTypeDataPropertyName: 'item_variation_data',
    // Variation names repeat across items ("Regular", "Large"), so they make poor file names.
    slugPath: 'id',
  }),
  catalog_categories: catalogEntityConfig({
    displayName: 'Catalog Categories',
    description: 'Categories that group catalog items',
    catalogObjectType: 'CATEGORY',
    catalogTypeDataPropertyName: 'category_data',
  }),
  catalog_modifier_lists: catalogEntityConfig({
    displayName: 'Catalog Modifier Lists',
    description: 'Modifier lists (e.g. toppings, sizes) with their modifiers embedded',
    catalogObjectType: 'MODIFIER_LIST',
    catalogTypeDataPropertyName: 'modifier_list_data',
  }),
  catalog_taxes: catalogEntityConfig({
    displayName: 'Catalog Taxes',
    description: 'Taxes applied to catalog items',
    catalogObjectType: 'TAX',
    catalogTypeDataPropertyName: 'tax_data',
  }),
  catalog_discounts: catalogEntityConfig({
    displayName: 'Catalog Discounts',
    description: 'Discounts defined in the catalog',
    catalogObjectType: 'DISCOUNT',
    catalogTypeDataPropertyName: 'discount_data',
  }),
  orders: {
    displayName: 'Orders',
    description: 'Orders from every channel (Point of Sale, online, invoices), in every state',
    squareObjectName: 'Order',
    oauthReadScope: 'ORDERS_READ',
    listingStrategy: 'orders-search',
    listEndpointPath: '/v2/orders/search',
    listResponseRecordsKey: 'orders',
    retrieveOneRecord: { endpointPathTemplate: '/v2/orders/{id}', responseRecordKey: 'order' },
    titlePath: 'id',
    slugPath: 'id',
    dashboardPath: 'orders/overview',
  },
  payments: {
    displayName: 'Payments',
    description: 'Payments taken at every location, across the full history',
    squareObjectName: 'Payment',
    oauthReadScope: 'PAYMENTS_READ',
    listingStrategy: 'cursor-per-location',
    listEndpointPath: '/v2/payments',
    listResponseRecordsKey: 'payments',
    listQueryParams: { begin_time: SQUARE_FULL_HISTORY_BEGIN_TIME, sort_order: 'ASC', limit: 100 },
    retrieveOneRecord: { endpointPathTemplate: '/v2/payments/{id}', responseRecordKey: 'payment' },
    titlePath: 'id',
    slugPath: 'id',
    dashboardPath: 'sales/transactions',
  },
  refunds: {
    displayName: 'Refunds',
    description: 'Refunds of payments, across the full history',
    squareObjectName: 'PaymentRefund',
    oauthReadScope: 'PAYMENTS_READ',
    // Unlike payments, ListRefunds already covers every location by default.
    listingStrategy: 'cursor',
    listEndpointPath: '/v2/refunds',
    listResponseRecordsKey: 'refunds',
    listQueryParams: { begin_time: SQUARE_FULL_HISTORY_BEGIN_TIME, sort_order: 'ASC', limit: 100 },
    retrieveOneRecord: { endpointPathTemplate: '/v2/refunds/{id}', responseRecordKey: 'refund' },
    titlePath: 'id',
    slugPath: 'id',
  },
  invoices: {
    displayName: 'Invoices',
    description: 'Invoices sent from every location',
    squareObjectName: 'Invoice',
    oauthReadScope: 'INVOICES_READ',
    listingStrategy: 'cursor-per-location',
    listEndpointPath: '/v2/invoices',
    listResponseRecordsKey: 'invoices',
    listQueryParams: { limit: 200 },
    retrieveOneRecord: { endpointPathTemplate: '/v2/invoices/{id}', responseRecordKey: 'invoice' },
    titlePath: 'invoice_number',
    slugPath: 'invoice_number',
    dashboardPath: 'invoices',
  },
  team_members: {
    displayName: 'Team Members',
    description: 'Team members of every status',
    squareObjectName: 'TeamMember',
    oauthReadScope: 'EMPLOYEES_READ',
    listingStrategy: 'cursor-search',
    listEndpointPath: '/v2/team-members/search',
    listResponseRecordsKey: 'team_members',
    retrieveOneRecord: { endpointPathTemplate: '/v2/team-members/{id}', responseRecordKey: 'team_member' },
    titlePath: 'given_name',
    slugPath: 'given_name',
  },
  payouts: {
    displayName: 'Payouts',
    description: 'Payouts (deposits) to the seller’s bank account from every location, across the full history',
    squareObjectName: 'Payout',
    oauthReadScope: 'PAYOUTS_READ',
    listingStrategy: 'cursor-per-location',
    listEndpointPath: '/v2/payouts',
    listResponseRecordsKey: 'payouts',
    listQueryParams: { begin_time: SQUARE_FULL_HISTORY_BEGIN_TIME, sort_order: 'ASC', limit: 100 },
    retrieveOneRecord: { endpointPathTemplate: '/v2/payouts/{id}', responseRecordKey: 'payout' },
    titlePath: 'id',
    slugPath: 'id',
  },
  payout_entries: {
    displayName: 'Payout Entries',
    description: 'The individual charges, refunds, and fees that make up each payout',
    squareObjectName: 'PayoutEntry',
    oauthReadScope: 'PAYOUTS_READ',
    listingStrategy: 'cursor-per-payout',
    listEndpointPath: '/v2/payouts/{payout_id}/payout-entries',
    listResponseRecordsKey: 'payout_entries',
    listQueryParams: { sort_order: 'ASC', limit: 100 },
    titlePath: 'id',
    slugPath: 'id',
  },
  gift_cards: {
    displayName: 'Gift Cards',
    description: 'Gift cards of every type and state',
    squareObjectName: 'GiftCard',
    oauthReadScope: 'GIFTCARDS_READ',
    listingStrategy: 'cursor',
    listEndpointPath: '/v2/gift-cards',
    listResponseRecordsKey: 'gift_cards',
    listQueryParams: { limit: 200 },
    retrieveOneRecord: { endpointPathTemplate: '/v2/gift-cards/{id}', responseRecordKey: 'gift_card' },
    titlePath: 'gan',
    slugPath: 'id',
  },
  gift_card_activities: {
    displayName: 'Gift Card Activities',
    description: 'Every load, redemption, and adjustment of every gift card, across the full history',
    squareObjectName: 'GiftCardActivity',
    oauthReadScope: 'GIFTCARDS_READ',
    // ListGiftCardActivities covers every location by default, but only the last year unless given a time range.
    listingStrategy: 'cursor',
    listEndpointPath: '/v2/gift-cards/activities',
    listResponseRecordsKey: 'gift_card_activities',
    listQueryParams: {
      begin_time: SQUARE_FULL_HISTORY_BEGIN_TIME,
      end_time: SQUARE_FULL_HISTORY_END_TIME,
      sort_order: 'ASC',
      limit: 100,
    },
    titlePath: 'id',
    slugPath: 'id',
  },
  subscriptions: {
    displayName: 'Subscriptions',
    description: 'Customer subscriptions to subscription plans, in every status',
    squareObjectName: 'Subscription',
    oauthReadScope: 'SUBSCRIPTIONS_READ',
    listingStrategy: 'cursor-search',
    listEndpointPath: '/v2/subscriptions/search',
    listResponseRecordsKey: 'subscriptions',
    retrieveOneRecord: { endpointPathTemplate: '/v2/subscriptions/{id}', responseRecordKey: 'subscription' },
    titlePath: 'id',
    slugPath: 'id',
  },
};

export const SQUARE_ENTITY_TYPES = Object.keys(SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE) as SquareEntityType[];

/**
 * Every permission an OAuth sign-in asks for: each table's read scope, plus MERCHANT_PROFILE_READ, which the
 * connection check (RetrieveMerchant) and the per-location tables' location walk (ListLocations) need whichever
 * tables are pulled.
 */
export const SQUARE_OAUTH_READ_SCOPES: SquareOAuthReadScope[] = [
  ...new Set<SquareOAuthReadScope>([
    'MERCHANT_PROFILE_READ',
    ...SQUARE_ENTITY_TYPES.map((entityType) => SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE[entityType].oauthReadScope),
  ]),
];

export function isSquareEntityType(value: string): value is SquareEntityType {
  return Object.prototype.hasOwnProperty.call(SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE, value);
}

/**
 * Pull progress persisted between pages so a stalled job resumes where it stopped. `locationIndex`
 * is only used by the per-location strategies (for orders it is the first location of the batch),
 * and `payoutIndex` only by the per-payout one.
 */
export interface SquarePullProgress {
  locationIndex?: number;
  /** For `cursor-per-payout`: the position in the payout ids, ordered oldest first. */
  payoutIndex?: number;
  cursor?: string;
  [key: string]: number | string | undefined;
}

/** One Square error, as returned in the `errors` array of any failed response. */
export interface SquareApiErrorEntry {
  category?: string;
  code?: string;
  detail?: string;
  field?: string;
}

/** A Square location as far as the connector needs it to walk location-scoped endpoints. */
export interface SquareLocationSummary {
  id: string;
}
