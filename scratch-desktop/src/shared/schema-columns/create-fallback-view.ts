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
  // `titlePath` is a lodash dot path (DEV-10092). Fall back to the legacy
  // `titleColumnRemoteId` segment array for schema.json files committed before
  // the rename (the desktop reads these straight off disk, so it must accept
  // both shapes until every workbook has re-pulled).
  let realValue: string | undefined;
  const titlePath = wrapper.titlePath;
  if (typeof titlePath === 'string' && titlePath.length > 0) {
    realValue = titlePath;
  } else {
    const legacy = wrapper.titleColumnRemoteId;
    if (Array.isArray(legacy) && legacy.length > 0 && legacy.every((s): s is string => typeof s === 'string')) {
      realValue = legacy.join('.');
    }
  }
  if (realValue !== undefined && colIds.includes(realValue)) {
    return realValue;
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
 * Creates a fallback `TableView` directly from an ordered list of `ColumnDefinition`s.
 * The first column is treated as the title column; all columns default to visible.
 *
 * Used when there is no schema wrapper to derive columns from — e.g. a table that was
 * pulled before any `schema.json` file existed. In that case the grid still needs to
 * render the record data, so columns are discovered from the data itself (see
 * `readDiffGridDataPage`'s data-derived columns) and handed here. Without this, a
 * missing schema would leave the grid with no columns and render blank pages
 * (DEV-10419).
 */
export function createFallbackTableViewFromColumnDefinitions(colDefs: ColumnDefinition[]): TableView {
  return { name: 'Generated', cols: colDefs.map(colDefToViewCol) };
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

  return createFallbackTableViewFromColumnDefinitions(ordered);
}
