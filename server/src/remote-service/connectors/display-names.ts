import { ConnectorMetadata, ConnectorSettingDefinition, Service } from '@spinner/shared-types';
import { AirtableConnector } from './library/airtable/airtable-connector';
import { AudiencefulConnector } from './library/audienceful/audienceful-connector';
import { MocoConnector } from './library/moco/moco-connector';
import { NotionConnector } from './library/notion/notion-connector';
import { PipedriveConnector } from './library/pipedrive/pipedrive-connector';
import { PostgresConnector } from './library/postgres/postgres-connector';
import { QuickBooksConnector } from './library/quickbooks/quickbooks-connector';
import { ShopifyConnector } from './library/shopify/shopify-connector';
import { SupabaseConnector } from './library/supabase/supabase-connector';
import { WebflowConnector } from './library/webflow/webflow-connector';
import { WixBlogConnector } from './library/wix/wix-blog/wix-blog-connector';
import { WordPressConnector } from './library/wordpress/wordpress-connector';
import { YouTubeConnector } from './library/youtube/youtube-connector';

interface ConnectorStaticMetadata {
  readonly displayName: string;
  readonly advancedSettings: ConnectorSettingDefinition[];
  readonly metadata: ConnectorMetadata;
}

const CONNECTOR_MAP: Record<Service, ConnectorStaticMetadata> = {
  [Service.NOTION]: NotionConnector,
  [Service.AIRTABLE]: AirtableConnector,
  [Service.POSTGRES]: PostgresConnector,
  [Service.YOUTUBE]: YouTubeConnector,
  [Service.WORDPRESS]: WordPressConnector,
  [Service.WEBFLOW]: WebflowConnector,
  [Service.WIX_BLOG]: WixBlogConnector,
  [Service.AUDIENCEFUL]: AudiencefulConnector,
  [Service.MOCO]: MocoConnector,
  [Service.SHOPIFY]: ShopifyConnector,
  [Service.SUPABASE]: SupabaseConnector,
  [Service.QUICKBOOKS]: QuickBooksConnector,
  [Service.PIPEDRIVE]: PipedriveConnector,
};

/**
 * Maps a Service enum value to its display name.
 */
export function getServiceDisplayName(service: Service): string {
  return CONNECTOR_MAP[service].metadata.displayName;
}

/**
 * Maps a Service enum value to its advanced settings definitions.
 */
export function getServiceAdvancedSettings(service: Service): ConnectorSettingDefinition[] {
  return CONNECTOR_MAP[service].advancedSettings;
}

/**
 * Maps a Service enum value to its full connector metadata.
 */
export function getServiceMetadata(service: Service): ConnectorMetadata {
  return CONNECTOR_MAP[service].metadata;
}

/**
 * Returns connector metadata for all services.
 */
export function getAllConnectorMetadata(): Record<Service, ConnectorMetadata> {
  const result = {} as Record<Service, ConnectorMetadata>;
  for (const [service, connector] of Object.entries(CONNECTOR_MAP)) {
    result[service as Service] = connector.metadata;
  }
  return result;
}
