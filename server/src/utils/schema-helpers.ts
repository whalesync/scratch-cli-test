import { TSchema } from '@sinclair/typebox';
import { TransformerConfig } from '@spinner/shared-types';
import type { ForeignKeyOptionSchema, VirtualFieldDef } from '../remote-service/connectors/json-schema';
import {
  FOREIGN_KEY_OPTIONS,
  READONLY_FLAG,
  REMOTE_FIELD_ID,
  SUGGESTED_TRANSFORMER,
  VIRTUAL_FIELDS,
} from '../remote-service/connectors/json-schema';

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
  suggestedTransformer?: TransformerConfig;
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
    const remoteFieldId = schema[REMOTE_FIELD_ID] as string | undefined;
    if (remoteFieldId) field.remoteFieldId = remoteFieldId;
    const suggested = schema[SUGGESTED_TRANSFORMER] as TransformerConfig | undefined;
    if (suggested) field.suggestedTransformer = suggested;
    if (schema[READONLY_FLAG] === true) field.readonly = true;
    const fk = schema[FOREIGN_KEY_OPTIONS] as ForeignKeyOptionSchema | undefined;
    if (fk?.linkedTableId) field.foreignKey = { linkedTableId: fk.linkedTableId };

    // Virtual fields: overwrite the entry with a human-readable label and pre-configured transformer
    const virtualDefs = schema[VIRTUAL_FIELDS] as VirtualFieldDef[] | undefined;
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

  // Object Traverse
  if (schema.type === 'object' && schema.properties) {
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
