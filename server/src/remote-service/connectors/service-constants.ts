/**
 * String constants for registered connector services.
 *
 * These are convenience constants for server-side code that needs to reference
 * specific services by name. The canonical list of services comes from the
 * connector registry (connectors self-register at import time).
 *
 * The Service *type* is just `string` (exported from @spinner/shared-types).
 */
export const Service = {
  NOTION: 'NOTION',
  AIRTABLE: 'AIRTABLE',
  POSTGRES: 'POSTGRES',
  YOUTUBE: 'YOUTUBE',
  WORDPRESS: 'WORDPRESS',
  WEBFLOW: 'WEBFLOW',
  WIX_BLOG: 'WIX_BLOG',
  AUDIENCEFUL: 'AUDIENCEFUL',
  MOCO: 'MOCO',
  SHOPIFY: 'SHOPIFY',
  SUPABASE: 'SUPABASE',
  QUICKBOOKS: 'QUICKBOOKS',
  PIPEDRIVE: 'PIPEDRIVE',
  MEMBERSTACK: 'MEMBERSTACK',
  HUBSPOT: 'HUBSPOT',
  LINEAR: 'LINEAR',
  BREVO: 'BREVO',
  INTERCOM: 'INTERCOM',
  STRIPE: 'STRIPE',
  AFFINITY: 'AFFINITY',
  ATTIO: 'ATTIO',
  GENERIC_API: 'GENERIC_API',
} as const;
