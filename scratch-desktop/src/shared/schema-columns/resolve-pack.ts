import type { TableViewCol } from '@spinner/shared-types';
import { applyClientSafeTransformer } from '@spinner/shared-types/transform';

/**
 * Result of packing an edited cell's text back into its native value. FAIL-CLOSED:
 * `{ ok: false }` means "this column has no codec, or the pack failed" — the caller
 * falls back to the ordinary text→leaf coercion, or (for a codec column) refuses
 * the write rather than persist a malformed shape.
 */
export type PackedEdit = { ok: true; value: unknown } | { ok: false };

/**
 * Pack an edited cell's TEXT back into the column's NATIVE value using the
 * column's `codec.fromCore` (CoreValue → native). This is the write-side inverse of
 * {@link resolveDisplayString}: display flattens the native value to a string; this
 * reconstructs the native value from the edited string.
 *
 * The canonical case is an editable foreign-key ARRAY column (e.g. HubSpot's
 * "Associated Companies", whose native value is `[{ id, type }, …]`, displayed as a
 * comma-joined id list). The edited "id1, id2" text is split into the CoreValue id
 * list and the codec's `fromCore` (`map_array` → `wrap_object { id: "$value" }`)
 * packs it back into `[{ id }, …]` — WITHOUT reshaping the on-disk data
 * (Connector Prime Directive): the record keeps storing the raw `results` array.
 *
 * Connector-agnostic: the renderer inspects no connector value shape, it just runs
 * whatever `fromCore` the server put on the column. Returns `{ ok: false }` when the
 * column carries no codec (caller uses default coercion) or the pack fails closed.
 */
export function packEditedCellValue(viewCol: TableViewCol | undefined, editedText: string): PackedEdit {
  const fromCore = viewCol?.codec?.fromCore;
  if (!fromCore) return { ok: false };

  const coreValue = editedTextToCoreValue(viewCol, editedText);
  const packed = applyClientSafeTransformer(fromCore, coreValue);
  return packed.ok ? { ok: true, value: packed.value } : { ok: false };
}

/**
 * Turn the edited cell text into the neutral CoreValue the codec's `fromCore`
 * expects — the inverse of how the column's display flattened it.
 *
 * A MULTI-value column (its `fromCore` maps over an array) edits as a delimited
 * list: split on the display's join delimiter, trim, and drop empties, so an empty
 * cell clears the list (`[]`). A single-value column takes the text as its scalar
 * CoreValue, with an empty cell clearing to `null`.
 */
function editedTextToCoreValue(viewCol: TableViewCol, text: string): unknown {
  if (viewCol.codec?.fromCore?.type === 'map_array') {
    return text
      .split(displayJoinDelimiter(viewCol))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return text.trim() === '' ? null : text;
}

/**
 * The delimiter to split an edited multi-value cell on — the inverse of the
 * column's display join. `join_space` splits on runs of whitespace; everything
 * else (the default, `join_comma`) splits on commas.
 */
function displayJoinDelimiter(viewCol: TableViewCol): RegExp {
  const transformer = viewCol.displayTransformer;
  if (transformer?.type === 'jsonpath' && transformer.options.arrayHandling === 'join_space') {
    return /\s+/;
  }
  return /,/;
}
