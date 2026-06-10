/**
 * Copper stores a record's custom-field values as a verbatim array:
 *
 *   custom_fields: [{ custom_field_definition_id: number, value: unknown }, …]
 *
 * Scratch's table view cannot address an array element as an editable column —
 * column paths are plain object dot-paths, and arrays are treated as leaves on
 * read and clobbered on write (see scratch-desktop `getByPath` / `setByPath`).
 * So, mirroring the GoHighLevel connector, we reshape that array into a keyed
 * object on the way in (one sub-property → one editable column per definition)
 * and reshape it back to the array on the way out.
 *
 * The column key is `cf_<definitionId>`:
 *  - **rename-stable** — Copper exposes no stable field slug, so a name-derived
 *    key would churn every time a user renames a custom field (spurious diffs on
 *    every record); the definition id never changes.
 *  - **collision-free** — definition ids are unique.
 *  - **path-safe** — the leading `cf_` avoids a pure-numeric dot-path segment.
 * The reverse map is trivial, so neither direction needs the definition list.
 *
 * This is the one sanctioned deviation from "store the API response verbatim":
 * the reshape is loss-free and round-trips back to the exact `[{id,value}]`
 * array on publish, so external fidelity is preserved end-to-end.
 */

/** The top-level field that holds custom-field values on every Copper record. */
const CUSTOM_FIELDS_KEY = 'custom_fields';

/** Prefix that turns a numeric definition id into a path-safe column key. */
const CUSTOM_FIELD_KEY_PREFIX = 'cf_';

/** The keyed-object column key for a custom-field definition (`700123` → `cf_700123`). */
export function customFieldColumnKey(definitionId: number): string {
  return `${CUSTOM_FIELD_KEY_PREFIX}${definitionId}`;
}

/** Recover the numeric definition id from a column key (`cf_700123` → `700123`), or null. */
export function parseCustomFieldColumnKey(columnKey: string): number | null {
  if (!columnKey.startsWith(CUSTOM_FIELD_KEY_PREFIX)) return null;
  const suffix = columnKey.slice(CUSTOM_FIELD_KEY_PREFIX.length);
  // Require a run of digits — `Number('')`/`Number('12.5')` would otherwise slip through.
  if (!/^\d+$/.test(suffix)) return null;
  return Number(suffix);
}

/**
 * Pull / API-response shape → editable shape: replace the verbatim
 * `custom_fields` array with a keyed object (`{ cf_<id>: value }`). Returns a
 * shallow copy; a record without a `custom_fields` array is returned unchanged.
 */
export function reshapeCustomFieldsArrayToObject(record: Record<string, unknown>): Record<string, unknown> {
  const customFieldsArray = record[CUSTOM_FIELDS_KEY];
  if (!Array.isArray(customFieldsArray)) return record;

  const customFieldsByColumnKey: Record<string, unknown> = {};
  for (const entry of customFieldsArray) {
    if (!entry || typeof entry !== 'object') continue;
    const { custom_field_definition_id: definitionId, value } = entry as {
      custom_field_definition_id?: unknown;
      value?: unknown;
    };
    if (typeof definitionId !== 'number') continue;
    customFieldsByColumnKey[customFieldColumnKey(definitionId)] = value ?? null;
  }
  return { ...record, [CUSTOM_FIELDS_KEY]: customFieldsByColumnKey };
}

/**
 * Editable shape → publish/API shape: replace the keyed `custom_fields` object
 * with the verbatim `[{ custom_field_definition_id, value }]` array Copper
 * expects. Returns a shallow copy; a record whose `custom_fields` is not a plain
 * object (already an array, missing, or null) is returned unchanged.
 *
 * Every present key is written back — including computed / `Connect` (read-only)
 * fields — so a full-record update never drops a value Copper still holds (the
 * service ignores writes to its own computed fields). The default view marks
 * those columns `readonly`, so the user never edits them in the first place.
 * Keys that aren't `cf_<id>` are skipped (Copper would reject them anyway).
 */
export function reshapeCustomFieldsObjectToArray(record: Record<string, unknown>): Record<string, unknown> {
  const customFieldsObject = record[CUSTOM_FIELDS_KEY];
  if (!customFieldsObject || typeof customFieldsObject !== 'object' || Array.isArray(customFieldsObject)) {
    return record;
  }

  const customFieldsArray: { custom_field_definition_id: number; value: unknown }[] = [];
  for (const [columnKey, value] of Object.entries(customFieldsObject as Record<string, unknown>)) {
    const definitionId = parseCustomFieldColumnKey(columnKey);
    if (definitionId === null) continue;
    customFieldsArray.push({ custom_field_definition_id: definitionId, value });
  }
  return { ...record, [CUSTOM_FIELDS_KEY]: customFieldsArray };
}
