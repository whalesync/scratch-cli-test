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
  | 'PAYOUTS_READ';

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
  | 'payouts';

/**
 * How a table's records are listed. Each strategy mirrors a quirk of the Square endpoint behind it:
 *
 * - `single-request`: one call returns everything (ListLocations has no pagination).
 * - `cursor`: a plain GET walked by `cursor`.
 * - `cursor-per-location`: a GET that only covers ONE location per call — ListPayments and
 *   ListPayouts default to the seller's *main* location, and ListInvoices requires `location_id` —
 *   so a full pull walks every location in turn.
 * - `orders-search`: SearchOrders requires `location_ids`, at most 10 per request, so a full pull
 *   walks the locations in batches of 10.
 * - `team-members-search`: SearchTeamMembers, a POST walked by `cursor`.
 */
export type SquareListingStrategy =
  | 'single-request'
  | 'cursor'
  | 'cursor-per-location'
  | 'orders-search'
  | 'team-members-search';

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
  /** The list (or search) endpoint path. */
  listEndpointPath: string;
  /** The key the list response carries its page of records under, e.g. `payments`. */
  listResponseRecordsKey: string;
  /** Extra query params a full pull needs so Square doesn't silently omit records. */
  listQueryParams?: Record<string, string | number>;
  /** The retrieve-one endpoint, `{id}` substituted. */
  retrieveEndpointPathTemplate: string;
  /** The key the retrieve response carries its record under, e.g. `payment`. */
  retrieveResponseRecordKey: string;
  /** Dot path of the record's human-readable title. */
  titlePath: string;
  /** Dot path used to suggest record file names (falls back to the id). */
  slugPath: string;
  /** Path under the Square Dashboard listing these records, when we know one. */
  dashboardPath?: string;
}

/**
 * The earliest `begin_time` we ask for on the endpoints that default to "the last year only"
 * (ListPayments, ListRefunds, ListPayouts). Square was founded in 2009, so nothing predates it; an
 * explicit early bound is what turns "the last 12 months" into the full history.
 */
export const SQUARE_FULL_HISTORY_BEGIN_TIME = '2009-01-01T00:00:00Z';

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
    retrieveEndpointPathTemplate: '/v2/catalog/object/{id}',
    retrieveResponseRecordKey: 'object',
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
    retrieveEndpointPathTemplate: '/v2/locations/{id}',
    retrieveResponseRecordKey: 'location',
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
    retrieveEndpointPathTemplate: '/v2/customers/{id}',
    retrieveResponseRecordKey: 'customer',
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
    retrieveEndpointPathTemplate: '/v2/orders/{id}',
    retrieveResponseRecordKey: 'order',
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
    retrieveEndpointPathTemplate: '/v2/payments/{id}',
    retrieveResponseRecordKey: 'payment',
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
    retrieveEndpointPathTemplate: '/v2/refunds/{id}',
    retrieveResponseRecordKey: 'refund',
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
    retrieveEndpointPathTemplate: '/v2/invoices/{id}',
    retrieveResponseRecordKey: 'invoice',
    titlePath: 'invoice_number',
    slugPath: 'invoice_number',
    dashboardPath: 'invoices',
  },
  team_members: {
    displayName: 'Team Members',
    description: 'Team members of every status',
    squareObjectName: 'TeamMember',
    oauthReadScope: 'EMPLOYEES_READ',
    listingStrategy: 'team-members-search',
    listEndpointPath: '/v2/team-members/search',
    listResponseRecordsKey: 'team_members',
    retrieveEndpointPathTemplate: '/v2/team-members/{id}',
    retrieveResponseRecordKey: 'team_member',
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
    retrieveEndpointPathTemplate: '/v2/payouts/{id}',
    retrieveResponseRecordKey: 'payout',
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
 * is only used by the per-location strategies (for orders it is the first location of the batch).
 */
export interface SquarePullProgress {
  locationIndex?: number;
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
