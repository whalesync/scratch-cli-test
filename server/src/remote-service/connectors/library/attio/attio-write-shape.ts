/**
 * Convert Attio's read-shape values to its write-shape values.
 *
 * Attio's read responses always wrap each value in a metadata envelope
 * (`attribute_type`, `active_from`, `active_until`, `created_by_actor`) —
 * writes don't accept any of those. Several attribute types also return
 * *derived* keys on read that are rejected on write: e.g. an `email-address`
 * read carries `original_email_address`, `email_domain`, `email_root_domain`,
 * `email_local_specifier` alongside the user-set `email_address`, and writes
 * fail with `unrecognized_keys` if those derived fields come along for the
 * ride. Two types (`select`, `status`) also use a *terser* shape on write
 * than they return on read: write a string title, read back a full option
 * object.
 *
 * `toWriteValues` does three things in order:
 *
 *   1. Strip the universal metadata envelope.
 *   2. Apply per-type normalization (terse-write for `select` / `status`).
 *   3. Apply a per-type write-key allowlist (drop anything else).
 *
 * It's safe to call on either:
 *   - A full record's values (creates), or
 *   - A sparse `changedFields` partial (updates), or
 *   - A value that's already in write shape (idempotent — extra keys absent,
 *     normalization is a no-op).
 *
 * Empty-array entries are dropped — Attio rejects writes that carry a key
 * pointing at an empty array. To clear a multi-value attribute, callers
 * should pass `[null]` (a single null).
 *
 * Empirically verified against the Attio v2 API on 2026-05-05; the per-type
 * allowlist below was derived by trial-and-error against a real workspace.
 */

const ENVELOPE_KEYS = new Set(['attribute_type', 'active_from', 'active_until', 'created_by_actor']);

/**
 * Per-attribute-type allowlist of keys accepted on write. Anything else in
 * the value object is dropped before the request goes out. Types not listed
 * fall through to "strip envelope only" — safe default for read shapes that
 * happen to be symmetric, and for any new types Attio adds in the future.
 */
const WRITE_KEYS_BY_TYPE: Record<string, readonly string[]> = {
  text: ['value'],
  number: ['value'],
  checkbox: ['value'],
  rating: ['value'],
  date: ['value'],
  timestamp: ['value'],
  currency: ['currency_value'],
  domain: ['domain'],
  'email-address': ['email_address'],
  'phone-number': ['original_phone_number', 'country_code'],
  'personal-name': ['first_name', 'last_name', 'full_name'],
  select: ['option'],
  status: ['status'],
  'actor-reference': ['referenced_actor_type', 'referenced_actor_id'],
  'record-reference': ['target_object', 'target_record_id'],
  location: [
    'line_1',
    'line_2',
    'line_3',
    'line_4',
    'locality',
    'region',
    'postcode',
    'country_code',
    'latitude',
    'longitude',
  ],
};

/**
 * Top-level conversion: takes a `values` (or `entry_values`) map keyed by
 * api_slug, returns the write-shape equivalent.
 */
export function toWriteValues(values: unknown): Record<string, unknown[]> {
  if (!values || typeof values !== 'object') return {};
  const result: Record<string, unknown[]> = {};
  for (const [apiSlug, rawArray] of Object.entries(values as Record<string, unknown>)) {
    if (!Array.isArray(rawArray) || rawArray.length === 0) continue;
    const converted = rawArray.map((entry) => convertOne(entry));
    result[apiSlug] = converted;
  }
  return result;
}

/**
 * Convert a single value entry through the three-step pipeline:
 *   1. Strip the universal metadata envelope.
 *   2. Per-type normalization (`select`/`status`).
 *   3. Per-type write-key allowlist filter.
 */
function convertOne(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object') return entry;
  const obj = entry as Record<string, unknown>;
  const attributeType = typeof obj.attribute_type === 'string' ? obj.attribute_type : undefined;

  let payload = stripEnvelope(obj);
  if (attributeType === 'select') payload = convertSelect(payload);
  if (attributeType === 'status') payload = convertStatus(payload);

  if (attributeType && WRITE_KEYS_BY_TYPE[attributeType]) {
    payload = filterToAllowlist(payload, WRITE_KEYS_BY_TYPE[attributeType]);
  }

  return payload;
}

/** Drop the universal metadata envelope keys, keeping the type-specific payload. */
function stripEnvelope(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!ENVELOPE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/** Keep only the keys present in the allowlist. */
function filterToAllowlist(obj: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in obj) out[k] = obj[k];
  }
  return out;
}

/**
 * Read shape: `{ option: { id: { ... }, title: 'Lead', is_archived: false } }`
 * Write shape: `{ option: 'Lead' }` (string title)
 *
 * If `option` is already a string (caller passed write-shape directly), leave
 * it alone. If it's an object, pull `title` out.
 */
function convertSelect(payload: Record<string, unknown>): Record<string, unknown> {
  const option = payload.option;
  if (typeof option === 'string' || option == null) return payload;
  if (typeof option === 'object' && 'title' in option) {
    return { ...payload, option: (option as { title: unknown }).title };
  }
  return payload;
}

/**
 * Read shape: `{ status: { id: { ... }, title: 'Open', ... } }`
 * Write shape: `{ status: 'Open' }` (string title)
 */
function convertStatus(payload: Record<string, unknown>): Record<string, unknown> {
  const status = payload.status;
  if (typeof status === 'string' || status == null) return payload;
  if (typeof status === 'object' && 'title' in status) {
    return { ...payload, status: (status as { title: unknown }).title };
  }
  return payload;
}
