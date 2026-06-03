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
 * The ordered column paths of a TableView (banner groups flattened).
 *
 * These paths are the granularity the grid actually renders at. For enveloped
 * connectors (Notion), the view drills each property to its value leaf — e.g.
 * `properties."Asked for Intro?".checkbox`, not the whole envelope
 * `properties."Asked for Intro?"`. The diff pipeline keys its changed-field and
 * focus-column sets by these same paths so review-filter auto-focus and per-cell
 * diff highlighting line up with the rendered columns. (Sourcing the diff
 * granularity from `buildColumnDefinitions` instead — which treats an enveloped
 * property as a single envelope-level leaf — is exactly what desynced them.)
 */
export function tableViewColumnPaths(view: TableView): string[] {
  return flattenTableViewColumns(view).map((col) => col.path);
}
