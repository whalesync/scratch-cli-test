// Minimal Webflow Data API v2 client for the demo tooling.
// Uses Node 22 native fetch (no axios). This talks to Webflow DIRECTLY to seed/reset
// demo data; it is NOT the Scratch connector. (The Scratch round-trip is exercised
// separately via the scratchmd CLI in bootstrap.ts.)

import { get_webflow_api_key } from './env.ts';

const WEBFLOW_API_BASE_URL = 'https://api.webflow.com/v2';

// Webflow Data API default rate limit is ~60 requests/minute. We add a gentle
// delay between write requests so a full ~40-item seed never trips it.
const DELAY_BETWEEN_WRITES_MILLISECONDS = 350;

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve_callback) => setTimeout(resolve_callback, milliseconds));
}

async function webflow_api_request(
  http_method: string,
  request_path: string,
  request_body?: unknown,
): Promise<any> {
  const response = await fetch(`${WEBFLOW_API_BASE_URL}${request_path}`, {
    method: http_method,
    headers: {
      authorization: `Bearer ${get_webflow_api_key()}`,
      accept: 'application/json',
      ...(request_body ? { 'content-type': 'application/json' } : {}),
    },
    body: request_body ? JSON.stringify(request_body) : undefined,
  });

  if (response.status === 204) return null;

  const response_text = await response.text();
  let parsed_response_body: any = null;
  try {
    parsed_response_body = response_text ? JSON.parse(response_text) : null;
  } catch {
    parsed_response_body = response_text;
  }

  if (!response.ok) {
    throw new Error(
      `Webflow ${http_method} ${request_path} failed: HTTP ${response.status} ${JSON.stringify(parsed_response_body)}`,
    );
  }
  return parsed_response_body;
}

export interface WebflowSite {
  id: string;
  displayName: string;
  shortName: string;
}

export async function list_sites(): Promise<WebflowSite[]> {
  const response = await webflow_api_request('GET', '/sites');
  return (response?.sites ?? []) as WebflowSite[];
}

// Resolve the site to demo against. Prefers a name match, else the only site,
// else throws so we never seed into an unexpected workspace.
export async function resolve_demo_site_id(preferred_name_substring = 'Scratch General Test'): Promise<string> {
  const sites = await list_sites();
  if (sites.length === 0) throw new Error('No Webflow sites are accessible with this API key.');
  const name_matched_site = sites.find((site) =>
    site.displayName.toLowerCase().includes(preferred_name_substring.toLowerCase()),
  );
  if (name_matched_site) return name_matched_site.id;
  if (sites.length === 1) return sites[0].id;
  throw new Error(
    `Could not pick a demo site. Multiple sites and none matched "${preferred_name_substring}": ${sites
      .map((site) => site.displayName)
      .join(', ')}`,
  );
}

export interface WebflowCollectionField {
  id: string;
  slug: string;
  displayName: string;
  type: string;
}

export interface WebflowCollection {
  id: string;
  displayName: string;
  slug: string;
  fields: WebflowCollectionField[];
}

export async function list_collections(site_id: string): Promise<WebflowCollection[]> {
  const response = await webflow_api_request('GET', `/sites/${site_id}/collections`);
  return (response?.collections ?? []) as WebflowCollection[];
}

export async function get_collection(collection_id: string): Promise<WebflowCollection> {
  return (await webflow_api_request('GET', `/collections/${collection_id}`)) as WebflowCollection;
}

export async function create_collection(
  site_id: string,
  display_name: string,
  singular_name: string,
  slug: string,
): Promise<WebflowCollection> {
  return (await webflow_api_request('POST', `/sites/${site_id}/collections`, {
    displayName: display_name,
    singularName: singular_name,
    slug,
  })) as WebflowCollection;
}

export async function create_collection_field(
  collection_id: string,
  field_type: string,
  display_name: string,
): Promise<WebflowCollectionField> {
  return (await webflow_api_request('POST', `/collections/${collection_id}/fields`, {
    type: field_type,
    displayName: display_name,
  })) as WebflowCollectionField;
}

export interface WebflowItem {
  id: string;
  fieldData: Record<string, unknown>;
}

export async function create_collection_item(
  collection_id: string,
  field_data: Record<string, unknown>,
  options: { is_draft?: boolean } = {},
): Promise<WebflowItem> {
  const created = (await webflow_api_request('POST', `/collections/${collection_id}/items`, {
    isArchived: false,
    isDraft: options.is_draft ?? false,
    fieldData: field_data,
  })) as WebflowItem;
  await sleep(DELAY_BETWEEN_WRITES_MILLISECONDS);
  return created;
}

export async function update_collection_item(
  collection_id: string,
  item_id: string,
  field_data: Record<string, unknown>,
): Promise<WebflowItem> {
  // PATCH an existing item's fields in place (keeps its id + slug). Used to restore the
  // link-free baseline without deleting — avoids the slug-already-in-database conflict you
  // hit if you delete a *published* item (its slug stays reserved until a publish) and then
  // try to recreate it.
  const updated = (await webflow_api_request('PATCH', `/collections/${collection_id}/items/${item_id}`, {
    isArchived: false,
    isDraft: false,
    fieldData: field_data,
  })) as WebflowItem;
  await sleep(DELAY_BETWEEN_WRITES_MILLISECONDS);
  return updated;
}

export async function list_all_collection_items(collection_id: string): Promise<WebflowItem[]> {
  const all_items: WebflowItem[] = [];
  let offset = 0;
  const page_size = 100;
  for (;;) {
    const response = await webflow_api_request(
      'GET',
      `/collections/${collection_id}/items?limit=${page_size}&offset=${offset}`,
    );
    const page_items = (response?.items ?? []) as WebflowItem[];
    all_items.push(...page_items);
    const total = response?.pagination?.total ?? all_items.length;
    offset += page_size;
    if (page_items.length === 0 || all_items.length >= total) break;
  }
  return all_items;
}

export async function delete_collection_item(collection_id: string, item_id: string): Promise<void> {
  await webflow_api_request('DELETE', `/collections/${collection_id}/items/${item_id}`);
  await sleep(DELAY_BETWEEN_WRITES_MILLISECONDS);
}

// Publish the whole site to its *.webflow.io subdomain. Webflow has no working per-item publish
// for an API-created collection, and a site publish is the only reliable way to push staged CMS
// changes (creates AND deletes) live. Async on Webflow's side (returns 202).
//
// Caveat: this makes the items LIVE DATA, but a collection created via the API has no Designer
// page template, so individual post URLs still won't render until someone adds that template in
// the Webflow Designer once. The API cannot create page templates.
export async function publish_site(site_id: string): Promise<void> {
  // Webflow rate-limits site publishes (~1/min). Retry on 429 so back-to-back runs don't fail.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await webflow_api_request('POST', `/sites/${site_id}/publish`, { publishToWebflowSubdomain: true });
      return;
    } catch (error) {
      const is_rate_limited = String(error).includes('429') || String(error).toLowerCase().includes('too many requests');
      if (is_rate_limited && attempt < 4) {
        console.log(`   site publish rate-limited (429); waiting 25s before retry ${attempt + 1}/4...`);
        await sleep(25_000);
        continue;
      }
      throw error;
    }
  }
}
