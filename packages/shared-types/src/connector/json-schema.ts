import { TransformerConfig } from '../sync-mapping';

/**
 * Field metadata keys for connector JSON schemas
 */

// All fields must start with this prefix.
export const X_SCRATCH_PREFIX = 'x-scratch-';

// A field is readonly if the value of this key is true.
export const X_SCRATCH_READONLY = 'x-scratch-readonly';

// A field is "write-once" if the value of this key is true: it may be set while
// the record is brand-new (created locally, not yet published to the external
// service) but becomes read-only once the record exists remotely. Use this for
// fields the service accepts on create but rejects (or ignores) on update —
// e.g. Attio task `content` (PATCH rejects it) and a list entry's
// `parent_record_id`/`parent_object` (a list entry can't be re-parented).
//
// Contrast with X_SCRATCH_READONLY, which is *always* read-only. Editability is
// computed as `readonly || (writeOnce && !recordIsNew)`. The "is new" signal
// comes from the local diff status (no published master = new). Agents reading
// schema.json may populate a write-once field when CREATING a record but must
// NOT change it on an existing record.
export const X_SCRATCH_WRITE_ONCE = 'x-scratch-write-once';

// The native, connector-specific data type of the field.
export const X_SCRATCH_CONNECTOR_DATA_TYPE = 'x-scratch-connector-data-type';

// An object describing a foreign key configuration for a field.
export const X_SCRATCH_FOREIGN_KEY_OPTIONS = 'x-scratch-foreign-key';

// The remote field ID from the external service (e.g. Airtable fldXXX, Webflow hex hash, Notion property ID).
export const X_SCRATCH_REMOTE_FIELD_ID = 'x-scratch-remote-field-id';

// The suggested transformer to auto-apply when this field is selected as a source in the sync editor.
export const X_SCRATCH_SUGGESTED_TRANSFORMER = 'x-scratch-suggested-transformer';

// The suggested transformer to auto-apply when this field is selected as a destination in the sync editor.
export const X_SCRATCH_SUGGESTED_IN_TRANSFORMER = 'x-scratch-suggested-in-transformer';

// The CoreValue primitive that this field's `x-scratch-suggested-in-transformer` pack CONSUMES in its
// `$value` slot, when the pack constrains it: `'string'` for a text-shaped pack (a Notion
// rich_text/title/url/select string slot, a Webflow option id), `'number'`/`'boolean'` for a
// native-scalar pack (a Notion number/checkbox). Lets the connector-agnostic transform picker
// guarantee the value entering a pack matches the primitive it needs — coercing a non-matching source
// (a Postgres integer `2`, a JSON object, a collapsed array element) BEFORE the pack rather than
// letting the raw value reach the connector write and be rejected (`text.content should be a string`,
// DEV-10952). Only set on SINGLE-value packs; an array-folding pack (Notion relation `map_array`)
// omits it. Absent → the pack's input is unconstrained and the picker's legacy source-type heuristic
// decides (unchanged for any connector that declares no pack input type).
export const X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE = 'x-scratch-suggested-in-transformer-input-type';

// An array of virtual field definitions that provide human-readable shortcuts for complex nested fields.
export const X_SCRATCH_VIRTUAL_FIELDS = 'x-scratch-virtual-fields';

// The maximum length of a string field as enforced by the external service (e.g. PostgreSQL VARCHAR(n)).
export const X_SCRATCH_MAX_LENGTH = 'x-scratch-max-length';

// Marks a field as containing file/media assets that should be indexed.
export const X_SCRATCH_ASSET_FIELD = 'x-scratch-asset-field';

// Marks a table whose records ARE assets (e.g. WordPress media, Webflow Assets).
export const X_SCRATCH_ASSET_TABLE = 'x-scratch-asset-table';

// The table's fields in the exact order the Airtable API returned them, as an array
// of field NAMES. Stored on the record schema's `fields` object node (a CONTAINER of
// the record's columns, not a value envelope). Field names are user-controlled and can
// be purely numeric (e.g. "1", "2024"); JavaScript object-key iteration hoists
// integer-like keys to the front, so `Object.keys(schema.properties.fields.properties)`
// does NOT recover the true field order for such tables — this annotation preserves it
// so `buildAirtableDefaultView` can order columns faithfully. A faithful fact the API
// reports (the field order), not a display opinion.
export const X_SCRATCH_AIRTABLE_FIELD_ORDER = 'x-scratch-airtable-field-order';

// Marks a field whose value is the row's server-side last-modified timestamp.
// Connectors that auto-detect this on schema build (e.g. Airtable's lastModifiedTime
// field type) annotate the field so incremental pulls can use it without an explicit
// `DataFolderOptions.modifiedAtField`. The annotation value is `true`.
export const X_SCRATCH_LAST_MODIFIED_FIELD = 'x-scratch-last-modified-field';

// Marks a field the external service reports as user-CREATED (a "custom" field)
// rather than a built-in "standard" one — a faithful fact from the service's own
// field metadata (e.g. Zoho's `custom_field`, GoHighLevel's `!field.standard`),
// NOT a display opinion. The value is `true`. Connectors' default-view builders
// read it to gather custom fields under a "Custom Fields" banner group; the
// grouping decision itself stays editorial code in the builder.
export const X_SCRATCH_CUSTOM_FIELD = 'x-scratch-custom-field';

// A plain-text hint targeted at AI agents (Claude, Gemini, etc.) that read
// schema.json before editing records. Use sparingly — only when a non-obvious
// structural or semantic detail would change how an agent interprets a field
// or object. Not surfaced in any human-facing UI.
export const X_SCRATCH_AGENT_INSTRUCTIONS = 'x-scratch-agent-instructions';

// Marks an array property whose elements should each become an individually
// editable, individually diffable column — WITHOUT reshaping the array on disk.
// The array is stored verbatim (as the external service returned it); this
// annotation tells the generic column engine, the path read/write engine, and
// the publish diff how to address elements by a stable key field instead. The
// value is an `ArrayKeyedByOptions`. See `keyed-array.ts` for the addressing
// grammar (`prop.[keyField=key].valuePath`) and the shared helpers.
export const X_SCRATCH_ARRAY_KEYED_BY = 'x-scratch-array-keyed-by';

/**
 * Options for an asset field annotation.
 */
export interface AssetFieldOptions {
  /** JSONPath to stable ID within each item (null = use URL hash). */
  idPath: string | null;
  /** Whether the asset URL expires (e.g. Airtable ~2hr, Notion expiry_time). */
  urlExpires: boolean;
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainRecordSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAssetFieldOptions(value: unknown): value is AssetFieldOptions {
  return (
    isPlainRecordSchema(value) &&
    'idPath' in value &&
    (typeof value.idPath === 'string' || value.idPath === null) &&
    typeof value.urlExpires === 'boolean'
  );
}

/**
 * Read the {@link X_SCRATCH_ASSET_FIELD} options off a property schema, or
 * `undefined` if the property is not an asset field.
 *
 * An asset field's value is an atomic media reference — a single object like
 * Webflow's `{ fileId, url, alt }`, or an array of such objects (MultiImage) —
 * that the external service requires to be written **whole**: a bare `{ alt }`
 * with no `url`/`fileId` is rejected as malformed. This accessor is how the
 * publish diff (`computeChangedFields`) and the asset-extraction walk recognise
 * that shape. It mirrors {@link getArrayKeyedByOptions}: it looks on the property
 * directly, on its array `items` (the array-of-assets pattern), and inside its
 * `anyOf`/`oneOf` members (the nullable pattern keeps the annotation on the
 * object member — `Type.Union([Type.Object(...), Type.Null()])`).
 */
export function getAssetFieldOptions(propSchema: unknown): AssetFieldOptions | undefined {
  if (!isPlainRecordSchema(propSchema)) return undefined;

  const direct = propSchema[X_SCRATCH_ASSET_FIELD];
  if (isAssetFieldOptions(direct)) return direct;

  const fromItems = getAssetFieldOptions(propSchema['items']);
  if (fromItems) return fromItems;

  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    const union = propSchema[unionKey];
    if (!Array.isArray(union)) continue;
    for (const member of union) {
      const found = getAssetFieldOptions(member);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Options for a table-level asset annotation.
 * Dot-notation paths (e.g. 'media_details.width') are resolved against the record content.
 */
export interface AssetTableOptions {
  /** Path to the asset URL within the record. */
  urlPath: string;
  /** Path to the filename (null = not available). */
  filenamePath: string | null;
  /** Path to the MIME type (null = not available). */
  mimeTypePath: string | null;
  /** Path to the file size in bytes (null = not available). */
  sizePath: string | null;
  /** Path to the image width (null = not available). */
  widthPath: string | null;
  /** Path to the image height (null = not available). */
  heightPath: string | null;
  /** Path to the alt text (null = not available). */
  altTextPath: string | null;
  /** Whether the asset URL expires. */
  urlExpires: boolean;
}

/**
 * An object desribing a foreign key option for a field.

 */
export interface ForeignKeyOptionSchema {
  linkedTableId: string;
  /**
   * Remote field id of the RECIPROCAL foreign key on the linked table, for services whose
   * link fields are symmetric (Airtable auto-creates a mirror link on the other table;
   * Notion's `dual_property` relations carry a `synced_property_id`). The two sides of one
   * relationship mutually reference each other's remote field id, which lets the create-plan
   * generator recognize a reciprocal pair and suggest only ONE side instead of both
   * (DEV-10753). Absent for one-way / non-symmetric links (Webflow, HubSpot, Notion
   * `single_property`, Postgres), which are never deduplicated.
   */
  inverseFieldId?: string;
  /**
   * Whether THIS side of the link references a single linked record rather than a list of
   * them (Airtable `prefersSingleRecordLink`). Used to pick the more-normalized side of a
   * reciprocal 1→N pair: the single-valued side is the foreign key on the many-side row, so
   * it is the one kept. Absent/false ⇒ multi-valued (Airtable's default, and every Notion
   * relation).
   */
  isSingleValued?: boolean;
  /**
   * Dot path — **in the TARGET record** — of the field this foreign key's value matches.
   *
   * Absent (the default, and what every connector but Framer emits) means the value IS the
   * target's remote id, i.e. the value at the target table spec's `idPath`. Set it when a
   * service's reference field names its target by something else: Framer's reference fields
   * read back the target item's `slug`, so they declare `'slug'`; a Postgres foreign key
   * declared onto a non-primary-key unique column would declare that column.
   *
   * This is about the value's SEMANTICS, not its shape. A reference whose value merely
   * *contains* the id (Notion's `relation[].id`, Attio's `target_record_id`) is already
   * handled by the column's view codec / `displayTransformer`, which extracts the id before
   * resolution — such a field must NOT set this.
   *
   * The path must identify a target record UNIQUELY. Two target records sharing a value is a
   * data error, not a tiebreak: the reference resolves to nothing and the collision is named
   * in the error. Matching is exact — no case folding, no trimming — and there is deliberately
   * no fallback to id matching, so resolution stays predictable and testable.
   */
  targetKeyPath?: string;
}

/**
 * A virtual field definition that provides a human-readable label and pre-configured
 * transformer for a complex schema field (e.g. Notion title arrays → plain string).
 */
export interface VirtualFieldDef {
  displayLabel: string;
  type: string;
  suggestedTransformer: TransformerConfig;
}
