import type { TablePropertyType, TableView, TableViewCol } from '@spinner/shared-types';
import { buildColumnDefinitions } from './build-column-definitions';
import type { ColumnDataType, ColumnDefinition } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapDataTypeToPropertyType(dataType: ColumnDataType, format?: string): TablePropertyType | undefined {
  switch (dataType) {
    case 'string': {
      const f = format?.toLowerCase();
      if (f === 'date-time' || f === 'date') return 'date';
      if (f === 'uri' || f === 'url') return 'url';
      return 'string';
    }
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'object':
      return 'object';
    case 'array':
    case 'unknown':
      return undefined;
  }
}

function resolveTitleColumnId(wrapper: Record<string, unknown>, colIds: string[]): string | null {
  const raw = wrapper.titleColumnRemoteId;
  if (Array.isArray(raw) && raw.length > 0 && raw.every((s): s is string => typeof s === 'string')) {
    const realValue = raw.join('.');
    if (colIds.includes(realValue)) {
      return realValue;
    }
  }
  return colIds[0] ?? null;
}

function colDefToViewCol(colDef: ColumnDefinition): TableViewCol {
  return {
    kind: 'col',
    name: colDef.displayName,
    path: colDef.id,
    type: mapDataTypeToPropertyType(colDef.dataType, colDef.format),
    readonly: colDef.attributes.readOnly || undefined,
    writeOnce: colDef.attributes.writeOnce || undefined,
    hidden: false,
  };
}

/**
 * Creates a fallback `TableView` from a schema wrapper when no `views/default.json` exists on disk.
 * Uses `buildColumnDefinitions()` to derive column metadata, then maps each definition to a `TableViewCol`.
 * Title column is placed first; all columns default to visible.
 */
export function createFallbackTableView(schemaWrapper: Record<string, unknown>): TableView {
  if (!isPlainObject(schemaWrapper)) {
    return { name: 'Generated', cols: [] };
  }

  const colDefs = buildColumnDefinitions(schemaWrapper);
  if (colDefs.length === 0) {
    return { name: 'Generated', cols: [] };
  }

  const colIds = colDefs.map((c) => c.id);
  const titleColumnId = resolveTitleColumnId(schemaWrapper, colIds);

  // Order: title first, then rest in schema order
  const ordered: ColumnDefinition[] = [];
  if (titleColumnId) {
    const titleDef = colDefs.find((c) => c.id === titleColumnId);
    if (titleDef) ordered.push(titleDef);
  }
  for (const def of colDefs) {
    if (def.id !== titleColumnId) ordered.push(def);
  }

  const cols: TableViewCol[] = ordered.map(colDefToViewCol);
  return { name: 'Generated', cols };
}
