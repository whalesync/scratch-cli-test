import { Kind, TSchema } from '@sinclair/typebox';
import { TablePropertyType, TableView, TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';

// Priority order for fields — fields listed here appear first in the defined order.
const FIELD_PRIORITY: string[] = ['email', 'id', 'tags', 'status', 'source', 'country', 'created_at', 'updated_at'];

// Fields hidden by default — low-value or internal identifiers.
const HIDDEN_FIELDS = new Set(['uid', 'extra_data', 'double_opt_in', 'bounced']);

/**
 * Build a default TableView for the Audienceful People table.
 * The view is schema-driven: it reads `schema.properties` to discover fields,
 * applies priority ordering, hides internal fields, and maps types.
 */
export function buildAudiencefulDefaultView(schema: TSchema): TableView {
  const topLevel: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const fieldIds = Object.keys(topLevel);
  const sorted = sortFields(fieldIds);

  const cols: TableViewCol[] = [];
  for (const fieldId of sorted) {
    cols.push(buildCol(fieldId, topLevel[fieldId]));
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Sort fields: priority fields first (in defined order), then the rest in schema order. */
function sortFields(fieldIds: string[]): string[] {
  const priorityIndex = new Map(FIELD_PRIORITY.map((f, i) => [f, i]));
  const inPriority: string[] = [];
  const rest: string[] = [];

  for (const id of fieldIds) {
    if (priorityIndex.has(id)) {
      inPriority.push(id);
    } else {
      rest.push(id);
    }
  }

  inPriority.sort((a, b) => priorityIndex.get(a)! - priorityIndex.get(b)!);
  return [...inPriority, ...rest];
}

/** Format a snake_case field name as Title Case. */
function formatFieldName(fieldId: string): string {
  return fieldId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Map a schema field to a TablePropertyType based on Kind and format annotations. */
function mapFieldType(fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;

  // Check format first (works on the schema itself or on Union members)
  const format = resolveFormat(fieldSchema);
  if (format === 'date-time') return 'date';

  const kind = fieldSchema[Kind] as string | undefined;
  if (kind === 'Boolean') return 'checkbox';
  if (kind === 'Number' || kind === 'Integer') return 'number';
  if (kind === 'Array' || kind === 'Object') return 'object';

  // For Union types, inspect the non-Null member
  if (kind === 'Union') {
    const anyOf = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
    if (anyOf) {
      const nonNull = anyOf.find((s) => s[Kind] !== 'Null');
      if (nonNull) return mapFieldType(nonNull);
    }
    return 'object';
  }

  return undefined;
}

/** Resolve the `format` annotation, looking into Union members if necessary. */
function resolveFormat(schema: TSchema): string | undefined {
  const direct = (schema as TSchema & { format?: string }).format;
  if (direct) return direct;

  const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    for (const member of anyOf) {
      const f = (member as TSchema & { format?: string }).format;
      if (f) return f;
    }
  }
  return undefined;
}

/** Build a TableViewCol for a single field. */
function buildCol(fieldId: string, fieldSchema: TSchema | undefined): TableViewCol {
  const hidden = HIDDEN_FIELDS.has(fieldId) || undefined;
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true || undefined;

  return {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapFieldType(fieldSchema),
    hidden,
    readonly: isReadonly,
  };
}
