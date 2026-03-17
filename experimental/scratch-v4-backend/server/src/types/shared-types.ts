/**
 * Local definitions of types that would otherwise come from @spinner/shared-types.
 * Kept minimal for the experimental backend — only what step 1 actually needs.
 */

export enum Service {
  NOTION = 'NOTION',
  AIRTABLE = 'AIRTABLE',
  POSTGRES = 'POSTGRES',
  YOUTUBE = 'YOUTUBE',
  WORDPRESS = 'WORDPRESS',
  WEBFLOW = 'WEBFLOW',
  WIX_BLOG = 'WIX_BLOG',
  AUDIENCEFUL = 'AUDIENCEFUL',
  MOCO = 'MOCO',
  SHOPIFY = 'SHOPIFY',
  SUPABASE = 'SUPABASE',
  QUICKBOOKS = 'QUICKBOOKS',
  PIPEDRIVE = 'PIPEDRIVE',
}

export enum TableDiscoveryMode {
  LIST = 'LIST',
  SEARCH = 'SEARCH',
}

export type EntityId = {
  wsId: string;
  remoteId: string[];
};

export interface ConnectorPullOptions {
  filter?: string | undefined;
  [key: string]: unknown;
}

export interface ConnectorSettingDefinition {
  key: string;
  type: 'boolean' | 'number' | 'string';
  label: string;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
}

export enum PostgresColumnType {
  TEXT = 'text',
  TEXT_ARRAY = 'text[]',
  NUMERIC = 'numeric',
  NUMERIC_ARRAY = 'numeric[]',
  BOOLEAN = 'boolean',
  BOOLEAN_ARRAY = 'boolean[]',
  JSONB = 'jsonb',
  TIMESTAMP = 'timestamp',
}

// Minimal transformer stubs — full definitions not needed for step 1
export const TransformerTypes = {
  AutoConvert: 'auto_convert',
  ArrayAutoConvert: 'array_auto_convert',
  StringToNumber: 'string_to_number',
  AirmarkToHtml: 'airmark_to_html',
  HtmlToAirmark: 'html_to_airmark',
  WebflowOption: 'webflow_option',
  WebflowOptionIdToValue: 'webflow_option_id_to_value',
  EnsureType: 'ensure_type',
  Slugify: 'slugify',
  JSONPath: 'jsonpath',
  NotionToHtml: 'notion_to_html',
  SourceFkToDestFk: 'source_fk_to_dest_fk',
  LookupField: 'lookup_field',
  SourceAssetToDestAsset: 'source_asset_to_dest_asset',
  NotionFileUrl: 'notion_file_url',
} as const;

export type TransformerConfig = { type: string; options?: Record<string, unknown> };
