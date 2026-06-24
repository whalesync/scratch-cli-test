import { TSchema } from '@sinclair/typebox';
import type { ForeignKeyOptionSchema, VirtualFieldDef } from '@spinner/shared-types';
import {
  TransformerConfig,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_PREFIX,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
  X_SCRATCH_VIRTUAL_FIELDS,
} from '@spinner/shared-types';

/**
 * True if the schema node carries any `x-scratch-*` metadata key.
 *
 * Used as a leaf guard: a connector-annotated object (e.g. a Notion property
 * envelope `{ id, type, <typeKey>: value }` tagged with
 * `x-scratch-connector-data-type`) is a single field, not a container to
 * recurse into. Mirrors the desktop `build-column-definitions.ts` guard so the
 * server and desktop agree on leaf granularity. Plain wrapper objects that carry
 * no x-scratch metadata (Airtable `fields`, HubSpot `properties`) are not
 * matched and still expand into per-field leaves.
 */
function hasXScratchExtension(schema: TSchema): boolean {
  for (const key of Object.keys(schema)) {
    if (key.startsWith(X_SCRATCH_PREFIX)) return true;
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
  displayLabel?: string;
  description?: string;
  remoteFieldId?: string;
  /** Unpack transform applied when this field is a sync source (native → plain). */
  suggestedTransformer?: TransformerConfig;
  /** Pack transform applied when this field is a sync destination (plain → native). */
  suggestedInTransformer?: TransformerConfig;
  readonly?: boolean;
  foreignKey?: { linkedTableId: string };
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
 * Extracts all possible dot-notation paths from a JSON Schema with their types.
 */
export function extractSchemaFields(schema: TSchema, parentPath = ''): SchemaField[] {
  const fields = new Map<string, SchemaField>();

  // Base Path (if meaningful)
  if (parentPath) {
    const field: SchemaField = { path: parentPath, type: resolveSchemaType(schema) };
    if (schema.description) field.description = schema.description;
    const remoteFieldId = schema[X_SCRATCH_REMOTE_FIELD_ID] as string | undefined;
    if (remoteFieldId) field.remoteFieldId = remoteFieldId;
    const suggested = schema[X_SCRATCH_SUGGESTED_TRANSFORMER] as TransformerConfig | undefined;
    if (suggested) field.suggestedTransformer = suggested;
    const suggestedIn = schema[X_SCRATCH_SUGGESTED_IN_TRANSFORMER] as TransformerConfig | undefined;
    if (suggestedIn) field.suggestedInTransformer = suggestedIn;
    if (schema[X_SCRATCH_READONLY] === true) field.readonly = true;
    const fk = schema[X_SCRATCH_FOREIGN_KEY_OPTIONS] as ForeignKeyOptionSchema | undefined;
    if (fk?.linkedTableId) field.foreignKey = { linkedTableId: fk.linkedTableId };

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
  if (schema.type === 'object' && schema.properties && !hasXScratchExtension(schema)) {
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
