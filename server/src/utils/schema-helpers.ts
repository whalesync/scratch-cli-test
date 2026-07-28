import { TSchema } from '@sinclair/typebox';
import type { ForeignKeyOptionSchema, VirtualFieldDef } from '@spinner/shared-types';
import {
  parseFilterSegment,
  TransformerConfig,
  X_SCRATCH_AIRTABLE_FIELD_ORDER,
  X_SCRATCH_ASSET_TABLE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_PREFIX,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
  X_SCRATCH_VIRTUAL_FIELDS,
  type PackInputPrimitive,
} from '@spinner/shared-types';
import { keyedArrayItemSchema, segmentFieldPathAgainstSchema } from 'src/utils/field-path';

/**
 * `x-scratch-*` keys that annotate a CONTAINER node — an object whose properties
 * are real sub-fields/columns — rather than a value envelope. An object carrying
 * ONLY these must still be recursed into, so they are excluded from the leaf guard
 * below:
 *  - `x-scratch-airtable-field-order` sits on Airtable's `fields` wrapper (the
 *    record's column container); treating it as a leaf hides every `fields.*`
 *    column, which broke resolving created columns for new Airtable tables.
 *  - `x-scratch-asset-table` sits on an asset-table root (Webflow Assets, WordPress
 *    media); its records still have real columns to expand.
 */
const CONTAINER_LEVEL_X_SCRATCH_KEYS: ReadonlySet<string> = new Set([
  X_SCRATCH_AIRTABLE_FIELD_ORDER,
  X_SCRATCH_ASSET_TABLE,
]);

/**
 * True if the schema node is an opaque connector VALUE ENVELOPE — a single field,
 * not a container to recurse into (e.g. a Notion property envelope
 * `{ id, type, <typeKey>: value }` tagged with `x-scratch-connector-data-type`).
 *
 * Used as a leaf guard. Mirrors the desktop `build-column-definitions.ts` guard so
 * the server and desktop agree on leaf granularity. A node carrying only
 * container-level annotations (see {@link CONTAINER_LEVEL_X_SCRATCH_KEYS}) — or no
 * x-scratch metadata at all (HubSpot `properties`) — is NOT an envelope and still
 * expands into its per-field leaves.
 */
function isOpaqueConnectorEnvelope(schema: TSchema): boolean {
  for (const key of Object.keys(schema)) {
    if (key.startsWith(X_SCRATCH_PREFIX) && !CONTAINER_LEVEL_X_SCRATCH_KEYS.has(key)) return true;
  }
  return false;
}

/**
 * Extracts all possible dot-notation paths from a JSON Schema.
 * E.g. { a: { b: 1 } } -> ['a', 'a.b']
 */
export function extractSchemaPaths(schema: TSchema, parentPath = ''): string[] {
  const paths = new Set<string>();

  // Base Path (if meaningful)
  if (parentPath) {
    paths.add(parentPath);
  }

  // Handle Unions (anyOf/oneOf/Optional)
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf || schema.oneOf) as TSchema[];
    for (const variant of variants) {
      if (variant.type === 'null') continue;
      const subPaths = extractSchemaPaths(variant, parentPath);
      subPaths.forEach((p) => paths.add(p));
    }
  }

  // Object Traverse
  if (schema.type === 'object' && schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, TSchema>)) {
      const currentPath = parentPath ? `${parentPath}.${key}` : key;
      const subPaths = extractSchemaPaths(propSchema, currentPath);
      subPaths.forEach((p) => paths.add(p));
    }
  }

  // Array Traverse (Experimental/Partial)
  // If array, we generally map to the array itself (already added via parentPath).
  // Deep mapping into arrays (array[].prop) is not yet standard in this mapper.

  return Array.from(paths);
}

export interface SchemaField {
  path: string;
  type: string;
  /**
   * The JSON-Schema `format` annotation on this field's (non-null) value, when the
   * connector emits one — e.g. `'date-time'` for a wall-clock timestamp vs `'date'`
   * for a plain calendar date. Lets a downstream consumer tell a datetime apart from
   * a date-only value even though both share the coarse `'date'` display hint.
   */
  format?: string;
  displayLabel?: string;
  description?: string;
  remoteFieldId?: string;
  /** Unpack transform applied when this field is a sync source (native → plain). */
  suggestedTransformer?: TransformerConfig;
  /** Pack transform applied when this field is a sync destination (plain → native). */
  suggestedInTransformer?: TransformerConfig;
  /** The CoreValue primitive `suggestedInTransformer` consumes (`'string'`/`'number'`/`'boolean'`), when declared. */
  suggestedInTransformerInputType?: PackInputPrimitive;
  readonly?: boolean;
  foreignKey?: { linkedTableId: string; inverseFieldId?: string; isSingleValued?: boolean };
}

/**
 * Resolves the type from a JSON Schema, unwrapping anyOf/oneOf unions
 * (e.g. nullable types like `Union([String, Null])`) to find the real type.
 */
function resolveSchemaType(schema: TSchema): string {
  if (schema.type) return schema.type as string;
  const variants = (schema.anyOf || schema.oneOf) as TSchema[] | undefined;
  if (variants) {
    const real = variants.filter((s) => s.type !== 'null');
    if (real.length >= 1) return resolveSchemaType(real[0]);
  }
  return 'unknown';
}

/**
 * Resolves the string `format` annotation from a JSON Schema, unwrapping anyOf/oneOf
 * unions to find the format on the real (non-null) variant. Checks the node itself
 * first — plain non-union strings carry `format` directly (HubSpot `createdAt`,
 * Airtable `createdTime`) — then each non-null variant (Webflow/Shopify/HubSpot put
 * it on the inner `String` of a nullable union). Returns undefined when no variant
 * declares a format.
 */
function resolveSchemaFormat(schema: TSchema): string | undefined {
  if (typeof schema.format === 'string') return schema.format;
  const variants = (schema.anyOf || schema.oneOf) as TSchema[] | undefined;
  if (variants) {
    for (const variant of variants) {
      if (variant.type === 'null') continue;
      const found = resolveSchemaFormat(variant);
      if (found) return found;
    }
  }
  return undefined;
}

/** The child schema at `key` under an object node, unwrapping nullable anyOf/oneOf unions to find `.properties`. */
function propertySchemaAt(schema: TSchema | undefined, key: string): TSchema | undefined {
  if (!schema) return undefined;
  // A keyed-array filter segment `[<keyField>=<key>]` descends into the array's
  // shared element schema, not a property named `[…]` (mirrors
  // getSchemaAtFieldPath so plan-side type resolution and save-side validation
  // agree — the DEV-11030 symmetry lesson, now for keyed arrays / DEV-11062).
  if (parseFilterSegment(key)) return keyedArrayItemSchema(schema);
  const properties = schema.properties as Record<string, TSchema> | undefined;
  if (properties?.[key]) return properties[key];
  const variants = (schema.anyOf || schema.oneOf) as TSchema[] | undefined;
  if (variants) {
    for (const variant of variants) {
      if (variant.type === 'null') continue;
      const found = propertySchemaAt(variant, key);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Resolve the JSON type at a dot-path inside a JSON schema, drilling through object
 * `properties` (and unwrapping nullable anyOf/oneOf unions) at each segment — INCLUDING
 * past a connector-annotated envelope, unlike {@link extractSchemaFields}'s leaf guard.
 * Returns the JSON type (`'string'|'number'|'array'|'object'|…`) at the path, or `'unknown'`
 * when any segment is missing.
 *
 * This is what makes a mapping's cardinality readable at the exact DRILLED path it
 * references: a Notion `multi_select` column at `properties.X.multi_select` resolves to
 * `'array'` (multi-valued) even though its envelope `properties.X` is an `'object'`.
 */
export function resolveSchemaTypeAtPath(schema: TSchema, dotPath: string): string {
  if (!dotPath) return resolveSchemaType(schema);
  let node: TSchema | undefined = schema;
  // Segment against the schema's real property names rather than a naive
  // `split('.')`, so a field literally named `col.with.dots` resolves to its flat
  // property instead of a nested `col → with → dots` miss (DEV-10959). Descent
  // stays on propertySchemaAt to keep its oneOf / past-envelope drilling.
  for (const segment of segmentFieldPathAgainstSchema(schema, dotPath)) {
    node = propertySchemaAt(node, segment);
    if (!node) return 'unknown';
  }
  return resolveSchemaType(node);
}

/**
 * Extracts all possible dot-notation paths from a JSON Schema with their types.
 */
export function extractSchemaFields(schema: TSchema, parentPath = ''): SchemaField[] {
  const fields = new Map<string, SchemaField>();

  // Base Path (if meaningful)
  if (parentPath) {
    const field: SchemaField = { path: parentPath, type: resolveSchemaType(schema) };
    const format = resolveSchemaFormat(schema);
    if (format) field.format = format;
    if (schema.description) field.description = schema.description;
    const remoteFieldId = schema[X_SCRATCH_REMOTE_FIELD_ID] as string | undefined;
    if (remoteFieldId) field.remoteFieldId = remoteFieldId;
    const suggested = schema[X_SCRATCH_SUGGESTED_TRANSFORMER] as TransformerConfig | undefined;
    if (suggested) field.suggestedTransformer = suggested;
    const suggestedIn = schema[X_SCRATCH_SUGGESTED_IN_TRANSFORMER] as TransformerConfig | undefined;
    if (suggestedIn) field.suggestedInTransformer = suggestedIn;
    const suggestedInInputType = schema[X_SCRATCH_SUGGESTED_IN_TRANSFORMER_INPUT_TYPE] as
      | PackInputPrimitive
      | undefined;
    if (suggestedInInputType) field.suggestedInTransformerInputType = suggestedInInputType;
    if (schema[X_SCRATCH_READONLY] === true) field.readonly = true;
    const fk = schema[X_SCRATCH_FOREIGN_KEY_OPTIONS] as ForeignKeyOptionSchema | undefined;
    if (fk?.linkedTableId) {
      field.foreignKey = {
        linkedTableId: fk.linkedTableId,
        ...(fk.inverseFieldId !== undefined ? { inverseFieldId: fk.inverseFieldId } : {}),
        ...(fk.isSingleValued !== undefined ? { isSingleValued: fk.isSingleValued } : {}),
      };
    }

    // Virtual fields: overwrite the entry with a human-readable label and pre-configured transformer
    const virtualDefs = schema[X_SCRATCH_VIRTUAL_FIELDS] as VirtualFieldDef[] | undefined;
    if (virtualDefs?.length) {
      const vf = virtualDefs[0];
      field.displayLabel = vf.displayLabel;
      field.type = vf.type;
      field.suggestedTransformer = vf.suggestedTransformer;
    }

    fields.set(parentPath, field);
  }

  // Handle Unions (anyOf/oneOf/Optional)
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf || schema.oneOf) as TSchema[];
    for (const variant of variants) {
      if (variant.type === 'null') continue;
      const subFields = extractSchemaFields(variant, parentPath);
      subFields.forEach((f) => {
        if (!fields.has(f.path)) {
          fields.set(f.path, f);
        }
      });
    }
  }

  // Object Traverse — but treat a connector-annotated object as a single leaf.
  // A Notion property envelope `{ id, type, <typeKey>: value }` tagged with
  // `x-scratch-*` metadata would otherwise explode into `properties.X.id`,
  // `.type`, `.value` sub-fields and flip the field type to `object`, polluting
  // sync LLM mapping context, import matching, and the MCP folder-schema tool.
  if (schema.type === 'object' && schema.properties && !isOpaqueConnectorEnvelope(schema)) {
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, TSchema>)) {
      const currentPath = parentPath ? `${parentPath}.${key}` : key;
      const subFields = extractSchemaFields(propSchema, currentPath);
      subFields.forEach((f) => {
        if (!fields.has(f.path)) {
          fields.set(f.path, f);
        }
      });
    }
  }

  return Array.from(fields.values());
}

/**
 * Resolve a just-created Live Export destination field — a field addition or a
 * placeholder table's created column — to its {@link SchemaField} in the freshly
 * re-fetched destination schema.
 *
 * A created field is ALWAYS a real, writable connector column, so it must never
 * bind to the record ENVELOPE's read-only meta fields that happen to share a leaf
 * name. Since the Airtable record schema is expanded (commit 2556b0b9b),
 * {@link extractSchemaFields} emits the top-level meta paths (`id`, `fields`,
 * `createdTime`) alongside the real `fields.*` columns. A user field literally
 * named `id`/`fields` collides with a meta leaf, and matching by the last path
 * segment alone returned the top-level meta path FIRST — silently binding the sync
 * to Airtable's non-writable record id (the value never lands / apply hard-fails).
 *
 * Resolution order:
 *  1. Exact remote-field-id match when the created field's remote id is known (a
 *     field addition carries `resolved.remoteFieldId`) — unambiguous.
 *  2. Otherwise match by full field name / display label, preferring a real
 *     writable column (one carrying a remote field id, and not readonly) over an
 *     envelope meta field that shares the name.
 *
 * The name match compares against the field's WHOLE trailing name — the full path
 * (a flat schema, e.g. Supabase) or the segment after the wrapper prefix (an Airtable
 * `fields.<name>` column) — NOT `path.split('.').pop()`. A destination field name that
 * itself contains a `.` (`"No. of Employees"`, `"Est. Close Date"`) has more than one
 * dot-segment; taking only the last segment mangles the leaf and the created placeholder
 * field — which carries no `remoteFieldId` to fall back on — never resolves, hard-failing
 * apply with SYNC_DRAFT_FIELD_RESOLUTION_FAILED.
 */
export function findCreatedDestinationField(
  destinationFields: SchemaField[],
  target: { fieldName: string; remoteFieldId?: string },
): SchemaField | undefined {
  if (target.remoteFieldId) {
    const exactRemoteFieldIdMatch = destinationFields.find((field) => field.remoteFieldId === target.remoteFieldId);
    if (exactRemoteFieldIdMatch) return exactRemoteFieldIdMatch;
  }
  const fieldsMatchingByNameOrLabel = destinationFields.filter(
    (field) =>
      field.path === target.fieldName ||
      field.path.endsWith(`.${target.fieldName}`) ||
      field.displayLabel === target.fieldName,
  );
  if (fieldsMatchingByNameOrLabel.length <= 1) return fieldsMatchingByNameOrLabel[0];
  // Ambiguous name (record-envelope meta vs a real column): prefer the real
  // writable column. A genuine connector column carries a remote field id and is
  // not readonly; the top-level `id`/`fields`/`createdTime` meta carry neither.
  return (
    fieldsMatchingByNameOrLabel.find((field) => field.remoteFieldId !== undefined && !field.readonly) ??
    fieldsMatchingByNameOrLabel.find((field) => field.remoteFieldId !== undefined) ??
    fieldsMatchingByNameOrLabel.find((field) => !field.readonly) ??
    fieldsMatchingByNameOrLabel[0]
  );
}
