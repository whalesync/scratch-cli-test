import { Service } from '@spinner/shared-types';

export type TestConnectionResponse = { health: 'ok' } | { health: 'error'; error: string };

export const INTERNAL_SERVICES = [
  Service.AIRTABLE,
  Service.WORDPRESS,
  Service.WEBFLOW,
  Service.WIX_BLOG,
  Service.NOTION,
  Service.YOUTUBE,
  Service.POSTGRES,
  Service.AUDIENCEFUL,
  Service.MOCO,
  Service.SHOPIFY,
  Service.PIPEDRIVE,
];
