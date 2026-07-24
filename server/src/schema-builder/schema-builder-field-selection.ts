import type { TSchema } from '@sinclair/typebox';
import type { TablePropertyType, TableView, TableViewCol } from '@spinner/shared-types';
import { extractSchemaFields, type SchemaField } from 'src/utils/schema-helpers';

/**
 * View-driven column selection for create-schema plan generation (DEV-10378).
 *
 * Walking the raw JSON schema with `extractSchemaFields` and naming each leaf by
 * its last path segment produces garbage for connectors whose records nest deep
 * value objects that share key names: a Notion page's `created_by` /
 * `last_edited_by` are `{ object, id }` value objects, so a flattener that
 * recurses into an un-annotated one emits several columns all named `object` and
 * several named `id`, and the destination connector rejects the duplicate names.
 * (DEV-10412 since marks those two fields `x-scratch-readonly`, so the flattener
 * keeps them whole — but the hazard stands for any un-annotated nested object.)
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
 * Each visible column becomes one proposed field — the view is the source of
 * truth for *what* fields to propose. We then join each column back to the schema
 * for metadata the column can't carry (foreign-key target, read-only, type,
 * description).
 *
 * A column may drill BELOW the schema field that owns its metadata (Notion's
 * `properties.Owners.relation` sits under the `properties.Owners` envelope that
 * carries the FK; its title column `properties.Name.title` sits under the
 * `properties.Name` envelope that is the title path). For those we re-anchor the
 * column onto the ancestor so the FK is recovered and the derived path matches the
 * title/id designation. But we re-anchor ONLY onto an ancestor that actually owns
 * such metadata — a foreign key, or the title/id path. A structural container that
 * owns none of these (e.g. HubSpot's read-only `associations` bag, which the
 * flattener exposes as a single leaf) is NOT a merge target: each column under it
 * keeps its own identity, so distinct sibling columns ("Associated Companies",
 * "Associated Contacts", …) stay distinct instead of collapsing into one.
 */
export function selectPlanFieldsFromTableView(args: {
  schema: TSchema;
  view: TableView;
  /** Dot-path of the table's title column; a drilled title column re-anchors here. */
  titlePath?: string;
  /** Dot-path of the table's id column; a drilled id column re-anchors here. */
  idPath?: string;
}): PlanFieldSelection {
  const pathToSchemaField = new Map<string, SchemaField>();
  for (const schemaField of extractSchemaFields(args.schema)) {
    pathToSchemaField.set(schemaField.path, schemaField);
  }

  const schemaFields: SchemaField[] = [];
  const viewTypeByPath: Record<string, TablePropertyType> = {};
  const alreadySelectedBackingPaths = new Set<string>();

  for (const col of visibleColumns(args.view)) {
    // A column that renders a chosen SUBFIELD (e.g. a Shopify `{count, precision}`
    // count object the view shows as its `count`, or a `{amount, currencyCode}`
    // money object shown as its `amount`) exports THAT subfield. Map the source to
    // the subfield's leaf path with its type, so the created column is the scalar
    // the view shows and the sync copies that scalar — instead of mapping the whole
    // object and then failing an object→scalar sync transform ("Cannot convert
    // object to number"). When no subfield is selected the column renders its root,
    // so we fall through to the normal whole-column handling below.
    const selectedSubfield = col.selectedSubfield !== undefined ? col.subfields?.[col.selectedSubfield] : undefined;
    if (selectedSubfield) {
      const subfieldPath = `${col.path}.${selectedSubfield.relativePath}`;
      if (alreadySelectedBackingPaths.has(subfieldPath)) continue;
      alreadySelectedBackingPaths.add(subfieldPath);

      // The flattener usually exposes the subfield leaf (a Shopify count object is
      // read-only only on its outer envelope, so `count`/`precision` are traversed);
      // fall back to the subfield's declared type when it doesn't.
      const backingSubfield = pathToSchemaField.get(subfieldPath);
      const derivedSubfield: SchemaField = backingSubfield
        ? { ...backingSubfield, path: subfieldPath }
        : { path: subfieldPath, type: selectedSubfield.type ?? 'unknown' };
      if (col.name) derivedSubfield.displayLabel = col.name;
      if (col.readonly || selectedSubfield.readonly) derivedSubfield.readonly = true;

      schemaFields.push(derivedSubfield);
      const subfieldViewType = selectedSubfield.type ?? col.type;
      if (subfieldViewType) viewTypeByPath[subfieldPath] = subfieldViewType;
      continue;
    }

    const backingField = findBackingSchemaField(col.path, pathToSchemaField, args.titlePath, args.idPath);
    const path = backingField?.path ?? col.path;

    // Dedupe by backing path — multiple columns can drill into the same envelope
    // (first column wins). Without this the destination would see duplicate names.
    if (alreadySelectedBackingPaths.has(path)) continue;
    alreadySelectedBackingPaths.add(path);

    const derivedField: SchemaField = backingField ? { ...backingField, path } : { path, type: 'unknown' };
    if (col.name) derivedField.displayLabel = col.name;
    if (col.readonly) derivedField.readonly = true;

    // The view may declare a column's FK target directly — connectors set this for
    // SYNTHESIZED link columns whose FK annotation sits BELOW the column's own path
    // (HubSpot's "Associated X", flattened from `results[].id`), where the join above
    // can't reach it. Prefer the declaration; otherwise the FK (if any) came from the
    // joined backing schema field.
    if (col.foreignKey && !derivedField.foreignKey) {
      derivedField.foreignKey = { linkedTableId: col.foreignKey.linkedTableId };
    }

    schemaFields.push(derivedField);
    // Prefer the column's explicit semantic `logicalType` over the render `type`:
    // a display-transformer column is rendered as text (`type:'string'`) but its
    // flattened value is really a number / date / boolean / url, and the created
    // destination field must be built for THAT type — not text.
    const columnLogicalType = col.logicalType ?? col.type;
    if (columnLogicalType) viewTypeByPath[path] = columnLogicalType;
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
 * Resolve a view column's path to the schema field that backs it.
 *
 * An exact match always wins — the column maps directly to a schema field. Failing
 * that, the column drills BELOW some field, and we re-anchor to an ancestor ONLY
 * when that ancestor owns metadata the plan needs: a foreign key, or the table's
 * title/id path. An ancestor that is merely a structural container (it exists in
 * the schema but carries no FK and isn't the title/id path — e.g. HubSpot's
 * `associations` bag) is NOT re-anchored onto, so the column keeps its own
 * identity. Returns undefined when nothing meaningful backs it; the caller then
 * falls back to the column's own path and type.
 */
function findBackingSchemaField(
  columnPath: string,
  pathToSchemaField: Map<string, SchemaField>,
  titlePath: string | undefined,
  idPath: string | undefined,
): SchemaField | undefined {
  const exactMatch = pathToSchemaField.get(columnPath);
  if (exactMatch) return exactMatch;

  let candidatePath = columnPath;
  while (candidatePath.includes('.')) {
    candidatePath = candidatePath.slice(0, candidatePath.lastIndexOf('.'));
    const ancestor = pathToSchemaField.get(candidatePath);
    if (ancestor && isMeaningfulReanchorTarget(candidatePath, ancestor, titlePath, idPath)) {
      return ancestor;
    }
  }
  return undefined;
}

/**
 * Whether a drilled column should re-anchor onto this ancestor schema field. True
 * only when the ancestor owns metadata the plan genuinely needs to inherit: a
 * foreign-key target (the column is a drill into a relation envelope) or the
 * table's title/id path (so primary-field / id-skip matching lines up). A plain
 * structural container owns none of these and must not absorb its children.
 */
function isMeaningfulReanchorTarget(
  ancestorPath: string,
  ancestorField: SchemaField,
  titlePath: string | undefined,
  idPath: string | undefined,
): boolean {
  return Boolean(ancestorField.foreignKey) || ancestorPath === titlePath || ancestorPath === idPath;
}
