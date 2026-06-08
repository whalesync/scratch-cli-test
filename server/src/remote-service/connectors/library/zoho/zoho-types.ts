/**
 * Types and constants for the Zoho CRM connector.
 *
 * Zoho CRM is a dynamic-discovery connector: modules (tables) and their fields
 * are read from the metadata API at runtime (`/settings/modules`,
 * `/settings/fields`). These types describe the slices of that metadata the
 * connector actually reads — Zoho returns far more per object, and we keep the
 * raw record verbatim, so the shapes below are intentionally permissive.
 */

/** Zoho data centers. The user picks one when connecting; defaults to US. */
export type ZohoDataCenter = 'US' | 'EU' | 'IN' | 'AU' | 'JP' | 'CA' | 'CN' | 'SA';

export const ZOHO_DEFAULT_DATA_CENTER: ZohoDataCenter = 'US';

/**
 * Per-data-center hostnames. `accountsDomain` is where we exchange the refresh
 * token for an access token; `defaultApiDomain` is the CRM API host to use
 * until the token response tells us the authoritative `api_domain` (which we
 * then prefer — see the Multi-DC OAuth quirk in the connector plan).
 */
export const ZOHO_DATA_CENTER_HOSTS: Record<ZohoDataCenter, { accountsDomain: string; defaultApiDomain: string }> = {
  US: { accountsDomain: 'https://accounts.zoho.com', defaultApiDomain: 'https://www.zohoapis.com' },
  EU: { accountsDomain: 'https://accounts.zoho.eu', defaultApiDomain: 'https://www.zohoapis.eu' },
  IN: { accountsDomain: 'https://accounts.zoho.in', defaultApiDomain: 'https://www.zohoapis.in' },
  AU: { accountsDomain: 'https://accounts.zoho.com.au', defaultApiDomain: 'https://www.zohoapis.com.au' },
  JP: { accountsDomain: 'https://accounts.zoho.jp', defaultApiDomain: 'https://www.zohoapis.jp' },
  CA: { accountsDomain: 'https://accounts.zohocloud.ca', defaultApiDomain: 'https://www.zohoapis.ca' },
  CN: { accountsDomain: 'https://accounts.zoho.com.cn', defaultApiDomain: 'https://www.zohoapis.com.cn' },
  SA: { accountsDomain: 'https://accounts.zoho.sa', defaultApiDomain: 'https://www.zohoapis.sa' },
};

export function normalizeZohoDataCenter(value: string | undefined): ZohoDataCenter {
  const upper = (value ?? '').trim().toUpperCase();
  if (upper in ZOHO_DATA_CENTER_HOSTS) {
    return upper as ZohoDataCenter;
  }
  return ZOHO_DEFAULT_DATA_CENTER;
}

/** Credentials the connector needs to mint access tokens (user-provided in v1). */
export interface ZohoConnectorCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  dataCenter: ZohoDataCenter;
}

/**
 * A module entry from `GET /settings/modules`. Only the fields the connector
 * reads are typed; everything else is ignored.
 */
export interface ZohoModuleMetadata {
  api_name: string;
  module_name?: string;
  plural_label?: string;
  singular_label?: string;
  /** 'default' for standard, 'custom' for user-created, plus subform/linking types. */
  generated_type?: string;
  /** Whether the module is reachable through the records API at all. */
  api_supported?: boolean;
  creatable?: boolean;
  editable?: boolean;
  deletable?: boolean;
  viewable?: boolean;
  /** Whether the module shows in the org's UI; hidden system modules set this false. */
  visible?: boolean;
  /** Whether this is a subform module embedded in another module's record. */
  subform?: boolean | null;
}

/** A single allowed value for a picklist/multiselectpicklist field. */
export interface ZohoPickListValue {
  display_value?: string;
  actual_value?: string;
  /** 'used' values are active; others are deprecated and should be excluded. */
  type?: string;
  sequence_number?: number;
  colour_code?: string;
}

/** The `lookup`/`multiselectlookup` sub-object on a lookup field's metadata. */
export interface ZohoFieldLookup {
  module?: { api_name?: string; id?: string } | null;
  display_label?: string;
  api_name?: string;
}

/**
 * A field entry from `GET /settings/fields?module=X`. Zoho returns ~60 keys per
 * field; only the ones that drive schema generation are typed.
 */
export interface ZohoFieldMetadata {
  api_name: string;
  field_label?: string;
  data_type: string;
  json_type?: string;
  /** True for system-computed/locked fields (formula, rollup, audit, etc.). */
  read_only?: boolean;
  field_read_only?: boolean;
  /** Required to create a record. */
  system_mandatory?: boolean;
  /** Max length for text fields. */
  length?: number | null;
  decimal_place?: number | null;
  pick_list_values?: ZohoPickListValue[] | null;
  lookup?: ZohoFieldLookup | null;
  multiselectlookup?: ZohoFieldLookup | null;
  /** Per-operation capability flags; api_update=false means not writable on update. */
  operation_type?: { web_update?: boolean; api_create?: boolean; api_update?: boolean } | null;
}

/**
 * Resumable progress for a Zoho pull. Captured before the first API call so a
 * crash mid-pull resumes without skipping records (the pull is idempotent).
 */
export interface ZohoDownloadProgress {
  [key: string]: string | undefined;
  /** Opaque `next_page_token` from the records API; resume point for pagination. */
  pageToken?: string;
  /** ISO 8601 server-time high-water mark for the incremental run. */
  watermark?: string;
}

/** Category buckets used to group modules in the table picker (`parentPath`). */
export function categoryForModule(apiName: string): string {
  switch (apiName) {
    case 'Leads':
    case 'Contacts':
    case 'Accounts':
    case 'Deals':
      return 'Sales';
    case 'Tasks':
    case 'Calls':
    case 'Events':
    case 'Activities':
      return 'Activities';
    case 'Campaigns':
      return 'Marketing';
    case 'Quotes':
    case 'Sales_Orders':
    case 'Purchase_Orders':
    case 'Invoices':
    case 'Products':
    case 'Price_Books':
    case 'Vendors':
      return 'Inventory';
    case 'Cases':
    case 'Solutions':
      return 'Support';
    case 'Notes':
    case 'Attachments':
      return 'Notes & Files';
    default:
      return 'Other';
  }
}
