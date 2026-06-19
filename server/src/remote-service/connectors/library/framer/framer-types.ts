/**
 * Internal types for the Framer connector.
 *
 * Framer's Server API (beta) is a stateful WebSocket transport reached only through
 * the official `framer-api` SDK (there is no REST surface). These types are the
 * plain-data projections the connector extracts from the SDK's live class instances
 * (Collection / Field / CollectionItem) so nothing downstream depends on the SDK's
 * runtime objects or on the WebSocket connection staying open.
 */

/**
 * The fixed, finite set of Framer CMS field types (the SDK's `Field['type']`
 * discriminant). Which *fields* a collection has is discovered dynamically per
 * collection; the *types* themselves are this closed enum.
 */
export const FramerFieldType = {
  String: 'string',
  FormattedText: 'formattedText',
  Number: 'number',
  Boolean: 'boolean',
  Date: 'date',
  Color: 'color',
  Link: 'link',
  Enum: 'enum',
  Image: 'image',
  File: 'file',
  CollectionReference: 'collectionReference',
  MultiCollectionReference: 'multiCollectionReference',
  Array: 'array',
  Divider: 'divider',
  Unsupported: 'unsupported',
} as const;

export type FramerFieldTypeValue = (typeof FramerFieldType)[keyof typeof FramerFieldType];

/** Field types that are layout-only (no item data) — excluded from the record schema. */
export const NON_DATA_FRAMER_FIELD_TYPES = new Set<string>([FramerFieldType.Divider]);

/** Field types whose value is (or contains) a reference to another collection's items. */
export function isFramerReferenceFieldType(type: string): boolean {
  return type === FramerFieldType.CollectionReference || type === FramerFieldType.MultiCollectionReference;
}

/** Field types whose value reads back as an asset object but writes as a URL string. */
export function isFramerAssetFieldType(type: string): boolean {
  return type === FramerFieldType.Image || type === FramerFieldType.File;
}

/**
 * A single field's definition, projected from the SDK's `Field` instance into
 * plain data. `collectionId` is set only for reference fields (the target
 * collection); `cases` only for enum fields.
 */
export interface FramerFieldMeta {
  /** Stable field id — the key under which this field's value lives in `fieldData`. */
  id: string;
  /** Human-readable field name (display label). */
  name: string;
  /** One of {@link FramerFieldType}. */
  type: string;
  /** Target collection id, for `collectionReference` / `multiCollectionReference`. */
  collectionId?: string;
  /** Enum cases (`{ id, name }`), for `enum` fields. */
  cases?: { id: string; name: string }[];
}

/**
 * A collection's identity + its field definitions — everything
 * `fetchJsonTableSpec` needs to build the schema, projected off the live SDK
 * objects before the WebSocket closes.
 */
export interface FramerCollectionMeta {
  id: string;
  name: string;
  fields: FramerFieldMeta[];
}

/** The two credential params a Framer connection stores (both via `user_provided_params`). */
export interface FramerCredentials {
  /** Project URL, e.g. `https://framer.com/projects/<Name>--<hash>` — identifies the site. */
  projectUrl: string;
  /** Server API key generated per-site in Framer site settings (`fr_...`). */
  apiKey: string;
}

/**
 * The verbatim shape of a pulled Framer CMS item, as the SDK's `CollectionItem`
 * exposes it. Stored on disk unchanged (fidelity principle): `fieldData` is keyed
 * by field id, each entry a `{ type, value, valueByLocale }` wrapper. The editable
 * leaf is `fieldData.<fieldId>.value`.
 */
export interface FramerItemFile {
  id: string;
  nodeId?: string;
  slug: string;
  slugByLocale?: unknown;
  draft?: boolean;
  fieldData: Record<string, FramerFieldDataEntry>;
}

export interface FramerFieldDataEntry {
  type: string;
  value: unknown;
  valueByLocale?: unknown;
}

/**
 * Lookups for translating a field's stored (verbatim, read-shape) value into the
 * id Framer's write API requires. Framer reads enum values as the case **name**
 * and reference values as the target item's **slug**, but `addItems` rejects
 * those — it wants the case **id** / item **id**. Each inner map is keyed by both
 * the read value (name/slug) AND the id (identity), so a write is resolved
 * whether the stored value is the name/slug or already an id.
 */
export interface FramerWriteTranslationMaps {
  /** enum field id → (case name | case id) → case id */
  enumCaseIdByValue: Record<string, Record<string, string>>;
  /** reference field id → (target slug | target id) → target item id */
  refItemIdByValue: Record<string, Record<string, string>>;
}

/** Field types that require id-translation on write (read as name/slug, write as id). */
export function framerWriteNeedsIdTranslation(type: string): boolean {
  return (
    type === FramerFieldType.Enum ||
    type === FramerFieldType.CollectionReference ||
    type === FramerFieldType.MultiCollectionReference
  );
}
