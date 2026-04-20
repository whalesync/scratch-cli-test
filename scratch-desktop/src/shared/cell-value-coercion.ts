type JsonSchemaRecord = Record<string, unknown>;

export type CellInputSchemaKind = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array' | 'unknown';

/**
 * Shared legacy cell-input coercion used by older string round-trip flows.
 * This intentionally preserves the pre-schema behavior exactly: trim before
 * parsing, try JSON.parse, and fall back to the original string.
 */
export function coerceCellInputText(input: string): unknown {
  const trimmed = input.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

export class CellInputCoercionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CellInputCoercionError';
  }
}

export function coerceCellInputTextWithSchema(
  folderSchema: JsonSchemaRecord | null,
  fieldPath: string,
  input: string,
): unknown {
  const fieldSchema = resolveFieldSchema(folderSchema, fieldPath);
  if (!fieldSchema) {
    return input;
  }

  const kinds = resolveSchemaKinds(fieldSchema);
  return coerceByKinds(fieldPath, kinds, input);
}

function coerceByKinds(fieldPath: string, kinds: CellInputSchemaKind[], input: string): unknown {
  const normalizedKinds = normalizeKinds(kinds);
  const nonNullKinds = normalizedKinds.filter((kind) => kind !== 'null');
  const trimmed = input.trim();

  if (normalizedKinds.length === 0 || normalizedKinds.includes('unknown')) {
    return input;
  }

  if (trimmed === '') {
    if (normalizedKinds.includes('string')) {
      return input;
    }
    if (normalizedKinds.includes('null')) {
      return null;
    }
  }

  if (trimmed === 'null' && normalizedKinds.includes('null')) {
    return null;
  }

  if (nonNullKinds.length === 0) {
    throw new CellInputCoercionError(`Field "${fieldPath}" expects null.`);
  }

  if (nonNullKinds.includes('string')) {
    if (nonNullKinds.length === 1) {
      return input;
    }

    // For unions like string | null, prefer the exact text unless the user
    // explicitly typed `null`.
    return input;
  }

  if (nonNullKinds.length === 1) {
    return coerceSingleKind(fieldPath, nonNullKinds[0], trimmed);
  }

  const onlyNumericKinds = nonNullKinds.every((kind) => kind === 'integer' || kind === 'number');
  if (onlyNumericKinds) {
    const parsed = parseJsonValue(fieldPath, trimmed, describeKinds(normalizedKinds));
    if (typeof parsed !== 'number') {
      throw new CellInputCoercionError(`Field "${fieldPath}" expects ${describeKinds(normalizedKinds)}.`);
    }
    if (!nonNullKinds.includes('number') && !Number.isInteger(parsed)) {
      throw new CellInputCoercionError(`Field "${fieldPath}" expects an integer.`);
    }
    return parsed;
  }

  const parsed = parseJsonValue(fieldPath, trimmed, describeKinds(normalizedKinds));
  const parsedKind = getRuntimeKind(parsed);

  if (parsedKind === 'number') {
    const allowsNumber = nonNullKinds.includes('number');
    const allowsInteger = nonNullKinds.includes('integer');
    if (allowsNumber) return parsed;
    if (allowsInteger && Number.isInteger(parsed)) return parsed;
    throw new CellInputCoercionError(`Field "${fieldPath}" expects ${describeKinds(normalizedKinds)}.`);
  }

  if (parsedKind !== 'null' && nonNullKinds.includes(parsedKind)) {
    return parsed;
  }

  throw new CellInputCoercionError(`Field "${fieldPath}" expects ${describeKinds(normalizedKinds)}.`);
}

function coerceSingleKind(fieldPath: string, kind: CellInputSchemaKind, trimmed: string): unknown {
  switch (kind) {
    case 'string':
      return trimmed;
    case 'number': {
      const parsed = parseJsonValue(fieldPath, trimmed, 'a number');
      if (typeof parsed === 'number') return parsed;
      break;
    }
    case 'integer': {
      const parsed = parseJsonValue(fieldPath, trimmed, 'an integer');
      if (typeof parsed === 'number' && Number.isInteger(parsed)) return parsed;
      break;
    }
    case 'boolean': {
      const parsed = parseJsonValue(fieldPath, trimmed, '"true" or "false"');
      if (typeof parsed === 'boolean') return parsed;
      break;
    }
    case 'null':
      break;
    case 'object': {
      const parsed = parseJsonValue(fieldPath, trimmed, 'a JSON object');
      if (getRuntimeKind(parsed) === 'object') return parsed;
      break;
    }
    case 'array': {
      const parsed = parseJsonValue(fieldPath, trimmed, 'a JSON array');
      if (Array.isArray(parsed)) return parsed;
      break;
    }
    case 'unknown':
      return trimmed;
  }

  throw new CellInputCoercionError(`Field "${fieldPath}" expects ${describeKinds([kind])}.`);
}

function parseJsonValue(fieldPath: string, trimmed: string, expected: string): unknown {
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new CellInputCoercionError(`Field "${fieldPath}" expects ${expected}.`);
  }
}

function normalizeKinds(kinds: CellInputSchemaKind[]): CellInputSchemaKind[] {
  const unique = Array.from(new Set(kinds));
  if (unique.length > 1) {
    return unique.filter((kind) => kind !== 'unknown');
  }
  return unique;
}

function describeKinds(kinds: CellInputSchemaKind[]): string {
  const normalized = normalizeKinds(kinds);
  const labels = normalized.map((kind) => {
    switch (kind) {
      case 'string':
        return 'text';
      case 'number':
        return 'a number';
      case 'integer':
        return 'an integer';
      case 'boolean':
        return '"true" or "false"';
      case 'null':
        return 'null';
      case 'object':
        return 'a JSON object';
      case 'array':
        return 'a JSON array';
      case 'unknown':
        return 'text';
    }
  });

  if (labels.length === 0) return 'text';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}

function resolveFieldSchema(folderSchema: JsonSchemaRecord | null, fieldPath: string): JsonSchemaRecord | null {
  const parts = fieldPath.split('.');
  let current: JsonSchemaRecord | null = unwrapFolderSchema(folderSchema);

  for (const part of parts) {
    const objectSchema = pickObjectSchema(current);
    if (!objectSchema) {
      return null;
    }

    const properties = objectSchema.properties;
    if (!isRecord(properties)) {
      return null;
    }

    const next = properties[part];
    if (!isRecord(next)) {
      return null;
    }

    current = next;
  }

  return current;
}

function unwrapFolderSchema(folderSchema: JsonSchemaRecord | null): JsonSchemaRecord | null {
  if (!isRecord(folderSchema)) {
    return null;
  }

  const nested = folderSchema.schema;
  if (isRecord(nested)) {
    return nested;
  }

  return folderSchema;
}

function pickObjectSchema(schema: JsonSchemaRecord | null): JsonSchemaRecord | null {
  if (!isRecord(schema)) {
    return null;
  }

  if (
    schema.type === 'object' ||
    (Array.isArray(schema.type) && schema.type.includes('object')) ||
    isRecord(schema.properties)
  ) {
    return schema;
  }

  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = schema[unionKey];
    if (!Array.isArray(variants)) {
      continue;
    }

    for (const variant of variants) {
      const objectVariant = pickObjectSchema(isRecord(variant) ? variant : null);
      if (objectVariant) {
        return objectVariant;
      }
    }
  }

  return null;
}

function resolveSchemaKinds(schema: JsonSchemaRecord): CellInputSchemaKind[] {
  const kinds = new Set<CellInputSchemaKind>();
  collectSchemaKinds(schema, kinds);
  return kinds.size > 0 ? Array.from(kinds) : ['unknown'];
}

function collectSchemaKinds(schema: JsonSchemaRecord | null, kinds: Set<CellInputSchemaKind>): void {
  if (!isRecord(schema)) {
    return;
  }

  const schemaType = schema.type;
  if (typeof schemaType === 'string') {
    kinds.add(mapSchemaType(schemaType));
  } else if (Array.isArray(schemaType)) {
    for (const typeValue of schemaType) {
      if (typeof typeValue === 'string') {
        kinds.add(mapSchemaType(typeValue));
      }
    }
  }

  if ('const' in schema) {
    kinds.add(getRuntimeKind(schema.const));
  }

  if (isRecord(schema.properties)) {
    kinds.add('object');
  }

  if ('items' in schema) {
    kinds.add('array');
  }

  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = schema[unionKey];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      if (isRecord(variant)) {
        collectSchemaKinds(variant, kinds);
      }
    }
  }
}

function mapSchemaType(type: string): CellInputSchemaKind {
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
    case 'object':
    case 'array':
      return type;
    default:
      return 'unknown';
  }
}

function getRuntimeKind(value: unknown): CellInputSchemaKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'unknown';
  }
}

function isRecord(value: unknown): value is JsonSchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
