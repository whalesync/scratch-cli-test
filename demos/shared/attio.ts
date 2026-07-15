// Minimal Attio v2 API client for the demo tooling.
// Uses Node 22 native fetch (no axios). This talks to Attio DIRECTLY to seed/reset the
// CRM-cleanup demo data; it is NOT the Scratch connector. (The Scratch round-trip is
// exercised separately via the scratchmd CLI in bootstrap.ts.)

import { get_attio_api_key } from './env.ts';

const ATTIO_API_BASE_URL = 'https://api.attio.com';

// Attio's org-wide limit is ~100 req/s per workspace token — very generous. A small delay
// between writes keeps a full seed well clear of any burst throttling.
const DELAY_BETWEEN_WRITES_MILLISECONDS = 60;

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve_callback) => setTimeout(resolve_callback, milliseconds));
}

async function attio_api_request(http_method: string, request_path: string, request_body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${ATTIO_API_BASE_URL}${request_path}`, {
      method: http_method,
      headers: {
        authorization: `Bearer ${get_attio_api_key()}`,
        accept: 'application/json',
        ...(request_body ? { 'content-type': 'application/json' } : {}),
      },
      body: request_body ? JSON.stringify(request_body) : undefined,
    });

    // Honor Attio's 429 Retry-After (seconds) so back-to-back seeds never fail.
    if (response.status === 429 && attempt < 5) {
      const retry_after_seconds = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      const wait_milliseconds = Number.isFinite(retry_after_seconds) && retry_after_seconds > 0 ? retry_after_seconds * 1000 : 2000;
      console.log(`   Attio rate-limited (429); waiting ${wait_milliseconds}ms before retry ${attempt + 1}/5...`);
      await sleep(wait_milliseconds);
      continue;
    }

    if (response.status === 204) return null;

    const response_text = await response.text();
    let parsed_response_body: any = null;
    try {
      parsed_response_body = response_text ? JSON.parse(response_text) : null;
    } catch {
      parsed_response_body = response_text;
    }

    if (!response.ok) {
      const error = new Error(
        `Attio ${http_method} ${request_path} failed: HTTP ${response.status} ${JSON.stringify(parsed_response_body)}`,
      );
      (error as any).statusCode = response.status;
      throw error;
    }
    return parsed_response_body;
  }
}

// ---- Types (only the slices the demo needs) ----

export type AttioValues = Record<string, unknown[]>;

export interface AttioRecord {
  id: { workspace_id: string; object_id: string; record_id: string };
  values: AttioValues;
}

export interface AttioWorkspaceMember {
  id: { workspace_id: string; workspace_member_id: string };
  first_name?: string;
  last_name?: string;
  email_address?: string;
}

export function record_id(record: AttioRecord): string {
  return record.id.record_id;
}

// ---- Reads ----

// The teammates in the workspace; a deal's required `owner` (actor-reference) points at one.
export async function list_workspace_members(): Promise<AttioWorkspaceMember[]> {
  const response = await attio_api_request('GET', '/v2/workspace_members');
  return (response?.data ?? []) as AttioWorkspaceMember[];
}

// Fetch every record on an object (offset pagination; the demo workspace is well under one page).
export async function query_all_records(object_slug: string): Promise<AttioRecord[]> {
  const all_records: AttioRecord[] = [];
  const page_limit = 500;
  let offset = 0;
  for (;;) {
    const response = await attio_api_request('POST', `/v2/objects/${object_slug}/records/query`, {
      limit: page_limit,
      offset,
    });
    const page = (response?.data ?? []) as AttioRecord[];
    all_records.push(...page);
    if (page.length < page_limit) break;
    offset += page.length;
  }
  return all_records;
}

// ---- Writes ----

export async function create_record(object_slug: string, values: AttioValues): Promise<AttioRecord> {
  const response = await attio_api_request('POST', `/v2/objects/${object_slug}/records`, { data: { values } });
  await sleep(DELAY_BETWEEN_WRITES_MILLISECONDS);
  return response.data as AttioRecord;
}

export async function update_record(object_slug: string, record_id_value: string, values: AttioValues): Promise<AttioRecord> {
  const response = await attio_api_request('PATCH', `/v2/objects/${object_slug}/records/${record_id_value}`, {
    data: { values },
  });
  await sleep(DELAY_BETWEEN_WRITES_MILLISECONDS);
  return response.data as AttioRecord;
}

// Delete a record. Tolerates a 404 (already gone) so teardown is idempotent.
export async function delete_record(object_slug: string, record_id_value: string): Promise<void> {
  try {
    await attio_api_request('DELETE', `/v2/objects/${object_slug}/records/${record_id_value}`);
  } catch (error) {
    if ((error as any).statusCode !== 404) throw error;
  }
  await sleep(DELAY_BETWEEN_WRITES_MILLISECONDS);
}

// ---- Value-shape helpers (Attio's write shape, per attribute type) ----

export const attio_value = {
  text: (value: string) => [{ value }],
  domain: (domain: string) => [{ domain }],
  select: (title: string) => [{ option: title }],
  multiselect: (titles: string[]) => titles.map((title) => ({ option: title })),
  status: (title: string) => [{ status: title }],
  currency: (currency_value: number) => [{ currency_value }],
  date: (value: string) => [{ value }],
  personal_name: (first_name: string, last_name: string) => [
    { first_name, last_name, full_name: `${first_name} ${last_name}` },
  ],
  record_reference: (target_object: string, target_record_id: string) => [{ target_object, target_record_id }],
  actor_reference: (referenced_actor_id: string) => [
    { referenced_actor_type: 'workspace-member', referenced_actor_id },
  ],
  // primary_location: only the keys Attio accepts on write (country_code + locality is enough
  // for the demo's "where is this company based" enrichment beat).
  location: (country_code: string, locality: string) => [{ country_code, locality }],
};
