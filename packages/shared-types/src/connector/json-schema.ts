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

// An array of virtual field definitions that provide human-readable shortcuts for complex nested fields.
export const X_SCRATCH_VIRTUAL_FIELDS = 'x-scratch-virtual-fields';

// The maximum length of a string field as enforced by the external service (e.g. PostgreSQL VARCHAR(n)).
export const X_SCRATCH_MAX_LENGTH = 'x-scratch-max-length';

// Marks a field as containing file/media assets that should be indexed.
export const X_SCRATCH_ASSET_FIELD = 'x-scratch-asset-field';

// Marks a table whose records ARE assets (e.g. WordPress media, Webflow Assets).
export const X_SCRATCH_ASSET_TABLE = 'x-scratch-asset-table';

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
