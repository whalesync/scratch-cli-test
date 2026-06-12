import type { TSchema } from '@sinclair/typebox';
import type { TablePropertyType, TableView, TableViewCol } from '@spinner/shared-types';
import { extractSchemaFields, type SchemaField } from 'src/utils/schema-helpers';

/**
 * View-driven column selection for create-schema plan generation (DEV-10378).
 *
 * Walking the raw JSON schema with `extractSchemaFields` and naming each leaf by
 * its last path segment produces garbage for connectors whose records nest deep
 * value objects: a Notion page has `created_by: { object, id }` and
 * `last_edited_by: { object, id }` (plain objects with no `x-scratch-*`
 * annotation), so the flattener emits several columns all named `object` and
 * several named `id`, and the destination connector rejects the duplicate names.
 *
 * There is no generic JSON-Schema signal that tells a "container to expand"
 * (Airtable `fields`, HubSpot `properties`) apart from a "value object to keep
 * whole" (`created_by`). Each connector already encodes that knowledge in its
 * curated default `TableView`: an ordered list of meaningful columns with display
 * names, `TablePropertyType` hints, `hidden` flags, and inner-value paths. This
 * helper drives the plan's column set off that view instead, joining each visible
 * column back to the schema field that carries the rich metadata (foreign keys,
 * read-only flags, descriptions) so the rest of the pipeline is unchanged.
 *
 * Connector-agnostic: it reads only the generic `TableView`/`SchemaField`
 * contracts and never branches on a service.
 */

export interface PlanFieldSelection {
  /** Derived fields — one per visible view column — for the plan generator. */
  schemaFields: SchemaField[];
  /** `TablePropertyType` display hint per derived field path (from the view). */
  viewTypeByPath: Record<string, TablePropertyType>;
}

/**
 * Select the plan's source fields from a connector's curated default view,
 * enriched with metadata from the JSON schema.
 *
 * For each visible column we find its **backing** schema field: an exact
 * `col.path` match, else the deepest existing ancestor path. This re-anchors a
 * drilled column path (e.g. Notion's `properties.Owners.relation`) back to the
 * envelope field (`properties.Owners`) that actually carries the foreign-key /
 * read-only annotations. The backing field's `path` becomes the derived field's
 * path so the existing primary-field and id-field matching (which compares
 * against the title/id column paths) keeps working untouched.
 */
export function selectPlanFieldsFromTableView(args: { schema: TSchema; view: TableView }): PlanFieldSelection {
  const pathToSchemaField = new Map<string, SchemaField>();
  for (const schemaField of extractSchemaFields(args.schema)) {
    pathToSchemaField.set(schemaField.path, schemaField);
  }

  const schemaFields: SchemaField[] = [];
  const viewTypeByPath: Record<string, TablePropertyType> = {};
  const alreadySelectedBackingPaths = new Set<string>();

  for (const col of visibleColumns(args.view)) {
    const backingField = findBackingSchemaField(col.path, pathToSchemaField);
    const path = backingField?.path ?? col.path;

    // Dedupe by backing path — multiple columns can drill into the same envelope
    // (first column wins). Without this the destination would see duplicate names.
    if (alreadySelectedBackingPaths.has(path)) continue;
    alreadySelectedBackingPaths.add(path);

    const derivedField: SchemaField = backingField ? { ...backingField, path } : { path, type: 'unknown' };
    if (col.name) derivedField.displayLabel = col.name;
    if (col.readonly) derivedField.readonly = true;

    schemaFields.push(derivedField);
    if (col.type) viewTypeByPath[path] = col.type;
  }

  return { schemaFields, viewTypeByPath };
}

/**
 * Flatten a view's columns into the visible leaf columns, expanding banner
 * groups (Webflow groups SEO/OpenGraph fields under a banner). Hidden columns
 * and hidden groups are dropped — for Notion this is what removes the always-
 * `'page'` `object`, the constant `parent`, and the legacy `archived` flags.
 */
function visibleColumns(view: TableView): TableViewCol[] {
  const cols: TableViewCol[] = [];
  for (const entry of view.cols) {
    if (entry.kind === 'banner-group') {
      if (entry.hidden) continue;
      for (const groupedCol of entry.cols) {
        if (!groupedCol.hidden) cols.push(groupedCol);
      }
      continue;
    }
    if (!entry.hidden) cols.push(entry);
  }
  return cols;
}

/**
 * Resolve a view column's path to the schema field that backs it: exact match
 * first, then the deepest ancestor path that exists in the schema. Returns
 * undefined when nothing in the schema corresponds (e.g. a purely derived
 * column) — the caller then falls back to the column's own path and type.
 */
function findBackingSchemaField(
  columnPath: string,
  pathToSchemaField: Map<string, SchemaField>,
): SchemaField | undefined {
  let candidatePath = columnPath;
  while (candidatePath.length > 0) {
    const match = pathToSchemaField.get(candidatePath);
    if (match) return match;
    const lastDotIndex = candidatePath.lastIndexOf('.');
    if (lastDotIndex === -1) break;
    candidatePath = candidatePath.slice(0, lastDotIndex);
  }
  return undefined;
}
