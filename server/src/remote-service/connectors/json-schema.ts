import { TransformerConfig } from '@spinner/shared-types';

/**
 * Field metadata keys for connector JSON schemas
 */

// A field is readonly if the value of this key is true.
export const READONLY_FLAG = 'x-scratch-readonly';

// The native, connector-specific data type of the field.
export const CONNECTOR_DATA_TYPE = 'x-scratch-connector-data-type';

// An object describing a foreign key configuration for a field.
export const FOREIGN_KEY_OPTIONS = 'x-scratch-foreign-key';

// The remote field ID from the external service (e.g. Airtable fldXXX, Webflow hex hash, Notion property ID).
export const REMOTE_FIELD_ID = 'x-scratch-remote-field-id';

// The suggested transformer to auto-apply when this field is selected as a source in the sync editor.
export const SUGGESTED_TRANSFORMER = 'x-scratch-suggested-transformer';

// An array of virtual field definitions that provide human-readable shortcuts for complex nested fields.
export const VIRTUAL_FIELDS = 'x-scratch-virtual-fields';

// Marks a field as containing file/media assets that should be indexed.
export const ASSET_FIELD = 'x-scratch-asset-field';

// Marks a table whose records ARE assets (e.g. WordPress media, Webflow Assets).
export const ASSET_TABLE = 'x-scratch-asset-table';

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
