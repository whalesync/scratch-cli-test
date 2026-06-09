import type { TableView, TableViewCol } from '@spinner/shared-types';

/**
 * Expands a TableView's columns into a flat, ordered list, inlining the columns
 * of any banner groups. This is the single place that flattens `view.cols`, used
 * by both the renderer (to render and look up columns) and the diff pipeline (to
 * key fields at the same granularity the grid renders).
 */
export function flattenTableViewColumns(view: TableView): TableViewCol[] {
  return view.cols.flatMap((item) => (item.kind === 'banner-group' ? item.cols : [item]));
}

/**
 * The full dot-path a single column renders at, accounting for a selected subfield.
 *
 * Most columns render their own `path`. But a column whose value is an object can
 * declare `subfields` (e.g. WordPress `title` → `{ raw, rendered }`) and preselect
 * one via `selectedSubfield`; the grid then renders that subfield's leaf. In that
 * case the effective path is `${col.path}.${relativePath}` (e.g. `title.raw`). When
 * no subfield is selected the column renders the root object, so the effective path
 * is just `col.path`. Mirrors the renderer's own `resolveEffectivePath` so the diff
 * pipeline keys fields at the exact granularity the grid renders and edits at.
 */
export function tableViewColumnEffectivePath(col: TableViewCol): string {
  const subfields = col.subfields;
  if (col.selectedSubfield != null && subfields && subfields[col.selectedSubfield]) {
    return `${col.path}.${subfields[col.selectedSubfield].relativePath}`;
  }
  return col.path;
}

/**
 * The ordered effective column paths of a TableView (banner groups flattened,
 * selected subfields drilled).
 *
 * These paths are the granularity the grid actually renders at. For enveloped
 * connectors (Notion), the view drills each property to its value leaf — e.g.
 * `properties."Asked for Intro?".checkbox`, not the whole envelope
 * `properties."Asked for Intro?"`. For object fields with a selected subfield
 * (e.g. WordPress `title` → `title.raw`), the path drills to that subfield leaf.
 * The diff pipeline keys its changed-field and focus-column sets by these same
 * paths so review-filter auto-focus and per-cell diff highlighting line up with
 * the rendered columns. (Sourcing the diff granularity from `buildColumnDefinitions`
 * instead — which treats an enveloped property as a single envelope-level leaf —
 * is exactly what desynced them; keying by the un-drilled `col.path` instead — which
 * leaves a subfield column's whole object as one leaf — is what made a subfield
 * cell's diff render the full JSON object as its "before" value.)
 */
export function tableViewColumnPaths(view: TableView): string[] {
  return flattenTableViewColumns(view).map(tableViewColumnEffectivePath);
}
