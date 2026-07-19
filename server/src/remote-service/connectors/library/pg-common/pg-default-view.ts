import { TSchema } from '@sinclair/typebox';
import {
  PostgresColumnType,
  TablePropertyType,
  TableView,
  TableViewCol,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';

// Common column names that should appear first, in order.
// These cover typical conventions across ORMs, frameworks, and hand-written schemas.
const PRIORITY_COLUMNS = [
  'id',
  'name',
  'title',
  'display_name',
  'label',
  'slug',
  'email',
  'username',
  'status',
  'type',
  'description',
  'created_at',
  'updated_at',
];

/**
 * Build a generic default TableView for a PostgreSQL/Supabase table.
 * Since table schemas are user-defined, this uses convention-based heuristics
 * rather than entity-specific configuration.
 */
export function buildPgDefaultView(schema: TSchema): TableView {
  const properties: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const fieldIds = Object.keys(properties);
  const sorted = sortFields(fieldIds);
  const cols: TableViewCol[] = [];

  for (const fieldId of sorted) {
    const fieldSchema = properties[fieldId];
    cols.push(buildCol(fieldId, fieldSchema));
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Sort field IDs so priority columns come first (in their defined order), then the rest in original order. */
function sortFields(fieldIds: string[]): string[] {
  const priorityIndex = new Map(PRIORITY_COLUMNS.map((f, i) => [f, i]));
  const inPriority: string[] = [];
  const rest: string[] = [];

  for (const id of fieldIds) {
    if (priorityIndex.has(id)) {
      inPriority.push(id);
    } else {
      rest.push(id);
    }
  }

  inPriority.sort((a, b) => (priorityIndex.get(a) ?? 0) - (priorityIndex.get(b) ?? 0));
  // Keep non-priority fields in their original column order from the database
  return [...inPriority, ...rest];
}

/** Map a PostgresColumnType annotation to a TablePropertyType. */
function mapType(fieldSchema: TSchema): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;

  const pgType = fieldSchema[X_SCRATCH_CONNECTOR_DATA_TYPE] as PostgresColumnType | undefined;
  switch (pgType) {
    case PostgresColumnType.NUMERIC:
      return 'number';
    case PostgresColumnType.NUMERIC_STRING:
      // Arbitrary-precision numeric stored verbatim as a string (DEV-10777). Render as the string
      // default rather than a 'number' cell, because the grid's number cell can't hold a string
      // value. (Follow-up: a dedicated numeric-string view type could right-align while keeping the
      // precise string.)
      return undefined;
    case PostgresColumnType.BOOLEAN:
      return 'checkbox';
    case PostgresColumnType.TIMESTAMP:
      return 'date';
    case PostgresColumnType.JSONB:
      return 'object';
    case PostgresColumnType.TEXT:
      return undefined; // string is the default, no need to specify
    case PostgresColumnType.TEXT_ARRAY:
    case PostgresColumnType.NUMERIC_ARRAY:
    case PostgresColumnType.BOOLEAN_ARRAY:
      return 'object';
    default:
      return undefined;
  }
}

/** Format a snake_case column name as a human-readable column title. */
function formatColumnName(columnName: string): string {
  return columnName
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Build a TableViewCol from a column name and its TypeBox schema. */
function buildCol(fieldId: string, fieldSchema: TSchema): TableViewCol {
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;

  return {
    kind: 'col',
    path: fieldId,
    name: formatColumnName(fieldId),
    type: mapType(fieldSchema),
    readonly: isReadonly || undefined,
  };
}
