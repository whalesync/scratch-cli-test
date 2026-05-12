import { Kind, TSchema } from '@sinclair/typebox';
import { TablePropertyType, TableView, TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';

// ── Priority fields per entity type ──
// Fields listed here appear first, in this order. Anything not listed goes after alphabetically.
const PRIORITY_FIELDS: Record<string, string[]> = {
  articles: ['title', 'id', 'description', 'author_id', 'state', 'url', 'created_at', 'updated_at'],
  collections: ['name', 'id', 'description', 'url', 'order', 'created_at', 'updated_at'],
  conversations: ['title', 'id', 'state', 'open', 'read', 'priority', 'admin_assignee_id', 'created_at', 'updated_at'],
};

// Fields that should be hidden by default — noisy or deeply nested data.
const HIDDEN_FIELDS = new Set([
  'workspace_id',
  'translated_content',
  'parent_ids',
  'statistics',
  'conversation_parts',
  'custom_attributes',
  'conversation_rating',
]);

/**
 * Build a default TableView for an Intercom entity type by reading the TypeBox schema.
 * Prioritizes important business fields, hides noisy metadata, and maps types.
 */
export function buildIntercomDefaultView(schema: TSchema, entityType: string): TableView {
  const properties: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const fieldIds = Object.keys(properties);
  const priority = PRIORITY_FIELDS[entityType] ?? [];
  const sorted = sortFields(fieldIds, priority);
  const cols: TableViewCol[] = [];

  for (const fieldId of sorted) {
    const fieldSchema = properties[fieldId];
    cols.push(buildCol(fieldId, fieldSchema));
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Sort field IDs so priority fields come first (in their defined order), then the rest alphabetically. */
function sortFields(fieldIds: string[], priority: string[]): string[] {
  const priorityIndex = new Map(priority.map((f, i) => [f, i]));
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
  rest.sort((a, b) => a.localeCompare(b));

  return [...inPriority, ...rest];
}

/** Map a TypeBox schema to a TablePropertyType based on Kind and format annotations. */
function mapType(fieldSchema: TSchema): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;

  const format = (fieldSchema as TSchema & { format?: string }).format;
  if (format === 'date-time') return 'date';
  if (format === 'uri') return 'url';

  const kind = fieldSchema[Kind];
  switch (kind) {
    case 'Boolean':
      return 'checkbox';
    case 'Number':
    case 'Integer':
      return 'number';
    case 'Array':
      return 'object';
    case 'Object':
      return 'object';
    case 'Record':
      return 'object';
    case 'Union': {
      const anyOf = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
      if (anyOf) {
        const nonNull = anyOf.find((s) => s[Kind] !== 'Null');
        if (nonNull) return mapType(nonNull);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Format a snake_case field ID as a human-readable column name. */
function formatFieldName(fieldId: string): string {
  return fieldId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Build a TableViewCol from a field ID and its TypeBox schema. */
function buildCol(fieldId: string, fieldSchema: TSchema): TableViewCol {
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;
  const hidden = HIDDEN_FIELDS.has(fieldId) || undefined;

  return {
    kind: 'col',
    path: fieldId,
    name: formatFieldName(fieldId),
    type: mapType(fieldSchema),
    readonly: isReadonly || undefined,
    hidden,
  };
}
