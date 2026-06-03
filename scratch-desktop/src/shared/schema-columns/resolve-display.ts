import type { TableViewCol } from '@spinner/shared-types';
import { applyDisplayTransformer } from '@spinner/shared-types/transform';
import { formatCellForGrid } from './format-cell';

/**
 * Compute a cell's DISPLAY string from its raw value and the column's view
 * definition.
 *
 * If the column declares a `displayTransformer` (set by the server/connector,
 * e.g. flatten a Notion rich-text span array to plain_text) it runs through the
 * generic, fail-closed applier in `@spinner/shared-types/transform`. On success
 * the transformed string is shown; on `{ok:false}` — or when there is no
 * transformer — it falls back to the generic stringifier (raw JSON for
 * objects/arrays).
 *
 * This is the ONLY connector-agnostic seam: the renderer never inspects a
 * connector's value shape, it just runs whatever transformer the view carries.
 *
 * Display-only. Callers MUST keep the edit/copy/persisted value on the raw
 * value — never feed this result back into `data`, `copyData`, or an accept.
 */
export function resolveDisplayString(
  value: unknown,
  viewCol: Pick<TableViewCol, 'displayTransformer'> | undefined,
): string {
  const transformer = viewCol?.displayTransformer;
  if (transformer) {
    const result = applyDisplayTransformer(transformer, value);
    if (result.ok) return result.value;
  }
  return formatCellForGrid(value);
}
