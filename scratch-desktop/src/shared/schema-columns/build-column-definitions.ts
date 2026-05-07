import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_PREFIX,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
} from '@spinner/shared-types';
import type { ColumnAttributes, ColumnDataType, ColumnDefinition } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hasXScratchExtension(prop: Record<string, unknown>): boolean {
  for (const key of Object.keys(prop)) {
    if (key.startsWith(X_SCRATCH_PREFIX)) return true;
  }
  return false;
}

function normalizeTypeValue(rawType: unknown): ColumnDataType {
  if (typeof rawType === 'string') {
    switch (rawType) {
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'array':
      case 'object':
        return rawType;
      default:
        return 'unknown';
    }
  }
  if (Array.isArray(rawType)) {
    for (const candidate of rawType) {
      if (typeof candidate === 'string' && candidate !== 'null') {
        return normalizeTypeValue(candidate);
      }
    }
  }
  return 'unknown';
}

interface EffectiveType {
  dataType: ColumnDataType;
  format?: string;
}

/**
 * Resolves the effective runtime data type of a property schema.
 *
 * Supports:
 *   - Direct `type` (string or array form, e.g. `'string'` or `['string', 'null']`).
 *   - `anyOf` / `oneOf` union members — picks the first non-`null` member and recurses, which
 *     covers the nullable-field pattern emitted by Supabase, Moco, Shopify, and HubSpot
 *     connectors, e.g. `anyOf: [{ type: 'string' }, { type: 'null' }]`.
 *
 * Also promotes `format` (e.g. `date-time`) from whichever level declared it — outer property
 * wins, otherwise the first non-null union member that carries one.
 */
function resolveEffectiveType(propSchema: Record<string, unknown>): EffectiveType {
  const outerFormat = getString(propSchema.format);

  if (propSchema.type !== undefined) {
    return { dataType: normalizeTypeValue(propSchema.type), format: outerFormat };
  }

  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    const union = propSchema[unionKey];
    if (!Array.isArray(union)) continue;
    for (const member of union) {
      if (!isPlainObject(member)) continue;
      if (member.type === 'null') continue;
      const resolved = resolveEffectiveType(member);
      if (resolved.dataType !== 'unknown') {
        return { dataType: resolved.dataType, format: outerFormat ?? resolved.format };
      }
    }
  }

  return { dataType: 'unknown', format: outerFormat };
}

function parseForeignKey(value: unknown): { linkedTableId: string } | undefined {
  if (!isPlainObject(value)) return undefined;
  const linkedTableId = getString(value.linkedTableId);
  return linkedTableId ? { linkedTableId } : undefined;
}

function parseRemoteFieldId(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) {
    return value;
  }
  return undefined;
}

/**
 * Parses a Scratch table-wrapper `schema.json` (the object that contains `schema`, `titleColumnRemoteId`,
 * `idColumnRemoteId`, etc.) into an ordered list of `ColumnDefinition`s.
 *
 * Recursion rules:
 *   - Recurse into a nested `type: 'object'` property **only** when it has inline `.properties`
 *     and carries **no** `x-scratch-*` metadata. This keeps Airtable-style `{ fields: { ... } }` and
 *     HubSpot-style `{ properties: { ... } }` containers expanding into `fields.<name>` leaves while
 *     preserving connector-annotated sub-objects (Moco `company`, HubSpot `associations`) as single
 *     leaf columns that render as JSON.
 *   - Objects nested inside `anyOf`/`oneOf` (Shopify `category`, Supabase nullable fields, etc.) are
 *     always treated as leaves because their `.properties` are not hoisted to the outer schema.
 *
 * Never throws. Returns `[]` when the wrapper or inner schema is malformed.
 */
export function buildColumnDefinitions(wrapper: unknown): ColumnDefinition[] {
  if (!isPlainObject(wrapper)) return [];
  const inner = wrapper.schema;
  if (!isPlainObject(inner)) return [];
  return walkProperties(inner, '');
}

function walkProperties(schema: Record<string, unknown>, prefix: string): ColumnDefinition[] {
  const properties = schema.properties;
  if (!isPlainObject(properties)) return [];

  const requiredSet = new Set<string>(
    Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [],
  );

  const results: ColumnDefinition[] = [];

  for (const [key, rawProp] of Object.entries(properties)) {
    if (!isPlainObject(rawProp)) continue;
    const id = prefix ? `${prefix}.${key}` : key;
    const effective = resolveEffectiveType(rawProp);
    const isContainer =
      effective.dataType === 'object' && isPlainObject(rawProp.properties) && !hasXScratchExtension(rawProp);

    if (isContainer) {
      results.push(...walkProperties(rawProp, id));
      continue;
    }

    const attributes: ColumnAttributes = {
      readOnly: rawProp[X_SCRATCH_READONLY] === true,
      required: requiredSet.has(key),
      connectorDataType: getString(rawProp[X_SCRATCH_CONNECTOR_DATA_TYPE]),
      remoteFieldId: parseRemoteFieldId(rawProp[X_SCRATCH_REMOTE_FIELD_ID]),
      foreignKey: parseForeignKey(rawProp[X_SCRATCH_FOREIGN_KEY_OPTIONS]),
      nested: prefix.length > 0,
    };

    results.push({
      id,
      displayName: getString(rawProp.title) ?? key,
      description: getString(rawProp.description),
      dataType: effective.dataType,
      format: effective.format,
      attributes,
    });
  }

  return results;
}
